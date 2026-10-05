/**
 * An autonomous agent that hires other models on Xorv and pays for each job in
 * AUSD on Monad.
 *
 * The brain (Kimi or Qwen) plans: it reads the live market, prices subtasks,
 * decides which model to hire for each and whether a second opinion is worth
 * paying for, then writes the answer from what it bought. The hands are the Xorv
 * MCP server — the same audited payment path Claude Code uses — so every purchase
 * is an EIP-3009 signature that funds XorvEscrow, released to the provider only
 * when the work is delivered.
 *
 * The model decides *what* to buy; it never decides *how much it may spend*.
 * The budget is enforced here, in code: a job may not be priced above what is
 * left, and spending is tallied from the payment proof the tool returns, not
 * from what the model says it did.
 */
import { formatUsd, parseUsd } from "@xorv/protocol";
import { type BrainConfig, complete, type Message, type ToolSpec } from "./llm.js";

/** What the agent can do in the world. */
export interface ToolBelt {
  tools(): Promise<ToolSpec[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface Purchase {
  prompt: string;
  adapter: string | null;
  paidUsdMicros: number;
  ok: boolean;
  /** Explorer links from the tool's payment proof: deposit, release, receipt. */
  proof: string[];
}

export interface AgentRun {
  answer: string;
  purchases: Purchase[];
  spentUsdMicros: number;
  budgetUsdMicros: number;
  steps: number;
  stoppedBecause: "answered" | "step-limit";
}

export interface AgentOptions {
  goal: string;
  budgetUsdMicros: number;
  brain: BrainConfig;
  belt: ToolBelt;
  /** Hard ceiling on model round trips. */
  maxSteps?: number;
  log?: (line: string) => void;
}

const PAID_TOOL = "xorv_run_job";

export function systemPrompt(budgetUsdMicros: number): string {
  return [
    "You are an autonomous research and engineering agent with a wallet. You can hire other AI models",
    "(Claude Code, Codex, Grok, Kimi, Qwen and more) on the Xorv network to do parts of a task. Every job",
    "is paid for on chain: AUSD on Monad, held in an escrow contract and released to the provider only when",
    "the work is delivered.",
    "",
    `Your total budget for this task is ${formatUsd(budgetUsdMicros)}. Spending is enforced by your runtime:`,
    "a purchase you cannot afford will be refused, so plan within it.",
    "",
    "How to work:",
    "1. Call xorv_list_providers first to see what is live and what each costs.",
    "2. Break the goal into the few subtasks that are worth outsourcing. Do simple reasoning yourself — free.",
    "3. Use xorv_quote before any purchase you are unsure about; then xorv_run_job, giving max_usd.",
    "4. Prefer the cheapest provider that can do the subtask well. Pay for a second, different model only",
    "   when a result is important and could be wrong (code, numbers, facts) — say why when you do.",
    "5. When you have enough, stop buying and answer. Your answer must say which provider produced which",
    "   part and what you paid in total. Do not invent results you did not buy or work out yourself.",
  ].join("\n");
}

/** "Paid $0.1000 in AUSD …" → micro-USD; null when the text carries no payment. */
export function paidFrom(text: string): number | null {
  const m = /Paid \$([0-9]+(?:\.[0-9]+)?) in /.exec(text);
  return m ? parseUsd(m[1]!) : null;
}

function linksFrom(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+\/tx\/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]);
}

export async function runAgent(options: AgentOptions): Promise<AgentRun> {
  const { goal, budgetUsdMicros, brain, belt } = options;
  const maxSteps = options.maxSteps ?? 14;
  const log = options.log ?? (() => {});
  const tools = await belt.tools();
  const messages: Message[] = [
    { role: "system", content: systemPrompt(budgetUsdMicros) },
    { role: "user", content: goal },
  ];
  const purchases: Purchase[] = [];
  let spent = 0;

  for (let step = 1; step <= maxSteps; step++) {
    const { message } = await complete(brain, messages, tools);
    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        answer: message.content?.trim() ?? "",
        purchases,
        spentUsdMicros: spent,
        budgetUsdMicros,
        steps: step,
        stoppedBecause: "answered",
      };
    }

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Your arguments were not valid JSON." });
        continue;
      }

      if (call.function.name === PAID_TOOL) {
        const left = budgetUsdMicros - spent;
        const asked = typeof args.max_usd === "number" ? parseUsd(String(args.max_usd)) : left;
        if (left <= 0) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Refused: the budget of ${formatUsd(budgetUsdMicros)} is spent. Answer with what you have.`,
          });
          log(`✖ refused a purchase: budget spent`);
          continue;
        }
        // Never let a single job be priced above what is left.
        args.max_usd = Number((Math.min(asked, left) / 1_000_000).toFixed(6));
        log(`→ hiring${args.adapter ? ` ${String(args.adapter)}` : ""} for up to ${formatUsd(Math.min(asked, left))}: ${String(args.prompt ?? "").slice(0, 90)}`);
      } else {
        log(`→ ${call.function.name}`);
      }

      const result = await belt.call(call.function.name, args);
      if (call.function.name === PAID_TOOL) {
        const paid = paidFrom(result.text) ?? 0;
        spent += paid;
        purchases.push({
          prompt: String(args.prompt ?? ""),
          adapter: typeof args.adapter === "string" ? args.adapter : null,
          paidUsdMicros: paid,
          ok: !result.isError,
          proof: linksFrom(result.text),
        });
        log(
          result.isError
            ? `  ✖ ${result.text.split("\n")[0]}`
            : `  ✔ paid ${formatUsd(paid)} · ${formatUsd(budgetUsdMicros - spent)} left`,
        );
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `${result.isError ? "ERROR: " : ""}${result.text}`.slice(0, 12_000),
      });
    }
  }

  return {
    answer: "Stopped at the step limit before writing an answer.",
    purchases,
    spentUsdMicros: spent,
    budgetUsdMicros,
    steps: maxSteps,
    stoppedBecause: "step-limit",
  };
}

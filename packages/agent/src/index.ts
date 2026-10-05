#!/usr/bin/env node
/**
 * xorv-agent — give Kimi or Qwen a goal and a budget; it hires the network.
 *
 *   MOONSHOT_API_KEY=… XORV_PAYER_KEY=0x… XORV_BROKER_URL=https://… \
 *     xorv-agent "Write and independently review a Solidity function that …" --budget 0.30
 *
 *   --brain kimi|qwen   which model plans and spends (default kimi)
 *   --budget <usd>      total the agent may spend, enforced in code (default 0.25)
 *   --json              print the run as JSON
 *
 * The payer key only ever signs EIP-3009 authorizations for AUSD (or USDC); it
 * needs no MON. Its tools are the Xorv MCP server, started as a subprocess.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { formatUsd, parseUsd } from "@xorv/protocol";
import { runAgent, type ToolBelt } from "./agent.js";
import { type Brain, brainConfig, type ToolSpec } from "./llm.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function mcpServerPath(): string {
  const override = process.env.XORV_MCP_SERVER?.trim();
  if (override) return override;
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@xorv/mcp/package.json")), "dist", "index.js");
}

/** The Xorv MCP server as the agent's tool belt. */
async function mcpBelt(budgetUsd: string): Promise<{ belt: ToolBelt; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath()],
    env: {
      ...(process.env as Record<string, string>),
      // The MCP server's own per-job ceiling, as a second fence behind the agent's budget.
      XORV_MAX_USD: budgetUsd,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "xorv-agent", version: "0.1.0" });
  await client.connect(transport);
  const belt: ToolBelt = {
    async tools(): Promise<ToolSpec[]> {
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        },
      }));
    },
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
      return {
        text: content.map((c) => c.text ?? "").join("\n"),
        isError: Boolean(res.isError),
      };
    },
  };
  return { belt, close: () => client.close() };
}

async function main(): Promise<void> {
  const goal = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  if (!goal) {
    console.error('usage: xorv-agent "<goal>" [--budget 0.25] [--brain kimi|qwen] [--json]');
    process.exit(2);
  }
  const brain = (arg("brain") ?? "kimi") as Brain;
  if (brain !== "kimi" && brain !== "qwen") throw new Error("--brain must be kimi or qwen");
  const budgetUsd = arg("budget") ?? "0.25";
  const budgetUsdMicros = parseUsd(budgetUsd);
  const json = process.argv.includes("--json");
  const log = json ? () => {} : (line: string) => console.error(line);

  const config = brainConfig(brain);
  log(`${brain} (${config.model}) is planning, with ${formatUsd(budgetUsdMicros)} to spend on the Xorv network`);
  const { belt, close } = await mcpBelt(budgetUsd);
  try {
    const run = await runAgent({ goal, budgetUsdMicros, brain: config, belt, log });
    if (json) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    console.log(`\n${run.answer}\n`);
    console.log(`── spent ${formatUsd(run.spentUsdMicros)} of ${formatUsd(run.budgetUsdMicros)} on ${run.purchases.length} job(s)`);
    for (const p of run.purchases) {
      console.log(`   ${p.ok ? "✔" : "✖"} ${formatUsd(p.paidUsdMicros)}${p.adapter ? ` ${p.adapter}` : ""}  ${p.prompt.slice(0, 70)}`);
      for (const link of p.proof) console.log(`       ${link}`);
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(`xorv-agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paidFrom, runAgent, type ToolBelt } from "../src/agent.js";
import { brainConfig, type ToolSpec } from "../src/llm.js";

/**
 * The agent loop against a real HTTP server speaking the chat-completions API.
 * Each test scripts what the "model" answers; the server records what the agent
 * sent, so we can check the budget clamp, the tally and the message threading.
 */
let server: Server;
let baseUrl: string;
let script: Array<Record<string, unknown>> = [];
const requests: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const message = script.shift() ?? { content: "done" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...message }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());
beforeEach(() => {
  requests.length = 0;
  script = [];
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** The tool belt the MCP server provides, with the payment step recorded instead of signed. */
function belt(): ToolBelt & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async tools(): Promise<ToolSpec[]> {
      return ["xorv_list_providers", "xorv_quote", "xorv_run_job"].map((name) => ({
        type: "function",
        function: { name, description: name, parameters: { type: "object", properties: {} } },
      }));
    },
    async call(name, args) {
      calls.push({ name, args });
      if (name === "xorv_list_providers") return { text: "codex $0.1000 · kimi $0.0500", isError: false };
      return {
        text: [
          "def is_palindrome(s): …",
          "---",
          "Paid $0.1000 in AUSD to node (0xabc)",
          `Escrowed: https://testnet.monadscan.com/tx/0x${"1".repeat(64)}`,
          `Released to the provider: https://testnet.monadscan.com/tx/0x${"2".repeat(64)}`,
        ].join("\n"),
        isError: false,
      };
    },
  };
}

const kimi = () => brainConfig("kimi", { MOONSHOT_API_KEY: "sk-test", XORV_AGENT_BASE_URL: baseUrl });

describe("the agent loop", () => {
  it("plans with tools, buys within its budget, and answers with what it bought", async () => {
    script = [
      { content: null, tool_calls: [call("c1", "xorv_list_providers", {})] },
      {
        content: null,
        reasoning_content: "codex is cheapest for code",
        tool_calls: [call("c2", "xorv_run_job", { prompt: "write is_palindrome", adapter: "codex", max_usd: 5 })],
      },
      { content: "Codex wrote it (paid $0.10)." },
    ];
    const b = belt();
    const run = await runAgent({ goal: "write is_palindrome", budgetUsdMicros: 250_000, brain: kimi(), belt: b });

    expect(run.stoppedBecause).toBe("answered");
    expect(run.answer).toContain("Codex");
    // The model asked for $5; the runtime capped the job at what was left.
    expect(b.calls[1]).toMatchObject({ name: "xorv_run_job", args: { max_usd: 0.25 } });
    expect(run.spentUsdMicros).toBe(100_000);
    expect(run.purchases).toHaveLength(1);
    expect(run.purchases[0]!.proof).toHaveLength(2);
    // Kimi's reasoning travels back on the next turn.
    const third = requests[2]!.messages as Array<Record<string, unknown>>;
    expect(third.some((m) => m.role === "assistant" && m.reasoning_content === "codex is cheapest for code")).toBe(true);
    // Every request offered the tools.
    expect((requests[0]!.tools as unknown[]).length).toBe(3);
  });

  it("refuses purchases once the budget is spent, without calling the tool", async () => {
    script = [
      { content: null, tool_calls: [call("a", "xorv_run_job", { prompt: "one", max_usd: 0.1 })] },
      { content: null, tool_calls: [call("b", "xorv_run_job", { prompt: "two", max_usd: 0.1 })] },
      { content: "Answered with one result." },
    ];
    const b = belt();
    const run = await runAgent({ goal: "two jobs", budgetUsdMicros: 100_000, brain: kimi(), belt: b });
    expect(b.calls.filter((c) => c.name === "xorv_run_job")).toHaveLength(1);
    expect(run.spentUsdMicros).toBe(100_000);
    const refusal = (requests[2]!.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "tool" && m.content.startsWith("Refused"),
    );
    expect(refusal).toBeTruthy();
  });

  it("stops at the step limit rather than looping forever", async () => {
    script = Array.from({ length: 5 }, (_, i) => ({ content: null, tool_calls: [call(`l${i}`, "xorv_list_providers", {})] }));
    const run = await runAgent({ goal: "loop", budgetUsdMicros: 0, brain: kimi(), belt: belt(), maxSteps: 3 });
    expect(run.stoppedBecause).toBe("step-limit");
    expect(requests).toHaveLength(3);
  });
});

describe("brains", () => {
  it("Qwen asks for thinking, and both need their own key", () => {
    expect(() => brainConfig("qwen", {})).toThrow(/DASHSCOPE_API_KEY/);
    expect(() => brainConfig("kimi", {})).toThrow(/MOONSHOT_API_KEY/);
    const q = brainConfig("qwen", { DASHSCOPE_API_KEY: "x" });
    expect(q.model).toBe("qwen3.8-max");
    expect(q.extraBody).toEqual({ enable_thinking: true });
    expect(brainConfig("kimi", { MOONSHOT_API_KEY: "x" }).baseUrl).toBe("https://api.moonshot.ai/v1");
  });

  it("reads the price paid from the payment proof", () => {
    expect(paidFrom("…\nPaid $0.1000 in AUSD to x")).toBe(100_000);
    expect(paidFrom("Job failed")).toBeNull();
  });
});

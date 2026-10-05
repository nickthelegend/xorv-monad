import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent, type ToolBelt } from "../src/agent.js";
import { brainConfig, complete } from "../src/llm.js";
import { loadConversation, serveConversation } from "./model-server.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

/** A belt that answers like the MCP server, without a chain, so the loop alone is tested. */
const belt: ToolBelt = {
  async tools() {
    return [];
  },
  async call(name) {
    if (name === "xorv_list_providers") return { text: "echo $0.0010", isError: false };
    return { text: `ok\n---\nPaid $0.0010 in AUSD to node (0xabc)\nEscrowed: https://x/tx/0x${"3".repeat(64)}`, isError: false };
  },
};

describe("the agent over each API's wire format (test-double model server)", () => {
  for (const brain of ["kimi", "qwen"] as const) {
    it(`runs ${brain}'s documented response shapes through the real HTTP client and loop`, async () => {
      const conversation = loadConversation(join(FIXTURES, `${brain}-e2e.json`));
      const server = await serveConversation(conversation);
      try {
        const env = brain === "kimi" ? { MOONSHOT_API_KEY: "test" } : { DASHSCOPE_API_KEY: "test" };
        const config = brainConfig(brain, { ...env, XORV_AGENT_BASE_URL: server.url });
        const run = await runAgent({ goal: "greet", budgetUsdMicros: 10_000, brain: config, belt });
        expect(run.stoppedBecause).toBe("answered");
        expect(run.purchases).toHaveLength(2);
        expect(run.spentUsdMicros).toBe(2_000);
        // Kimi's reasoning models need their reasoning_content handed back on the next turn.
        if (brain === "kimi") {
          const second = server.requests[1]!.messages as Array<Record<string, unknown>>;
          expect(second.some((m) => m.role === "assistant" && typeof m.reasoning_content === "string")).toBe(true);
        } else {
          expect(server.requests[0]).toMatchObject({ enable_thinking: true });
        }
      } finally {
        await server.close();
      }
    });
  }

  it("has no offline mode: without a key it names the key", () => {
    expect(() => brainConfig("kimi", {})).toThrow(/MOONSHOT_API_KEY/);
    expect(() => brainConfig("qwen", {})).toThrow(/DASHSCOPE_API_KEY/);
    expect(() => brainConfig("kimi", { XORV_AGENT_FIXTURE: "x.json" })).toThrow(/MOONSHOT_API_KEY/);
  });
});

describe("record mode", () => {
  it("keeps live responses as evidence of the run", async () => {
    const server = await serveConversation({
      brain: "kimi",
      model: "kimi-k2.6",
      responses: [{ choices: [{ message: { role: "assistant", content: "live answer" }, finish_reason: "stop" }] }],
    });
    const out = join(mkdtempSync(join(tmpdir(), "xorv-rec-")), "rec.json");
    process.env.XORV_AGENT_RECORD = out;
    try {
      const config = brainConfig("kimi", { MOONSHOT_API_KEY: "sk", XORV_AGENT_BASE_URL: server.url });
      await complete(config, [{ role: "user", content: "hi" }], []);
    } finally {
      delete process.env.XORV_AGENT_RECORD;
      await server.close();
    }
    const recorded = JSON.parse(readFileSync(out, "utf8"));
    expect(recorded).toMatchObject({ brain: "kimi", source: "recorded" });
    expect(recorded.responses[0].choices[0].message.content).toBe("live answer");
  });
});

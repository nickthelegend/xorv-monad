import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent, type ToolBelt } from "../src/agent.js";
import { brainConfig, complete, loadFixture } from "../src/llm.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

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

describe("fixture mode (no API key)", () => {
  for (const brain of ["kimi", "qwen"] as const) {
    it(`replays the ${brain} fixture through the real agent loop`, async () => {
      const path = join(FIXTURES, `${brain}-e2e.json`);
      const fixture = loadFixture(path);
      expect(fixture.source).toBe("authored"); // labelled until a real recording replaces it
      const config = brainConfig(brain, { XORV_AGENT_FIXTURE: path });
      expect(config.fixture).toBe(path);
      expect(config.model).toBe(brain === "kimi" ? "kimi-k2.6" : "qwen3.8-max");
      const run = await runAgent({ goal: "greet", budgetUsdMicros: 10_000, brain: config, belt });
      expect(run.stoppedBecause).toBe("answered");
      expect(run.purchases).toHaveLength(2);
      expect(run.spentUsdMicros).toBe(2_000);
    });
  }

  it("refuses a fixture recorded with the other brain", () => {
    expect(() => brainConfig("qwen", { XORV_AGENT_FIXTURE: join(FIXTURES, "kimi-e2e.json") })).toThrow(/recorded with kimi/);
  });
});

describe("record mode", () => {
  it("writes live responses into a replayable fixture", async () => {
    const server = createServer(async (req, res) => {
      for await (const _ of req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "live answer" }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const out = join(mkdtempSync(join(tmpdir(), "xorv-rec-")), "rec.json");
    process.env.XORV_AGENT_RECORD = out;
    try {
      const config = brainConfig("kimi", {
        MOONSHOT_API_KEY: "sk",
        XORV_AGENT_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      });
      await complete(config, [{ role: "user", content: "hi" }], []);
    } finally {
      delete process.env.XORV_AGENT_RECORD;
      server.close();
    }
    const recorded = JSON.parse(readFileSync(out, "utf8"));
    expect(recorded).toMatchObject({ brain: "kimi", source: "recorded" });
    expect(recorded.responses[0].choices[0].message.content).toBe("live answer");
  });
});

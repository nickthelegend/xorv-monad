/**
 * The Qwen Code adapter, against a fake `qwen` binary.
 *
 * The fake is a real child process (a node script), so the tests cover what
 * actually matters about a CLI adapter: the arguments it is started with, the
 * environment it gets — the Qwen key as OPENAI_API_KEY and nothing else of the
 * operator's — and how its stream-json output and exit codes become a result
 * or a clean failure. The script writes what it saw into the job directory,
 * because the scrubbed environment gives it no other way to report back.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobEvent } from "@xorv/protocol";
import { QwenCodeAdapter, qwenWallTime } from "../src/adapters/qwen-code.js";
import { resetCredentialCache } from "../src/credentials.js";

const FAKE_QWEN = String.raw`
import fs from "node:fs";
const argv = process.argv.slice(2);
// The --version probe runs in the caller's cwd, not a job directory: answer it
// before writing anything.
if (argv.includes("--version")) { console.log("0.24.6"); process.exit(0); }
fs.writeFileSync("seen.json", JSON.stringify({ argv, env: process.env }));
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ type: "system", subtype: "session_start", session_id: "s1", model: process.env.OPENAI_MODEL });
if (prompt.startsWith("exit:")) {
  out({ type: "assistant", message: { content: [{ type: "text", text: "half done" }] } });
  process.exit(Number(prompt.slice(5)));
}
if (prompt === "error") {
  out({ type: "result", subtype: "error_during_execution", is_error: true, error: { message: "model quota exhausted" } });
  process.exit(1);
}
out({ type: "assistant", message: { content: [
  { type: "thinking", thinking: "planning the file" },
  { type: "tool_use", name: "write_file", input: { file_path: "hello.py", content: "print(1)" } },
] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "Wrote hello.py" }] } });
out({ type: "result", subtype: "success", is_error: false, result: "Wrote hello.py",
      usage: { input_tokens: 10000, output_tokens: 2000 }, num_turns: 2, duration_ms: 1234 });
`;

let root: string;
let script: string;
let cwd: string;

const ENV_KEYS = ["XORV_QWEN_API_KEY", "DASHSCOPE_API_KEY", "XORV_QWEN_BASE_URL", "XORV_QWEN_MODEL", "XORV_SAFE_MODE", "OPENAI_API_KEY"];
let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-qwen-"));
  script = path.join(root, "fake-qwen.mjs");
  fs.writeFileSync(script, FAKE_QWEN);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.XORV_QWEN_API_KEY = "sk-qwen-secret";
  process.env.DASHSCOPE_API_KEY = "sk-dashscope-secret";
  process.env.OPENAI_API_KEY = "sk-operator-own-openai";
  resetCredentialCache();
  cwd = fs.mkdtempSync(path.join(root, "job-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCredentialCache();
});

// The fake runs through node, and under the "env" tier — the real adapter's
// containment is sandbox.ts's business (tested there); here it would only hide
// the fake script under bwrap's private /tmp on Linux CI.
const adapter = () => new QwenCodeAdapter({ bin: process.execPath, binArgs: [script], sandbox: "env" });

function input(prompt: string, over: Record<string, unknown> = {}) {
  const events: Array<Omit<JobEvent, "at">> = [];
  const costs: number[] = [];
  return {
    events,
    costs,
    input: {
      prompt,
      cwd,
      timeoutMs: 600_000,
      signal: new AbortController().signal,
      emit: (e: Omit<JobEvent, "at">) => events.push(e),
      onCost: (usd: number) => costs.push(usd),
      ...over,
    },
  };
}

function seen(): { argv: string[]; env: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(cwd, "seen.json"), "utf8")) as { argv: string[]; env: Record<string, string> };
}

describe("QwenCodeAdapter", () => {
  it("runs headless with stream-json and returns the final result", async () => {
    const { input: run, events, costs } = input("write hello.py");
    const result = await adapter().run(run);
    expect(result).toBe("Wrote hello.py");

    expect(events).toContainEqual({ kind: "status", text: "qwen session started" });
    expect(events).toContainEqual({ kind: "reasoning", text: "planning the file" });
    expect(events).toContainEqual({ kind: "tool_call", text: "write_file: hello.py" });
    expect(events).toContainEqual({ kind: "file_edit", text: "hello.py" });
    // Qwen Code reports tokens; 10k in + 2k out at qwen3.8-max rates = $0.032.
    expect(costs[0]).toBeCloseTo(0.032, 10);
  });

  it("starts qwen with the documented headless flags", async () => {
    await adapter().run(input("write hello.py").input);
    const { argv } = seen();
    expect(argv.slice(0, 2)).toEqual(["-p", "write hello.py"]);
    expect(argv).toEqual(expect.arrayContaining(["--auth-type", "openai", "-o", "stream-json"]));
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("yolo");
    expect(argv[argv.indexOf("--max-wall-time") + 1]).toBe("590s");
    expect(argv).not.toContain("-m");
  });

  it("hands the Qwen key over as OPENAI_* — and only that, never on argv", async () => {
    await adapter().run(input("write hello.py").input);
    const { argv, env } = seen();
    expect(env.OPENAI_API_KEY).toBe("sk-qwen-secret");
    expect(env.OPENAI_BASE_URL).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(env.OPENAI_MODEL).toBe("qwen3.8-max");
    // The operator's own variables stay behind, including their OpenAI key.
    expect(env.XORV_QWEN_API_KEY).toBeUndefined();
    expect(env.DASHSCOPE_API_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-operator-own-openai");
    expect(argv.join(" ")).not.toContain("sk-qwen-secret");
  });

  it("passes a pinned model both as -m and as OPENAI_MODEL", async () => {
    await adapter().run(input("write hello.py", { model: "qwen3.8-max-0902" }).input);
    const { argv, env } = seen();
    expect(argv[argv.indexOf("-m") + 1]).toBe("qwen3.8-max-0902");
    expect(env.OPENAI_MODEL).toBe("qwen3.8-max-0902");
  });

  it("drops to plan mode in safe mode — no writes, no shell", async () => {
    process.env.XORV_SAFE_MODE = "1";
    await adapter().run(input("write hello.py").input);
    const { argv } = seen();
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("plan");
  });

  it("treats exit 55 and 53 as a clean budget stop, not a half answer", async () => {
    await expect(adapter().run(input("exit:55").input)).rejects.toThrow(/wall-time \/ tool-call budget \(exit 55\)/);
    await expect(adapter().run(input("exit:53").input)).rejects.toThrow(/turn limit \(exit 53\)/);
  });

  it("surfaces an in-band error result", async () => {
    await expect(adapter().run(input("error").input)).rejects.toThrow(/model quota exhausted/);
  });

  it("refuses to start without a Qwen key, rather than running unauthenticated", async () => {
    delete process.env.XORV_QWEN_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    await expect(adapter().run(input("write hello.py").input)).rejects.toThrow(/XORV_QWEN_API_KEY or DASHSCOPE_API_KEY/);
    expect(fs.existsSync(path.join(cwd, "seen.json"))).toBe(false);
    expect(await adapter().available()).toBe(false);
  });

  it("is available when both the binary and a key are there", async () => {
    expect(await adapter().available()).toBe(true);
  });
});

describe("qwenWallTime", () => {
  it("leaves a margin under the job deadline so qwen stops itself first", () => {
    expect(qwenWallTime(600_000)).toBe("590s");
    expect(qwenWallTime(60_000)).toBe("54s");
    expect(qwenWallTime(5_000)).toBe("5s");
  });

  it("never asks for less than qwen's one-second minimum", () => {
    expect(qwenWallTime(200)).toBe("1s");
  });
});

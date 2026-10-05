import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KIMI, OpenAiCompatibleAdapter, QWEN } from "../src/adapters/openai-compatible.js";
import { createAdapter } from "../src/adapters/index.js";
import type { RunInput } from "../src/adapters/base.js";

/**
 * Kimi and Qwen speak OpenAI's chat-completions API. These tests run the real
 * adapter against a real HTTP server on localhost and check what goes over the
 * wire: the URL, the bearer key, the model and the endpoint's extra fields.
 */
interface Seen {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown> | null;
}
let server: Server;
let base: string;
const seen: Seen[] = [];

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return void res.end(JSON.stringify({ data: [{ id: "kimi-k2.6" }] }));
    if (req.url?.endsWith("/chat/completions")) {
      return void res.end(JSON.stringify({ choices: [{ message: { content: "hello from the model" } }] }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());
afterEach(() => {
  seen.length = 0;
  for (const k of ["MOONSHOT_API_KEY", "XORV_KIMI_BASE_URL", "XORV_KIMI_MODEL", "DASHSCOPE_API_KEY", "XORV_QWEN_BASE_URL"]) {
    delete process.env[k];
  }
});

const runInput = (prompt: string): RunInput => ({
  prompt,
  model: null,
  cwd: "/tmp",
  timeoutMs: 10_000,
  signal: new AbortController().signal,
  emit: () => {},
});

describe("named OpenAI-compatible adapters", () => {
  it("are registered as kimi and qwen", () => {
    expect(createAdapter("kimi").kind).toBe("kimi");
    expect(createAdapter("qwen").kind).toBe("qwen");
  });

  it("Kimi is unavailable without a Moonshot key, and calls Moonshot with it", async () => {
    process.env.XORV_KIMI_BASE_URL = base;
    const kimi = new OpenAiCompatibleAdapter(KIMI);
    expect(await kimi.available()).toBe(false);
    expect(seen).toHaveLength(0); // no key: never even asks

    process.env.MOONSHOT_API_KEY = "sk-test";
    expect(await kimi.available()).toBe(true);
    const out = await kimi.run(runInput("say hello"));
    expect(out).toContain("hello from the model");
    const call = seen.find((s) => s.path.endsWith("/chat/completions"))!;
    expect(call.auth).toBe("Bearer sk-test");
    expect(call.body).toMatchObject({ model: "kimi-k2.6", messages: [{ role: "user", content: "say hello" }] });
  });

  it("Qwen sends Model Studio's thinking switch and its default model", async () => {
    process.env.XORV_QWEN_BASE_URL = base;
    process.env.DASHSCOPE_API_KEY = "ds-test";
    const qwen = new OpenAiCompatibleAdapter(QWEN);
    await qwen.run(runInput("two plus two"));
    const call = seen.find((s) => s.path.endsWith("/chat/completions"))!;
    expect(call.auth).toBe("Bearer ds-test");
    expect(call.body).toMatchObject({ model: "qwen3.8-max", enable_thinking: false });
  });

  it("a capability's pinned model wins over the default", async () => {
    process.env.XORV_KIMI_BASE_URL = base;
    process.env.MOONSHOT_API_KEY = "sk-test";
    await new OpenAiCompatibleAdapter(KIMI).run({ ...runInput("x"), model: "kimi-k3" });
    expect(seen.find((s) => s.path.endsWith("/chat/completions"))!.body).toMatchObject({ model: "kimi-k3" });
  });
});

/**
 * A tiny OpenAI-compatible server standing in for Qwen, Kimi and Hunyuan.
 *
 * The broker's three AI roles and the provider's `qwen` adapter run their
 * real code against it — the same `chatJson` / `streamChat` calls, the same
 * JSON-mode bodies and SSE parsing, the same validation and fallbacks — only
 * the model is replaced by rules, so a run needs no API keys and gives the
 * same answers every time. Each preset gets its own base URL
 * (`/<preset>/v1`) and its own expected key, so a request that reaches the
 * wrong endpoint, or carries the wrong key, fails loudly instead of passing.
 *
 * The rules:
 *  - Hunyuan screen: blocks a prompt containing {@link BLOCK_MARKER}, allows
 *    everything else.
 *  - Qwen router: runs the broker's tool loop the way the real model does —
 *    turn 1 calls list_candidates; turn 2 reads the chosen provider with
 *    erc8004_reputation (when it has an agent), recent_receipts,
 *    indexer_provider_stats and nansen_trust in parallel; turn 3 calls
 *    select_provider. It picks the "qwen" provider whenever one is listed —
 *    deliberately not the cheapest option, so the quote proves the router
 *    (not the price matcher) chose.
 *  - Kimi verifier: scores every result {@link VERIFIER_SCORE}, pass.
 *  - Streaming chat (the provider's qwen adapter): streams some reasoning,
 *    then an answer that carries {@link answerToken} — a value derived from
 *    the prompt but not present in it, which the private-job check uses to
 *    prove the plaintext result never reached the broker.
 *
 * Every call is recorded, so the run can assert who was asked what.
 */

import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export const BLOCK_MARKER = "E2E-SCREEN-BLOCK";
export const VERIFIER_SCORE = 92;

export type MockPreset = "qwen" | "kimi" | "hunyuan";
export type MockRole = "screener" | "router" | "verifier" | "adapter" | "models";

export interface MockCall {
  at: number;
  preset: MockPreset;
  role: MockRole;
  model: string | null;
  stream: boolean;
  /** The last user message (the prompt the role or adapter was given). */
  user: string;
  /** What the mock answered (JSON text, or the streamed answer). */
  answer: string;
}

/** A per-prompt value the streamed answer carries and the prompt does not. */
export function answerToken(prompt: string): string {
  return `ans-${createHash("sha256").update(`xorv-e2e:${prompt}`).digest("hex").slice(0, 20)}`;
}

export interface MockLlm {
  url: string;
  baseUrl(preset: MockPreset): string;
  keys: Record<MockPreset, string>;
  calls: MockCall[];
  close(): Promise<void>;
}

export async function startMockLlm(opts: { keys: Record<MockPreset, string> }): Promise<MockLlm> {
  const calls: MockCall[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        handle(req, res, Buffer.concat(chunks).toString("utf8"));
      } catch (err) {
        json(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
      }
    });
  });

  function handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const match = /^\/(qwen|kimi|hunyuan)\/v1\/(models|chat\/completions)$/.exec(req.url ?? "");
    if (!match) return json(res, 404, { error: { message: `no such endpoint ${req.method} ${req.url}` } });
    const preset = match[1] as MockPreset;
    const endpoint = match[2];
    if (req.headers.authorization !== `Bearer ${opts.keys[preset]}`) {
      return json(res, 401, { error: { message: `wrong or missing API key for ${preset}`, code: "invalid_api_key" } });
    }

    if (endpoint === "models") {
      calls.push({ at: Date.now(), preset, role: "models", model: null, stream: false, user: "", answer: "" });
      return json(res, 200, { object: "list", data: [{ id: `${preset}-mock`, object: "model" }] });
    }

    const body = JSON.parse(raw || "{}") as {
      model?: string;
      stream?: boolean;
      messages?: Array<{ role: string; content: string | null }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const messages = body.messages ?? [];
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const model = body.model ?? `${preset}-mock`;

    if (body.stream) return streamAnswer(res, preset, model, user);

    let role: MockRole;
    let answer: Record<string, unknown>;
    if (system.includes("safety screen")) {
      role = "screener";
      answer = user.includes(BLOCK_MARKER)
        ? { verdict: "block", category: "credential_exfiltration", reason: "asks the agent to read and send out the provider's keys" }
        : { verdict: "allow", category: "none", reason: "an ordinary task with no effect on the provider's machine" };
    } else if (system.includes("job router")) {
      // The buyer's prompt is the router's first user message; later ones are the broker's nudges.
      const prompt = messages.find((m) => m.role === "user")?.content ?? "";
      return routerTurn(res, preset, model, prompt, messages, (body.tools ?? []).map((t) => t.function?.name ?? ""));
    } else if (system.includes("result verifier")) {
      role = "verifier";
      answer = { score: VERIFIER_SCORE, pass: true, rationale: "The result answers the prompt directly and completely.", flags: [] };
    } else {
      return json(res, 400, { error: { message: "the mock does not recognise this role's system prompt" } });
    }
    const text = JSON.stringify(answer);
    calls.push({ at: Date.now(), preset, role, model, stream: false, user, answer: text });
    json(res, 200, {
      id: `chatcmpl-e2e-${calls.length}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: 40, total_tokens: 0 },
    });
  }

  /**
   * One turn of the router's tool loop: list, look, select — the tool calls
   * go back as an OpenAI `tool_calls` message, like Qwen's.
   */
  function routerTurn(
    res: http.ServerResponse,
    preset: MockPreset,
    model: string,
    user: string,
    messages: Array<{ role: string; content: string | null }>,
    offered: string[],
  ): void {
    const results = messages.filter((m) => m.role === "tool");
    let n = 0;
    const call = (name: string, args: Record<string, unknown>) => ({
      id: `call_e2e_${calls.length}_${n++}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    let toolCalls: Array<ReturnType<typeof call>>;
    if (results.length === 0 && offered.includes("list_candidates")) {
      toolCalls = [call("list_candidates", {})];
    } else {
      let rows: Array<{ providerId: string; adapter: string; agentId: string | null }> = [];
      try {
        rows = (JSON.parse(results[0]?.content ?? "{}") as { candidates?: typeof rows }).candidates ?? [];
      } catch {
        rows = [];
      }
      const pick = rows.find((r) => r.adapter === "qwen") ?? rows[0];
      if (results.length === 1 && pick && offered.includes("recent_receipts")) {
        toolCalls = [
          ...(pick.agentId ? [call("erc8004_reputation", { agentId: pick.agentId })] : []),
          call("recent_receipts", { providerId: pick.providerId }),
          call("indexer_provider_stats", { providerId: pick.providerId }),
          call("nansen_trust", { providerId: pick.providerId }),
        ];
      } else {
        toolCalls = [
          call("select_provider", {
            providerId: pick?.providerId ?? "none",
            reason: `${pick?.adapter ?? "this provider"} answers a self-contained question in one pass`,
            difficulty: "easy",
          }),
        ];
      }
    }
    const answer = JSON.stringify(toolCalls.map((c) => ({ name: c.function.name, args: JSON.parse(c.function.arguments) })));
    calls.push({ at: Date.now(), preset, role: "router", model, stream: false, user, answer });
    json(res, 200, {
      id: `chatcmpl-e2e-${calls.length}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, reasoning_content: "Weighing the live candidates.", tool_calls: toolCalls },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: Math.ceil(user.length / 4) + 200, completion_tokens: 30, total_tokens: 0 },
    });
  }

  function streamAnswer(res: http.ServerResponse, preset: MockPreset, model: string, prompt: string): void {
    const answer = `Here is the answer from the e2e mock model.\nanswer-token: ${answerToken(prompt)}\n(prompt was ${prompt.length} characters)`;
    calls.push({ at: Date.now(), preset, role: "adapter", model, stream: true, user: prompt, answer });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ id: "chatcmpl-e2e-stream", object: "chat.completion.chunk", model, choices: [{ index: 0, delta }], ...extra })}\r\n\r\n`;
    const frames = [
      chunk({ role: "assistant", reasoning_content: "Reading the prompt. " }),
      chunk({ reasoning_content: "Composing a short answer." }),
      ...answer.match(/.{1,24}/gs)!.map((piece) => chunk({ content: piece })),
      `data: ${JSON.stringify({ id: "chatcmpl-e2e-stream", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 } })}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ];
    // A few frames per write, so the client's SSE reader sees events split across network chunks.
    let i = 0;
    const pump = () => {
      if (i >= frames.length) return void res.end();
      res.write(frames.slice(i, i + 3).join(""));
      i += 3;
      setTimeout(pump, 15);
    };
    pump();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    baseUrl: (preset) => `${url}/${preset}/v1`,
    keys: opts.keys,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

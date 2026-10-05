/**
 * A test double for Kimi's and Qwen's OpenAI-compatible APIs: answers
 * `POST /v1/chat/completions` with a conversation's responses, in order.
 *
 * Test infrastructure only. The agent itself has no offline mode; pointing
 * `XORV_AGENT_BASE_URL` here exercises its real HTTP client, tool loop and
 * budget against known model output. Responses are the APIs' documented
 * shapes (Kimi's `reasoning_content`, Qwen's call ids), in test/fixtures.
 *
 *   node --experimental-strip-types test/model-server.ts test/fixtures/kimi-e2e.json
 *     → prints "listening <port>"
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Conversation {
  brain: "kimi" | "qwen";
  model: string;
  responses: Array<Record<string, unknown>>;
}

export function loadConversation(path: string): Conversation {
  const c = JSON.parse(readFileSync(path, "utf8")) as Conversation;
  if (!Array.isArray(c.responses) || c.responses.length === 0) throw new Error(`${path} has no responses`);
  return c;
}

/** Serve `conversation`; resolves once listening. `requests` collects what the agent sent. */
export async function serveConversation(conversation: Conversation, port = 0) {
  let next = 0;
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
      return;
    }
    requests.push(JSON.parse(body) as Record<string, unknown>);
    const answer = conversation.responses[next++];
    if (!answer) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: `conversation ran out after ${next - 1} responses` } }));
      return;
    }
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// Run directly (the e2e script's agent stage): serve one file until killed.
if (process.argv[1]?.endsWith("model-server.ts")) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: model-server.ts <conversation.json> [port]");
  const { url } = await serveConversation(loadConversation(file), Number(process.argv[3] ?? 0));
  console.log(`listening ${url}`);
}

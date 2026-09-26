import { describe, expect, it } from "vitest";
import { readSse, type SseFrame } from "../src/lib/sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of readSse(streamOf(chunks))) frames.push(frame);
  return frames;
}

describe("readSse", () => {
  it("parses named events and skips keepalive comments", async () => {
    const frames = await collect(['event: snapshot\ndata: {"a":1}\n\n', ": keepalive\n\n", 'event: done\ndata: {"b":2}\n\n']);
    expect(frames).toEqual([
      { event: "snapshot", data: '{"a":1}' },
      { event: "done", data: '{"b":2}' },
    ]);
  });

  it("joins multi-line data and defaults the event name", async () => {
    expect(await collect(["data: one\ndata: two\n\n"])).toEqual([{ event: "message", data: "one\ntwo" }]);
  });

  it("handles CRLF, including a CRLF split across reads", async () => {
    const frames = await collect(["event: job\r", "\ndata: x\r\n\r", "\n", "event: done\rdata: y\r\r"]);
    expect(frames).toEqual([
      { event: "job", data: "x" },
      { event: "done", data: "y" },
    ]);
  });

  it("delivers a final frame that has no trailing blank line", async () => {
    expect(await collect(["event: done\ndata: last"])).toEqual([{ event: "done", data: "last" }]);
  });

  it("reassembles frames split mid-field", async () => {
    expect(await collect(["ev", "ent: event\nda", 'ta: {"k":"', 'v"}\n', "\n"])).toEqual([{ event: "event", data: '{"k":"v"}' }]);
  });
});

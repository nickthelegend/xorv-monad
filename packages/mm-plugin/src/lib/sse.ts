/**
 * A minimal server-sent-events reader for the broker's job stream.
 *
 * The broker writes `event: <name>\ndata: <json>\n\n` frames plus `: keepalive`
 * comments every 15 s. Node's fetch hands back a byte stream, so this splits
 * it into frames without pulling in an EventSource polyfill (a plugin runs
 * inside `mm`'s process, where every dependency is one more thing to load).
 * CRLF and bare-CR line endings are accepted, as the SSE spec requires.
 */

export interface SseFrame {
  /** The `event:` field; "message" when the frame names none. */
  event: string;
  /** Every `data:` line of the frame, joined with "\n". */
  data: string;
}

/** Incremental frame parser: feed it normalised lines, collect finished frames. */
class FrameParser {
  private event = "";
  private data: string[] = [];

  line(line: string): SseFrame | null {
    if (line === "") {
      // Blank line: dispatch the frame, if it carried any data.
      const frame = this.data.length > 0 ? { event: this.event || "message", data: this.data.join("\n") } : null;
      this.event = "";
      this.data = [];
      return frame;
    }
    if (line.startsWith(":")) return null; // comment / keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let text = colon === -1 ? "" : line.slice(colon + 1);
    if (text.startsWith(" ")) text = text.slice(1);
    if (field === "event") this.event = text;
    else if (field === "data") this.data.push(text);
    // `id` and `retry` are irrelevant to a one-shot reader.
    return null;
  }
}

export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new FrameParser();
  let buffer = "";

  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      // At the end, flush: a stream that stops without a trailing blank line
      // still delivers its last frame.
      buffer = done ? `${buffer}\n\n` : buffer + decoder.decode(value, { stream: true });

      // Normalise line endings, then consume whole lines only. A CR at the very
      // end is held back: it may be the first half of a CRLF split across reads.
      const heldCr = !done && buffer.endsWith("\r");
      buffer = (heldCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n") + (heldCr ? "\r" : "");

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const frame = parser.line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame) yield frame;
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

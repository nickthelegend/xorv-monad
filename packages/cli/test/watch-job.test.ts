/**
 * Following a job when the stream gives out.
 *
 * Run against a real HTTP server rather than a mocked fetch, because the
 * failure this pins is a real one: the connection to the broker's event stream
 * was cut while the job was still running, and `xorv run --json` exited
 * without printing a result. The job is the broker's to finish; the command has
 * to keep asking until it does.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { watchJob } from "../src/commands/run.js";

let server: http.Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A broker whose stream sends one running snapshot and then drops or ends, while polling reports `verdict` after `pollsBeforeVerdict` asks. */
async function broker(opts: {
  streamEnd: "destroy" | "end";
  verdict: { status: string; result?: string; error?: string };
  pollsBeforeVerdict: number;
}): Promise<{ url: string; polls: () => number }> {
  let polls = 0;
  server = http.createServer((req, res) => {
    if (req.url === "/api/jobs/job_cut/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ status: "running" })}\n\n`);
      setTimeout(() => (opts.streamEnd === "destroy" ? res.destroy() : res.end()), 50);
      return;
    }
    if (req.url === "/api/jobs/job_cut") {
      polls += 1;
      const job = polls > opts.pollsBeforeVerdict ? opts.verdict : { status: "running" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, polls: () => polls };
}

describe("watchJob when the stream gives out mid-job", () => {
  it("returns the broker's verdict after the connection is cut", async () => {
    const b = await broker({
      streamEnd: "destroy",
      verdict: { status: "failed", error: "provider disconnected mid-job" },
      pollsBeforeVerdict: 2,
    });
    const job = await watchJob(b.url, "job_cut", true, 20);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("provider disconnected mid-job");
    expect(b.polls()).toBe(3);
  });

  it("returns the verdict when the stream ends cleanly without one", async () => {
    const b = await broker({
      streamEnd: "end",
      verdict: { status: "completed", result: "the answer" },
      pollsBeforeVerdict: 1,
    });
    const job = await watchJob(b.url, "job_cut", true, 20);
    expect(job?.status).toBe("completed");
    expect(job?.result).toBe("the answer");
  });

  it("keeps asking through a broker that is briefly unreachable", async () => {
    const b = await broker({ streamEnd: "destroy", verdict: { status: "completed", result: "x" }, pollsBeforeVerdict: 0 });
    // Point at a port nothing listens on first: the stream fetch itself throws.
    const dead = "http://127.0.0.1:9";
    const job = await Promise.race([
      watchJob(dead, "job_cut", true, 20).then(() => "gave up"),
      new Promise((resolve) => setTimeout(() => resolve("still asking"), 300)),
    ]);
    expect(job).toBe("still asking");
    expect(b.polls()).toBe(0);
  });
});

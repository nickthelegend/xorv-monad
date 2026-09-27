/**
 * The frames a node sends are untrusted: registration is open, so any caller
 * can hold a control socket. A frame that is not a well-formed message must be
 * dropped, never handed to the handlers, where a `null` or a field of the
 * wrong type used to throw inside the ws listener and exit the broker.
 */

import { describe, expect, it } from "vitest";
import { parseUpMessage } from "../src/hub.js";

describe("parseUpMessage", () => {
  it("drops frames that are not message objects", () => {
    for (const raw of ["null", "[]", "42", '"job.result"', "true", "not json", "{}", '{"type":7}', '{"type":"nope"}']) {
      expect(parseUpMessage(raw), raw).toBeNull();
    }
  });

  it("drops messages whose fields have the wrong types", () => {
    const bad = [
      { type: "job.event", jobId: "job_1", event: null },
      { type: "job.event", jobId: "job_1", event: [] },
      { type: "job.event", jobId: "job_1", event: { kind: "message" } },
      { type: "job.event", jobId: "job_1", event: { kind: "shell", text: "x" } },
      { type: "job.event", jobId: 5, event: { kind: "message", text: "x" } },
      { type: "job.result", jobId: "job_1", result: { nested: true }, durationMs: 1 },
      { type: "job.result", jobId: "job_1", result: "ok", durationMs: "fast" },
      { type: "job.result", jobId: "job_1", result: "ok", durationMs: Number.NaN },
      { type: "job.error", jobId: "job_1", error: null, durationMs: 1 },
      { type: "job.accepted", jobId: null },
      { type: "job.accepted", jobId: "" },
    ];
    for (const message of bad) expect(parseUpMessage(JSON.stringify(message)), JSON.stringify(message)).toBeNull();
  });

  it("passes well-formed messages through, keeping only their known fields", () => {
    expect(parseUpMessage(JSON.stringify({ type: "ping", at: 5 }))).toEqual({ type: "ping", at: 5 });
    expect(parseUpMessage(JSON.stringify({ type: "job.accepted", jobId: "job_1", extra: 1 }))).toEqual({
      type: "job.accepted",
      jobId: "job_1",
    });
    expect(
      parseUpMessage(JSON.stringify({ type: "job.event", jobId: "job_1", event: { kind: "message", text: "hi", junk: 1 } })),
    ).toEqual({ type: "job.event", jobId: "job_1", event: { at: 0, kind: "message", text: "hi" } });
    expect(parseUpMessage(JSON.stringify({ type: "job.result", jobId: "job_1", result: "ok", durationMs: 12 }))).toEqual({
      type: "job.result",
      jobId: "job_1",
      result: "ok",
      durationMs: 12,
    });
    expect(parseUpMessage(JSON.stringify({ type: "job.error", jobId: "job_1", error: "boom", durationMs: -3 }))).toEqual({
      type: "job.error",
      jobId: "job_1",
      error: "boom",
      durationMs: 0,
    });
  });
});

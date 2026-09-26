/**
 * Where the node dials its control channel.
 *
 * This is a regression test for a bug that only appeared once the Docker image
 * was actually built and run. The broker advertises a WebSocket URL derived
 * from its own `publicUrl`; behind a container port map that address is wrong,
 * and the failure is silent — HTTP heartbeats keep succeeding on the URL that
 * worked, so the registry reports the node `online` while every dispatched job
 * dies with "provider disconnected before the job could start".
 */

import { describe, expect, it } from "vitest";
import { controlChannelUrl } from "../src/commands/start.js";

const TOKEN = "ws://localhost:8402/ws/provider?token=abc123";

describe("controlChannelUrl", () => {
  it("rewrites the host to the one that actually reached the broker", () => {
    // The exact container case: broker publishes 8402 internally, reachable on
    // host port 8500. Trusting the advertisement dials a port that isn't there.
    expect(controlChannelUrl("http://localhost:8500", TOKEN)).toBe(
      "ws://localhost:8500/ws/provider?token=abc123",
    );
  });

  it("keeps the token — only the broker knows it", () => {
    expect(controlChannelUrl("http://localhost:8500", TOKEN)).toContain("token=abc123");
  });

  it("keeps the path — only the broker knows that too", () => {
    expect(controlChannelUrl("http://example.test", TOKEN)).toContain("/ws/provider");
  });

  it("upgrades to wss when the broker was reached over https", () => {
    // A tunnel or reverse proxy terminates TLS; dialing ws:// there fails.
    expect(controlChannelUrl("https://broker.example.test", TOKEN)).toBe(
      "wss://broker.example.test/ws/provider?token=abc123",
    );
  });

  it("carries a non-default port across", () => {
    expect(controlChannelUrl("https://broker.example.test:9443", TOKEN)).toContain(
      "broker.example.test:9443",
    );
  });

  it("leaves an already-correct advertisement alone", () => {
    expect(controlChannelUrl("http://localhost:8402", TOKEN)).toBe(TOKEN);
  });

  it("falls back to the advertisement rather than throwing on junk", () => {
    // A broken advertisement is still a better guess than nothing at all.
    expect(controlChannelUrl("not a url", TOKEN)).toBe(TOKEN);
    expect(controlChannelUrl("http://localhost:8500", "also not a url")).toBe("also not a url");
  });
});

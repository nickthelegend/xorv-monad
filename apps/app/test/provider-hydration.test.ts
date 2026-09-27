import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/lib/api";
import { ProviderView } from "@/components/provider-view";

/*
 * /providers/<id> is server-rendered from `initial`, then hydrated in the
 * browser from the same `initial`. It printed "last heartbeat Ns ago" with
 * Date.now() in both places, so a second boundary between the two (heartbeats
 * are 15 s apart, the age is shown to the second) made the server text differ
 * from the client's: a hydration error on the page every ERC-8004 agent file
 * links to. The markup rendered before hydration must not depend on the clock.
 */

const HEARTBEAT = Date.parse("2026-10-13T12:00:00Z");

const provider = {
  id: "prov_1",
  label: "demo provider",
  status: "online",
  address: "0x1111111111111111111111111111111111111111",
  addressUrl: "",
  agentId: null,
  agentUrl: "",
  registryTxHash: null,
  lastHeartbeatAt: HEARTBEAT,
  stats: { jobsCompleted: 3, jobsFailed: 1, avgDurationMs: 4_000, earnedUsdcMicros: 30_000 },
  region: null,
  version: "0.2.0",
  trust: null,
  capabilities: [{ id: "cap_1", adapter: "echo", displayName: "Echo", model: null, maxConcurrency: 1, priceUsdMicros: 10_000 }],
} as unknown as Provider;

function serverHtmlAt(epochMs: number): string {
  vi.setSystemTime(epochMs);
  return renderToString(createElement(ProviderView, { id: "prov_1", initial: provider }));
}

afterEach(() => vi.useRealTimers());

describe("provider page hydration", () => {
  it("renders the same markup whatever the clock says, so hydration can't mismatch", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const early = serverHtmlAt(HEARTBEAT + 1_400); // formatAgo: "just now"
    const late = serverHtmlAt(HEARTBEAT + 9_600); // formatAgo: "10s ago"
    expect(early).toContain("last heartbeat");
    expect(late).toBe(early);
    expect(early).not.toMatch(/\d+s ago|just now/);
  });
});

/**
 * Typed access to the broker.
 *
 * The browser reads freely — providers, jobs, receipts are all public — but it
 * never signs. Paying requires a Hedera key, and a key in a browser tab is a
 * key on someone's clipboard, so the one privileged call goes through a server
 * route (see app/api/pay/route.ts).
 */

export const BROKER_URL = (
  process.env.NEXT_PUBLIC_XORV_BROKER_URL ?? "http://localhost:8402"
).replace(/\/+$/, "");

export const NETWORK = process.env.NEXT_PUBLIC_XORV_NETWORK ?? "hedera:testnet";

export interface Capability {
  id: string;
  adapter: string;
  displayName: string;
  model: string | null;
  priceUsdMicros: number;
  maxConcurrency: number;
}

export interface Provider {
  id: string;
  label: string;
  accountId: string;
  accountUrl: string;
  endpoint: string;
  status: "online" | "busy" | "offline";
  connected: boolean;
  activeJobs: number;
  capabilities: Capability[];
  lastHeartbeatAt: number;
  registeredAt: number;
  uptimeSeconds: number;
  version: string;
  region: string | null;
  stats: {
    jobsCompleted: number;
    jobsFailed: number;
    earnedUsdcMicros: number;
    earnedTinybars: number;
    avgDurationMs: number;
  };
}

export interface PaymentRecord {
  asset: "usdc" | "hbar";
  assetId: string;
  amount: string;
  network: string;
  transactionId: string;
  payer: string;
  payTo: string;
  settledAt: number;
  hashscanUrl: string;
}

export interface JobEvent {
  at: number;
  kind: "status" | "message" | "tool_call" | "file_edit" | "error" | "reasoning";
  text: string;
}

export interface Job {
  id: string;
  title: string | null;
  prompt: string;
  adapter: string | null;
  status: "quoted" | "paid" | "assigned" | "running" | "completed" | "failed" | "expired";
  createdAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  providerId: string | null;
  providerLabel: string | null;
  providerAccountId: string | null;
  priceUsdMicros: number | null;
  priceLabel: string | null;
  payment: PaymentRecord | null;
  result: string | null;
  resultHash: string | null;
  error: string | null;
  receiptConsensusAt: string | null;
  eventCount: number;
  events?: JobEvent[];
}

export interface NetworkInfo {
  network: string;
  facilitator: { mode: string; description: string; feePayer: string };
  operator: { accountId: string; url: string };
  usdc: string;
  topics: Record<string, { id: string; url: string } | null>;
  hcsPublished: { registry: number; heartbeat: number; receipts: number };
  hcsLastError: string | null;
  hbarRate: { centsPerHbar: number } | null;
  stats: {
    providersLive: number;
    providersConnected: number;
    capacity: number;
    jobsTotal: number;
    jobsCompleted: number;
    paidUsdMicros: number;
  };
  heartbeatIntervalMs: number;
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  network: () => get<NetworkInfo>("/api/network"),
  providers: () => get<{ providers: Provider[] }>("/api/providers").then((r) => r.providers),
  jobs: (limit = 25) => get<{ jobs: Job[] }>(`/api/jobs?limit=${limit}`).then((r) => r.jobs),
  job: (id: string) => get<{ job: Job }>(`/api/jobs/${id}`).then((r) => r.job),
  receipts: () =>
    get<{ topic: { id: string; url: string } | null; receipts: Array<{ consensusAt: string; sequence: number; payload: unknown }> }>(
      "/api/receipts",
    ),
};

/** micro-USD → "$0.0010". Mirrors the CLI's formatting so numbers agree. */
export function formatUsd(micros: number | null | undefined): string {
  if (micros == null) return "—";
  const dollars = micros / 1_000_000;
  if (dollars === 0) return "$0";
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

export function formatAgo(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs);
  if (delta < 2_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function hashscanAccount(accountId: string): string {
  const net = NETWORK === "hedera:mainnet" ? "mainnet" : "testnet";
  return `https://hashscan.io/${net}/account/${accountId}`;
}

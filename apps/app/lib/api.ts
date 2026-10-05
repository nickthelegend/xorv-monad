/**
 * Typed access to the broker.
 *
 * The browser reads freely — providers, jobs, receipts are all public — but it
 * never signs with a server key. A connected wallet signs in the tab (see
 * lib/pay-with-wallet.ts); the fallback for a visitor without one goes through
 * a server route holding the demo account (see app/api/pay/route.ts).
 */

export const BROKER_URL = (
  process.env.NEXT_PUBLIC_XORV_BROKER_URL ?? "http://localhost:8402"
).replace(/\/+$/, "");

export const NETWORK = process.env.NEXT_PUBLIC_XORV_NETWORK?.trim() || "eip155:10143";

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
  address: string;
  addressUrl: string;
  endpoint: string;
  status: "online" | "busy" | "offline";
  connected: boolean;
  activeJobs: number;
  capabilities: Capability[];
  /** Per capability id: false while busy, paused, or signed out. */
  available?: Record<string, boolean>;
  lastHeartbeatAt: number;
  registeredAt: number;
  uptimeSeconds: number;
  version: string;
  region: string | null;
  stats: {
    jobsCompleted: number;
    jobsFailed: number;
    earnedUsdcMicros: number;
    avgDurationMs: number;
  };
  /** The provider's record in XorvRegistry, written by the escrow as jobs settle. */
  /** Cleanverse CVI standing, when the escrow has an identity gate; null when off or not read yet. */
  identity?: { verified: boolean; checkedAt: number } | null;
  onchain?: {
    registered: boolean;
    active: boolean;
    completed: number;
    failed: number;
    earnedUnits: string;
    /** Basis points; 5000 with no history. */
    score: number;
    registeredAt: number;
    sponsorTx?: string | null;
  } | null;
}

export interface EscrowRecord {
  address: string;
  jobId: `0x${string}`;
  /** Unix seconds; after this anyone may refund the buyer. */
  deadline: number;
  state: "funded" | "released" | "refunded";
  provider: string;
  fundTx: string;
  releaseTx?: string;
  refundTx?: string;
  reassignTxs?: string[];
  resultHash?: string;
  lastError?: string;
  explorerUrl: string;
}

export interface PaymentRecord {
  /** Stablecoin symbol, e.g. "AUSD" or "USDC" (older records say "usdc"). */
  asset: string;
  assetId: string;
  amount: string;
  network: string;
  transactionHash: string;
  payer: string;
  payTo: string;
  settledAt: number;
  explorerUrl: string;
  /** "escrow": the money waits in XorvEscrow until the job delivers. Absent on old records. */
  scheme?: "escrow" | "exact";
  escrow?: EscrowRecord;
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
  providerAddress: string | null;
  priceUsdMicros: number | null;
  priceLabel: string | null;
  payment: PaymentRecord | null;
  result: string | null;
  resultHash: string | null;
  error: string | null;
  receiptTxHash: string | null;
  eventCount: number;
  events?: JobEvent[];
}

export interface NetworkInfo {
  network: string;
  facilitator: { mode: string; description: string; feePayer: string };
  operator: {
    address: string;
    url: string;
    /** Who signs the operator's transactions: a local key, a Privy server wallet, or its labelled mock. */
    signer?: {
      mode: "key" | "privy" | "privy-mock";
      description: string;
      policy: { name: string; allows: string[] } | null;
      refusals: Array<{ at: string; to: string | null; reason: string }>;
    };
  };
  /** Stablecoins the broker accepts, default (AUSD) first. */
  stablecoins?: Array<{ symbol: string; address: string; decimals: number; url: string }>;
  explorerName?: string;
  /** XorvEscrow, when jobs are paid into escrow rather than straight to the provider. */
  escrow?: {
    address: string;
    url: string;
    deadlineSeconds: number;
    /** Cleanverse CVI: when set, only A-Pass holders can fund the escrow or be paid by it. */
    identityGate?: { address: string; kind: "cleanverse"; apass: string | null; validator: string | null; pool: string | null } | null;
  } | null;
  /** XorvRegistry, the contract holding provider reputation. */
  registry?: { address: string; url: string } | null;
  log: { address: string; url: string } | null;
  logPublished: { registry: number; heartbeat: number; receipts: number };
  logLastError: string | null;
  stats: {
    providersLive: number;
    providersConnected: number;
    capacity: number;
    jobsTotal: number;
    jobsCompleted: number;
    /** Paid and released (or paid directly): what "settled" means. */
    jobsSettled: number;
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
  /**
   * Stop a running job. The job id is the capability (only its buyer has it).
   * With escrow the broker refunds the buyer; `refunded` says whether it will.
   */
  cancel: async (id: string): Promise<{ ok: boolean; refunded: boolean; error?: string }> => {
    const res = await fetch(`${BROKER_URL}/api/jobs/${id}/cancel`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; refunded?: boolean; error?: string };
    if (!res.ok) throw new Error(body.error ?? `cancel failed (${res.status})`);
    return { ok: Boolean(body.ok), refunded: Boolean(body.refunded) };
  },
  receipts: () =>
    get<{
      log: { address: string; url: string } | null;
      receipts: Array<{
        sequence: number;
        blockNumber: number;
        transactionHash: string;
        author: string;
        payload: unknown;
      }>;
    }>(
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

/**
 * Explorer links for the configured network — Monadscan, or the app's own
 * chain viewer on the local stack. Re-exported from lib/chains so every surface shows the same one.
 */
export { explorerAddress, explorerTx } from "./chains";

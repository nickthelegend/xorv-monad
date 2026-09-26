/**
 * The broker's AI roles, as the app shows them.
 *
 * Three sponsor models take a turn on every job: Hunyuan screens the prompt,
 * Qwen routes "Auto" requests, Kimi scores the result and writes it to
 * ERC-8004. The protocol's wire types carry the essentials (`by`, `model`,
 * the verdict); the broker sends a little more — a display label, the
 * router's difficulty call and whether it fell back to price, each role's
 * latency and why a role is off (`/api/network` → `aiRoles`). Those extras
 * are broker-local, so they are typed here and read defensively: an older
 * broker that doesn't send them still renders, just with less detail.
 */

import type { AiRoleInfo, JobRouting, JobScreening, NetworkInfo } from "@xorv/protocol/web";

export type AiRoleName = "screener" | "router" | "verifier";

export interface AiRoleStats {
  calls: number;
  ok: number;
  failed: number;
  timeouts: number;
  lastMs: number | null;
  avgMs: number | null;
  lastError: string | null;
}

export interface AiRoleState {
  enabled: boolean;
  provider: string;
  label: string;
  model: string;
  timeoutMs: number | null;
  /** Why the role is off; null when it is on. */
  reason: string | null;
  stats: AiRoleStats | null;
  failMode?: "open" | "closed";
  feedback?: {
    onChain: boolean;
    address: string | null;
    tag1: string;
    published: number;
    failed: number;
    lastError: string | null;
    reason: string | null;
  };
}

export type AiRolesState = Record<AiRoleName, AiRoleState>;

/** The UI names of the three presets — what the sponsors call their models. */
export const PROVIDER_LABELS: Record<string, string> = {
  qwen: "Qwen 3.8 Max",
  kimi: "Kimi K3",
  hunyuan: "Hunyuan hy4",
};

const DEFAULTS: Record<AiRoleName, { provider: string; model: string }> = {
  screener: { provider: "hunyuan", model: "hy4-preview" },
  router: { provider: "qwen", model: "qwen3.8-max" },
  verifier: { provider: "kimi", model: "kimi-k3" },
};

const ROLES: AiRoleName[] = ["screener", "router", "verifier"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** "Qwen 3.8 Max" for a role or record, from its label or its provider; null when unknown. */
export function roleLabel(role: (AiRoleInfo & { label?: unknown }) | { by?: unknown; label?: unknown } | null | undefined): string | null {
  if (!role) return null;
  if (typeof role.label === "string" && role.label) return role.label;
  return typeof role.by === "string" ? (PROVIDER_LABELS[role.by] ?? role.by) : null;
}

/**
 * Every role's state: the broker's full `aiRoles` report when it sends one,
 * otherwise derived from the protocol's `ai` (on with its model, or off).
 */
export function aiRoles(info: NetworkInfo): AiRolesState {
  const full = record((info as NetworkInfo & { aiRoles?: unknown }).aiRoles);
  const out = {} as AiRolesState;
  for (const role of ROLES) {
    const reported = record(full?.[role]);
    if (reported && typeof reported.enabled === "boolean") {
      out[role] = reported as unknown as AiRoleState;
      continue;
    }
    const on = info.ai?.[role] ?? null;
    const provider = on?.by ?? DEFAULTS[role].provider;
    out[role] = {
      enabled: on !== null,
      provider,
      label: roleLabel(on) ?? PROVIDER_LABELS[provider] ?? provider,
      model: on?.model ?? DEFAULTS[role].model,
      timeoutMs: null,
      reason: on ? null : "off",
      stats: null,
    };
  }
  return out;
}

type Routing = JobRouting & { difficulty?: string | null; fallback?: string | null };
type Screening = JobScreening & { category?: string; unavailable?: boolean };

/** One line for the quote: who routed the job, where, and why — or that it fell back to price. */
export function describeRouting(routing: Routing): string {
  const who = roleLabel(routing) ?? routing.by;
  if (routing.fallback || !routing.adapter) return `${who}: ${routing.reason}`;
  const difficulty = routing.difficulty ? ` (${routing.difficulty})` : "";
  return `Routed by ${who} to ${routing.adapter}${difficulty}: ${routing.reason}`;
}

/** One line for the quote: who screened the prompt and what they concluded. */
export function describeScreening(screening: Screening): string {
  const who = roleLabel(screening) ?? screening.by;
  if (screening.unavailable) return `${who}: ${screening.reason}`;
  const verdict = screening.verdict === "allow" ? "allowed" : "blocked";
  return `Screened by ${who}: ${verdict}${screening.reason ? ` — ${screening.reason}` : ""}`;
}

/** "1.2 s avg · 34 calls", or null before the first call. */
export function describeLatency(stats: AiRoleStats | null): string | null {
  if (!stats || stats.calls === 0) return null;
  const avg = stats.avgMs === null ? null : stats.avgMs < 1_000 ? `${stats.avgMs} ms` : `${(stats.avgMs / 1_000).toFixed(1)} s`;
  const failed = stats.failed > 0 ? ` · ${stats.failed} failed` : "";
  return `${avg ? `${avg} avg · ` : ""}${stats.calls} call${stats.calls === 1 ? "" : "s"}${failed}`;
}

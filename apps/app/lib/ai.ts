/**
 * The broker's AI roles, as the app shows them.
 *
 * Three sponsor models take a turn on every job: Hunyuan screens the prompt,
 * Qwen routes "Auto" requests (a tool-using agent that reads each
 * candidate's ERC-8004 reputation, XorvLedger receipts, Envio stats and
 * Nansen trust before it picks, and leaves a trace of every lookup), Kimi
 * scores the result and writes it to ERC-8004. The protocol's wire types carry the essentials (`by`, `model`,
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

type Routing = JobRouting & {
  difficulty?: string | null;
  fallback?: string | null;
  providerId?: string | null;
  providerLabel?: string | null;
};
type Screening = JobScreening & { category?: string; unavailable?: boolean };

/** One line for the quote: who routed the job, where, and why — or that it fell back to price. */
export function describeRouting(routing: Routing): string {
  const who = roleLabel(routing) ?? routing.by;
  if (routing.fallback || !routing.adapter) return `${who}: ${routing.reason}`;
  const difficulty = routing.difficulty ? `, ${routing.difficulty}` : "";
  // The agent router picks the provider; an older broker's router only picked the adapter.
  if (typeof routing.providerLabel === "string" && routing.providerLabel) {
    return `Routed by ${who} to ${routing.providerLabel} (${routing.adapter}${difficulty}): ${routing.reason}`;
  }
  return `Routed by ${who} to ${routing.adapter}${routing.difficulty ? ` (${routing.difficulty})` : ""}: ${routing.reason}`;
}

// ---------------------------------------------------------------------------
// The router's agent trace
// ---------------------------------------------------------------------------

/** One tool call the router made, as the app shows it. */
export interface TraceStep {
  tool: string;
  /** "ERC-8004 reputation", "XorvLedger receipts", … */
  label: string;
  /** The broker's one-line account of what the tool found. */
  summary: string;
  ms: number | null;
  ok: boolean;
  /** Explorer links (agent, receipt, wallet) — http(s) only. */
  links: Array<{ label: string; url: string }>;
}

export interface RoutingTrace {
  steps: TraceStep[];
  turns: number | null;
  toolCalls: number | null;
  ms: number | null;
  thinking: boolean | null;
  fallback: string | null;
}

/** What each of the router's tools is called in the UI. */
export const TOOL_LABELS: Record<string, string> = {
  list_candidates: "Candidates",
  erc8004_reputation: "ERC-8004 reputation",
  recent_receipts: "XorvLedger receipts",
  indexer_provider_stats: "Envio indexer",
  nansen_trust: "Nansen trust",
  select_provider: "Decision",
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Only links the browser should follow: absolute http(s) URLs. */
export function safeLink(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The router's trace from a routing record, read defensively (an older
 * broker sends none, and the record is JSON from the network): null when
 * there are no steps to show.
 */
export function routingTrace(routing: unknown): RoutingTrace | null {
  const r = record(routing);
  if (!r || !Array.isArray(r.steps) || r.steps.length === 0) return null;
  const steps: TraceStep[] = [];
  for (const raw of r.steps.slice(0, 20)) {
    const step = record(raw);
    if (!step || typeof step.tool !== "string" || typeof step.summary !== "string") continue;
    const links: TraceStep["links"] = [];
    if (Array.isArray(step.links)) {
      for (const l of step.links.slice(0, 4)) {
        const link = record(l);
        const url = safeLink(link?.url);
        if (url && typeof link?.label === "string") links.push({ label: link.label, url });
      }
    }
    steps.push({
      tool: step.tool,
      label: TOOL_LABELS[step.tool] ?? step.tool,
      summary: step.summary,
      ms: num(step.ms),
      ok: step.ok !== false,
      links,
    });
  }
  if (steps.length === 0) return null;
  return {
    steps,
    turns: num(r.turns),
    toolCalls: num(r.toolCalls),
    ms: num(r.ms),
    thinking: typeof r.thinking === "boolean" ? r.thinking : null,
    fallback: typeof r.fallback === "string" ? r.fallback : null,
  };
}

/** "120 ms" / "2.4 s". */
export function formatMs(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/** The trace's heading: "4 lookups in 3 turns · 2.4 s · thinking on". */
export function describeTrace(trace: RoutingTrace): string {
  const lookups = trace.toolCalls ?? trace.steps.filter((s) => s.tool !== "select_provider").length;
  const parts = [`${lookups} lookup${lookups === 1 ? "" : "s"}`];
  if (trace.turns !== null) parts[0] += ` in ${trace.turns} turn${trace.turns === 1 ? "" : "s"}`;
  if (trace.ms !== null) parts.push(formatMs(trace.ms));
  if (trace.thinking !== null) parts.push(trace.thinking ? "thinking on" : "thinking off");
  return parts.join(" · ");
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

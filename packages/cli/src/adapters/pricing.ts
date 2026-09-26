/**
 * What a job cost the provider, from the token usage the model reports.
 *
 * Claude Code volunteers a dollar figure; the hosted models (and Qwen Code,
 * which drives one) report tokens instead. Turning tokens into dollars is what
 * lets `xorv test` warn an operator that they are selling below cost — which is
 * otherwise invisible until the provider's bill arrives.
 *
 * Rates are the providers' published pay-as-you-go prices, USD per million
 * tokens, as of September 2026 (Qwen: Singapore region, the dearest; Kimi and
 * TokenHub: international). An unknown model — an operator override the table
 * has never heard of — reports no cost rather than a made-up one: "unknown" and
 * "free" are different answers.
 */

export interface TokenPrice {
  /** USD per million input (prompt) tokens. */
  input: number;
  /** USD per million output tokens — reasoning tokens are billed as output. */
  output: number;
}

const PRICES: Record<string, TokenPrice> = {
  "qwen3.8-max": { input: 2, output: 6 },
  "kimi-k3": { input: 3, output: 15 },
  "hy4-preview": { input: 0.834, output: 2.501 },
};

/**
 * The rate for a model id, matching dated snapshots to their family:
 * `qwen3.8-max-0902` is priced as `qwen3.8-max`. Longest prefix wins, so a
 * cheaper sibling with a longer name is never priced as its parent.
 */
export function tokenPrice(model: string): TokenPrice | null {
  const id = model.trim().toLowerCase();
  let best: string | null = null;
  for (const key of Object.keys(PRICES)) {
    if ((id === key || id.startsWith(`${key}-`)) && (!best || key.length > best.length)) best = key;
  }
  return best ? PRICES[best]! : null;
}

/** Input/output token counts, whichever dialect the usage object speaks. */
export function tokenCounts(usage: Record<string, unknown>): { input: number; output: number } | null {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // OpenAI style (Qwen, Kimi, TokenHub) or Anthropic style (Qwen Code's stream-json).
  const input = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? num(usage.promptTokens);
  const output = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? num(usage.completionTokens);
  return input === null || output === null ? null : { input, output };
}

/** USD cost of one call, or null when the model or the counts are unknown. */
export function usageCostUsd(model: string, usage: Record<string, unknown>): number | null {
  const price = tokenPrice(model);
  const counts = tokenCounts(usage);
  if (!price || !counts) return null;
  return (counts.input * price.input + counts.output * price.output) / 1_000_000;
}

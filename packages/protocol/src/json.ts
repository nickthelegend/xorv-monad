/**
 * JSON helpers for values that came off a chain.
 *
 * viem speaks bigint for every `uint256`, and `JSON.stringify` throws on a
 * bigint — so anything headed for an HTTP response goes through `toJsonSafe`
 * first. And a file whose keccak256 is committed on-chain (an ERC-8004
 * feedback file) must serialize to the *same bytes* every time, which plain
 * `JSON.stringify` only does if every producer builds its objects in the same
 * key order; `canonicalJson` removes that dependency.
 */

/** Deep-convert bigints to decimal strings so a value survives `JSON.stringify`. */
export function toJsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = toJsonSafe(item);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted at every level, no whitespace,
 * bigints as decimal strings, `undefined` members dropped.
 *
 * Hash this, serve exactly this, and the hash a reader recomputes from the
 * served bytes will match the one on-chain.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(toJsonSafe(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
    return out;
  }
  return value;
}

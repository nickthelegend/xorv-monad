/**
 * Environment access that is safe to bundle for a browser.
 *
 * The chain helpers read their overrides (`XORV_RPC_URL`, `XORV_STABLECOIN`, …)
 * from `process.env`, but the same modules ship to the Next.js apps through
 * `@xorv/protocol/web`, where `process` may be a stub or missing entirely.
 * Touching `process.env` directly would throw a ReferenceError there, so the
 * lookup goes through `globalThis` and quietly yields `undefined` instead —
 * the browser simply gets the defaults.
 *
 * Values are read on every call, never captured at module load, so a test (or
 * an operator reloading config) can change a variable without re-importing.
 *
 * @internal Not part of the public API.
 */

type EnvBag = Record<string, string | undefined>;

/** The ambient environment, or an empty bag where there is none. */
export function ambientEnv(): EnvBag {
  const proc = (globalThis as { process?: { env?: EnvBag } }).process;
  return proc?.env ?? {};
}

/** A trimmed environment variable, with empty strings treated as unset. */
export function readEnv(name: string, env: EnvBag = ambientEnv()): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

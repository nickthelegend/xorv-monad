/**
 * Chainlink Data Feeds, read by the broker.
 *
 * USDC/USD (Monad testnet) gates quoting: Xorv sells jobs in USDC as dollars,
 * so it stops quoting while USDC is off its peg. MON/USD (Monad mainnet; the
 * testnet has no MON feed) prices the facilitator's gas on the speed receipt.
 * Readings are cached for a minute: the feeds update at most every few hours,
 * and a quote should not wait on an RPC round trip it doesn't need.
 */
import {
  CHAINLINK_FEEDS,
  pegCheck,
  publicClientFor,
  readFeed,
  type FeedReading,
  type FeedSpec,
} from "@xorv/protocol";

export interface PriceFeeds {
  usdcUsd(): Promise<FeedReading | null>;
  monUsd(): Promise<FeedReading | null>;
  /** Null when quoting may go ahead; otherwise why not. */
  quoteBlocker(): Promise<string | null>;
  /** The last readings, for /api/network, without waiting on the RPC. */
  snapshot(): { usdcUsd: FeedReading | null; monUsd: FeedReading | null; lastError: string | null };
}

export const PRICE_CACHE_MS = 60_000;

export function createPriceFeeds(
  opts: { read?: (spec: FeedSpec) => Promise<FeedReading>; cacheMs?: number; log?: (line: string) => void } = {},
): PriceFeeds {
  const cacheMs = opts.cacheMs ?? PRICE_CACHE_MS;
  const read = opts.read ?? ((spec: FeedSpec) => readFeed(publicClientFor(spec.network), spec));
  const last: Record<"usdcUsd" | "monUsd", { at: number; value: FeedReading | null; pending: Promise<FeedReading | null> | null }> = {
    usdcUsd: { at: 0, value: null, pending: null },
    monUsd: { at: 0, value: null, pending: null },
  };
  let lastError: string | null = null;

  function get(key: "usdcUsd" | "monUsd"): Promise<FeedReading | null> {
    const slot = last[key];
    if (slot.value && Date.now() - slot.at < cacheMs) return Promise.resolve(slot.value);
    slot.pending ??= read(CHAINLINK_FEEDS[key])
      .then((value) => {
        slot.value = value;
        slot.at = Date.now();
        lastError = null;
        return value;
      })
      .catch((err: unknown) => {
        // An unreachable feed must not take quoting down with it: keep the last reading.
        lastError = `${CHAINLINK_FEEDS[key].pair}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
        opts.log?.(`chainlink ${lastError}`);
        return slot.value;
      })
      .finally(() => {
        slot.pending = null;
      });
    return slot.pending;
  }

  return {
    usdcUsd: () => get("usdcUsd"),
    monUsd: () => get("monUsd"),
    async quoteBlocker() {
      const reading = await get("usdcUsd");
      if (!reading) return null;
      return pegCheck(reading).reason;
    },
    snapshot: () => ({ usdcUsd: last.usdcUsd.value, monUsd: last.monUsd.value, lastError }),
  };
}

/**
 * Reading the public record back: XorvLedger feeds and the leaderboard.
 *
 * Two sources, in order of preference:
 *
 *  1. the Envio indexer (`XORV_INDEXER_URL`), which has the whole history and
 *     the derived aggregates, and answers in one request;
 *  2. a bounded backward RPC scan (protocol `readLedgerEvents`) — the public
 *     Monad RPC caps `eth_getLogs` at 100 blocks, so this only reaches the
 *     recent past, but it needs nothing but the contract address.
 *
 * Results are cached for a few seconds. The landing page polls, the network
 * page polls, and without a cache every visitor would cost the RPC a couple of
 * hundred `eth_getLogs` calls per refresh.
 */

import { readLedgerEvents, type LedgerEvent, type LedgerEventKind } from "@xorv/protocol";
import {
  indexerServes,
  readIndexerEvents,
  readIndexerLeaderboard,
  type IndexerLeaderboardRow,
  type IndexerOptions,
} from "./indexer.js";

export interface LedgerFeed {
  source: "indexer" | "rpc" | "none";
  events: LedgerEvent[];
  /** Set when the indexer was configured but failed and the RPC answered instead. */
  indexerError?: string;
}

export interface LedgerReader {
  /** Newest-first events of one kind. Throws only when every source failed. */
  events(kind: LedgerEventKind, limit: number): Promise<LedgerFeed>;
  /** Provider rows from the indexer, or null when there is no indexer to ask. */
  leaderboard(limit: number): Promise<IndexerLeaderboardRow[] | null>;
}

export interface LedgerReaderOptions {
  network: string;
  ledgerAddress: string | null;
  fromBlock: bigint | null;
  indexerUrl: string | null;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to the protocol's bounded RPC scan. */
  readRpc?: (kind: LedgerEventKind, limit: number) => Promise<LedgerEvent[]>;
  cacheMs?: number;
}

export const LEDGER_CACHE_MS = 5_000;

export function createLedgerReader(opts: LedgerReaderOptions): LedgerReader {
  const cacheMs = opts.cacheMs ?? LEDGER_CACHE_MS;
  const indexer: IndexerOptions | null = opts.indexerUrl ? { url: opts.indexerUrl, fetch: opts.fetch } : null;
  const readRpc =
    opts.readRpc ??
    ((kind: LedgerEventKind, limit: number) =>
      readLedgerEvents(opts.network, opts.ledgerAddress ?? "", { kind, limit, fromBlock: opts.fromBlock }));

  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: Date.now(), value });
    // A failure is not worth remembering: the next caller should try again.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  }

  return {
    events(kind, limit) {
      return cached(`events:${kind}:${limit}`, async (): Promise<LedgerFeed> => {
        let indexerError: string | undefined;
        if (indexer && indexerServes(kind)) {
          try {
            return { source: "indexer", events: await readIndexerEvents(indexer, kind, limit) };
          } catch (err) {
            indexerError = err instanceof Error ? err.message : String(err);
          }
        }
        if (!opts.ledgerAddress) return { source: "none", events: [], indexerError };
        const events = await readRpc(kind, limit);
        return indexerError ? { source: "rpc", events, indexerError } : { source: "rpc", events };
      });
    },
    leaderboard(limit) {
      if (!indexer) return Promise.resolve(null);
      return cached(`leaderboard:${limit}`, () => readIndexerLeaderboard(indexer, limit));
    },
  };
}

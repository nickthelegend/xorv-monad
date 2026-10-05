/** Pure helpers shared by the handlers and the tests. Kept out of src/handlers/,
 * which Envio auto-loads: importing a handler file from a test registers its
 * handlers a second time. */

/** UTC calendar day for a unix timestamp, e.g. "2026-10-05". */
export function dayOf(timestamp: number | bigint): string {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

/** The registry's score, recomputed: (completed+1)*10000/(completed+failed+2). */
export function laplaceBps(completed: bigint, failed: bigint): number {
  return Number(((completed + 1n) * 10_000n) / (completed + failed + 2n));
}

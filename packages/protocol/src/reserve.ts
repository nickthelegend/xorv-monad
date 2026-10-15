/**
 * Monad's reserve balance, for the accounts that pay Xorv's gas.
 *
 * Monad reaches consensus on state three blocks old, so it keeps every EOA's
 * last 10 MON as a reserve that pays for in-flight transactions. A
 * transaction whose value spend would leave the sender below
 * `min(10 MON, its balance)` reverts at execution, still paying gas, and the
 * gas of all in-flight transactions must fit inside that reserve. The one
 * exception, an "emptying" transaction, is allowed once per three blocks and
 * never for EIP-7702-delegated accounts.
 *
 * Xorv's buyers never hold MON (the facilitator pays their gas). The accounts
 * that do are the broker's hot wallets: the facilitator (settlements, escrow
 * writes) and the operator (ledger receipts, rating relays). They send many
 * transactions a minute, so they must stay well above the reserve, and they
 * send no value, only gas. These helpers say whether they are.
 *
 * Monad also exposes the rule on chain (`dippedIntoReserve()` at 0x1001), but
 * it answers for the current transaction inside a contract. Xorv's contracts
 * move USDC, never MON, so they have nothing to ask it.
 */

/** Monad's per-account reserve: 10 MON. */
export const MONAD_RESERVE_WEI = 10n * 10n ** 18n;

export interface ReserveStanding {
  balanceWei: string;
  reserveWei: string;
  /** At or above the reserve: in-flight gas is covered and value spends won't revert. */
  aboveReserve: boolean;
  /** How far below the reserve, when it is; "0" otherwise. */
  shortfallWei: string;
}

export function reserveStanding(balanceWei: bigint, reserveWei: bigint = MONAD_RESERVE_WEI): ReserveStanding {
  return {
    balanceWei: balanceWei.toString(),
    reserveWei: reserveWei.toString(),
    aboveReserve: balanceWei >= reserveWei,
    shortfallWei: (balanceWei >= reserveWei ? 0n : reserveWei - balanceWei).toString(),
  };
}

/**
 * Whether a transaction keeps its sender clear of Monad's reserve rule:
 * the value it sends must leave at least `min(reserve, balance)` behind (the
 * gas fee itself may dip into the reserve). `emptyingAllowed` is the
 * once-per-three-blocks exception for an undelegated EOA.
 */
export function keepsReserve(opts: {
  balanceWei: bigint;
  valueWei: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  emptyingAllowed?: boolean;
  reserveWei?: bigint;
}): { ok: boolean; reason: string | null } {
  const reserve = opts.reserveWei ?? MONAD_RESERVE_WEI;
  const fee = opts.gasLimit * opts.maxFeePerGas;
  if (opts.valueWei + fee > opts.balanceWei) return { ok: false, reason: "insufficient balance for value plus the gas limit (Monad charges the full limit)" };
  if (opts.valueWei === 0n || opts.emptyingAllowed) return { ok: true, reason: null };
  const floor = opts.balanceWei < reserve ? opts.balanceWei : reserve;
  return opts.balanceWei - opts.valueWei >= floor
    ? { ok: true, reason: null }
    : { ok: false, reason: `the value would leave less than the ${reserve === MONAD_RESERVE_WEI ? "10 MON" : "required"} reserve; Monad reverts it at execution` };
}

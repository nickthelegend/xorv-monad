/**
 * Which ERC-8004 feedback clients carry Xorv weight.
 *
 * giveFeedback is open to any address, so the client, not the tag, is what makes an entry
 * count. Two sources of truth, either one is enough:
 *
 *   on-chain   a Ledger row (XorvLedger emitted something from that address) and the
 *              Broker rows (BrokerSet history, with the term each broker was active)
 *   config     ENVIO_XORV_LEDGER_ADDRESS (the address config.yaml indexes) and the
 *              optional ENVIO_XORV_VERIFIER_ADDRESSES
 *
 * The config side exists because the on-chain side can be blind: with a start block after
 * the ledger's deploy block the constructor's BrokerSet is never seen, and a rateJob for an
 * older job can relay its "starred" feedback before any other ledger event is indexed. It
 * also covers a verifier that signs with its own key instead of the broker's operator EOA.
 *
 * The variables are read once, on first use: they are fixed for the life of an indexer
 * process (Envio Cloud forwards ENVIO_* variables to both codegen and the runtime).
 */

import type { Context } from "./entities.js";
import { parseAddressList } from "./util.js";

let ledgers: string[] | undefined;
let verifiers: string[] | undefined;

function configuredLedgers(): string[] {
  ledgers ??= parseAddressList(process.env.ENVIO_XORV_LEDGER_ADDRESS);
  return ledgers;
}

function configuredVerifiers(): string[] {
  verifiers ??= parseAddressList(process.env.ENVIO_XORV_VERIFIER_ADDRESSES);
  return verifiers;
}

/** True when `client` (lowercase) is the XorvLedger, i.e. the entry was relayed by rateJob. */
export async function isLedgerClient(context: Context, client: string): Promise<boolean> {
  if (configuredLedgers().includes(client)) return true;
  return (await context.Ledger.get(client)) !== undefined;
}

/**
 * True when `client` (lowercase) is the Xorv result verifier right now: the ledger's active
 * broker (the broker's operator EOA writes verifier feedback, SPEC §6) or a configured
 * verifier address. A rotated-out broker stops counting from its BrokerSet onwards.
 */
export async function isVerifierClient(context: Context, client: string): Promise<boolean> {
  if (configuredVerifiers().includes(client)) return true;
  return (await context.Broker.get(client))?.active === true;
}

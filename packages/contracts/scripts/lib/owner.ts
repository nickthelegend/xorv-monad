import { configVariable } from "hardhat/config";
import { type Address, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Who deploys XorvLedger and who owns it.
 *
 * The owner is the only account that can rotate the broker (setBroker) and hand over ownership
 * (transferOwnership, single step). That is the whole recovery plan for a leaked broker key, so the
 * owner must not be a key the broker's host holds: whoever leaks the broker key could otherwise call
 * transferOwnership first and keep the ledger for good, forging receipts (and ratings of them) that
 * ERC-8004 can never forget, since the ledger is their clientAddress.
 *
 * The deployer only pays for the deployment. It can be the broker's own operator key, as long as the
 * owner is someone else.
 */

/** Blank values count as unset: `.env.example` ships these keys as empty lines. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The deployer's key, as a Hardhat configuration variable: XORV_DEPLOYER_KEY from the environment,
 * else from the Hardhat keystore (development, then production), else XORV_OPERATOR_KEY when that
 * is set. The keystore is consulted even when XORV_OPERATOR_KEY is in the environment: a deployer key
 * kept in the keystore (as recommended) must never lose to the broker's hot key.
 */
export function deployerKeyVariable(env: NodeJS.ProcessEnv = process.env) {
  const operatorKey = present(env.XORV_OPERATOR_KEY);
  return configVariable("XORV_DEPLOYER_KEY", operatorKey ? { default: operatorKey } : {});
}

/** The address of XORV_OPERATOR_KEY (the broker's hot key), or undefined when unset or unparsable. */
export function operatorAddress(env: NodeJS.ProcessEnv = process.env): Address | undefined {
  const key = present(env.XORV_OPERATOR_KEY);
  if (key === undefined) return undefined;
  try {
    return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
  } catch {
    return undefined;
  }
}

export interface LedgerOwnerChoice {
  owner: Address;
  /** Where the owner came from, for the deploy log. */
  source: "XORV_LEDGER_OWNER" | "deployer";
  /** Set when the owner is a hot key and the deployment goes ahead anyway (local chain, or opted in). */
  warning?: string;
}

/**
 * Picks the ledger's owner: XORV_LEDGER_OWNER, or the deployer when unset.
 *
 * An owner that is the broker (XORV_BROKER_ADDRESS) or the operator key's address is refused on a
 * real Monad network, where the deployment is kept, unless XORV_ALLOW_OWNER_IS_BROKER=1. On a local
 * chain or a fork it only earns a warning: nothing there outlives the process.
 */
export function chooseLedgerOwner(opts: {
  env: NodeJS.ProcessEnv;
  deployer: Address;
  broker: Address;
  /** A real Monad network (monadTestnet / monad), not a local chain or a fork. */
  live: boolean;
}): LedgerOwnerChoice {
  const { env, live } = opts;
  const deployer = getAddress(opts.deployer);
  const broker = getAddress(opts.broker);

  const ownerEnv = present(env.XORV_LEDGER_OWNER);
  if (ownerEnv !== undefined && !isAddress(ownerEnv, { strict: false })) {
    throw new Error(`XORV_LEDGER_OWNER is not an address: ${ownerEnv}`);
  }
  const owner = ownerEnv !== undefined ? getAddress(ownerEnv) : deployer;
  const source = ownerEnv !== undefined ? "XORV_LEDGER_OWNER" : "deployer";

  const operator = operatorAddress(env);
  const hotAs = owner === broker ? "the broker (XORV_BROKER_ADDRESS)" : owner === operator ? "the operator key's address" : undefined;
  if (hotAs === undefined) return { owner, source };

  const risk =
    `The ledger owner ${owner} (${source}) is ${hotAs}. The owner is what rotates a leaked broker key ` +
    "out; if they are the same key, whoever leaks it can take ownership and the ledger can never be " +
    "recovered.";
  if (live && env.XORV_ALLOW_OWNER_IS_BROKER?.trim() !== "1") {
    throw new Error(
      `${risk} Set XORV_LEDGER_OWNER to an address the broker's host doesn't hold (a hardware or ` +
        "multisig wallet), or deploy with a separate XORV_DEPLOYER_KEY. XORV_ALLOW_OWNER_IS_BROKER=1 " +
        "accepts the risk.",
    );
  }
  return { owner, source, warning: risk };
}

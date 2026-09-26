/**
 * Who pays: the signer behind every x402 payment and every job rating.
 *
 * Two modes, chosen from the environment:
 *
 *  - **local** — a raw secp256k1 key in `XORV_PRIVATE_KEY` (or `XORV_PAYER_KEY`,
 *    the name the CLI uses for its buyer key). Simple, and the key sits in the
 *    MCP client's config file in plain text, bounded only by the ceilings this
 *    server enforces on itself.
 *
 *  - **privy** — a Privy *server wallet* (`XORV_PRIVY_APP_ID`,
 *    `XORV_PRIVY_APP_SECRET`, `XORV_PRIVY_WALLET_ID`, and `XORV_PRIVY_AUTH_KEY`
 *    when the wallet has an owner key). The key never exists on this machine:
 *    Privy signs inside its enclave, and only if the request passes the policy
 *    attached to the wallet — which `pnpm privy:setup` writes to allow nothing
 *    but USDC `TransferWithAuthorization` on this chain, up to a per-signature
 *    cap. That is the difference between an agent that *promises* not to
 *    overspend and one that *cannot*: even a compromised or confused MCP host
 *    cannot get a signature for more than the policy allows.
 *
 * Either way the result is a viem account (`address` + `signTypedData`),
 * which is exactly what x402's `ExactEvmScheme` wants as a `ClientEvmSigner`
 * and what signing an EIP-712 job rating needs — so nothing downstream knows
 * or cares which mode is active.
 *
 * The account is built **once per process** and reused. The 0.1 server built
 * a fresh Hedera SDK client (with its gRPC channels) on every paid call and
 * never closed it; a long-lived MCP process leaked a connection per job. A
 * viem local account is a few closures, and the Privy client is one HTTP
 * client — both are held for the life of the process.
 */

import type { Address, Hex, LocalAccount } from "viem";
import { accountFromKey, normalizeAddress } from "@xorv/protocol";
import type { Env } from "./config.js";

/** What the server signs with — a viem account, which x402 accepts as a `ClientEvmSigner`. */
export type PayerAccount = Pick<LocalAccount, "address" | "signTypedData">;

export interface PrivySignerConfig {
  mode: "privy";
  appId: string;
  appSecret: string;
  walletId: string;
  /** Base64 PKCS#8 P-256 key (optionally `wallet-auth:`-prefixed) for owner-keyed wallets. */
  authKey: string | null;
}

export interface LocalSignerConfig {
  mode: "local";
  /** Which variable the key came from, for error messages. */
  source: "XORV_PRIVATE_KEY" | "XORV_PAYER_KEY";
  key: string;
}

export interface NoSignerConfig {
  mode: "none";
  /** Why nothing can pay — shown verbatim when a paying tool is called. */
  problem: string;
}

export type SignerConfig = PrivySignerConfig | LocalSignerConfig | NoSignerConfig;

const PRIVY_REQUIRED = ["XORV_PRIVY_APP_ID", "XORV_PRIVY_APP_SECRET", "XORV_PRIVY_WALLET_ID"] as const;

const NO_PAYER =
  "No payer configured. To let this MCP server buy jobs, set either XORV_PRIVATE_KEY (a 0x Monad key holding test USDC) " +
  "or XORV_PRIVY_APP_ID + XORV_PRIVY_APP_SECRET + XORV_PRIVY_WALLET_ID (a policy-bounded Privy server wallet — " +
  "`pnpm --filter @xorv/mcp privy:setup` creates one). Read-only tools work without either.";

function readVar(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Decide which signer the environment asks for.
 *
 * Pure and total: it never throws, and an ambiguous or half-finished setup
 * becomes `mode: "none"` with a problem that names the fix. In particular,
 * when *both* a local key and Privy credentials are present it refuses to
 * guess — silently paying from the wrong wallet is precisely the kind of
 * surprise a spending tool must not have — unless `XORV_SIGNER` says which.
 */
export function resolveSignerConfig(env: Env): SignerConfig {
  const explicit = readVar(env, "XORV_SIGNER")?.toLowerCase();
  if (explicit && explicit !== "local" && explicit !== "privy") {
    return { mode: "none", problem: `XORV_SIGNER="${explicit}" is not a signer mode — use "local" or "privy"` };
  }

  const localSource = readVar(env, "XORV_PRIVATE_KEY")
    ? ("XORV_PRIVATE_KEY" as const)
    : readVar(env, "XORV_PAYER_KEY")
      ? ("XORV_PAYER_KEY" as const)
      : null;
  const privyTouched = [...PRIVY_REQUIRED, "XORV_PRIVY_AUTH_KEY"].some((name) => readVar(env, name));

  const wantPrivy = explicit === "privy" || (!explicit && privyTouched && !localSource);
  const wantLocal = explicit === "local" || (!explicit && localSource !== null && !privyTouched);

  if (!explicit && privyTouched && localSource) {
    return {
      mode: "none",
      problem:
        `Both a local key (${localSource}) and a Privy wallet (XORV_PRIVY_*) are configured, and this server will not ` +
        "guess which one should pay. Set XORV_SIGNER=privy or XORV_SIGNER=local, or remove one of them.",
    };
  }

  if (wantPrivy) {
    const missing = PRIVY_REQUIRED.filter((name) => !readVar(env, name));
    if (missing.length > 0) {
      return {
        mode: "none",
        problem: `The Privy signer is missing ${missing.join(", ")}. Run \`pnpm --filter @xorv/mcp privy:setup\` to create a policy-bounded wallet and print the variables.`,
      };
    }
    return {
      mode: "privy",
      appId: readVar(env, "XORV_PRIVY_APP_ID")!,
      appSecret: readVar(env, "XORV_PRIVY_APP_SECRET")!,
      walletId: readVar(env, "XORV_PRIVY_WALLET_ID")!,
      authKey: readVar(env, "XORV_PRIVY_AUTH_KEY") ?? null,
    };
  }

  if (wantLocal && localSource) {
    return { mode: "local", source: localSource, key: readVar(env, localSource)! };
  }

  return { mode: "none", problem: NO_PAYER };
}

// ---------------------------------------------------------------------------
// Building the account
// ---------------------------------------------------------------------------

/** The slice of a Privy wallet record this server reads. */
export interface PrivyWalletRecord {
  id: string;
  address: string;
  chain_type: string;
  policy_ids?: string[];
  owner_id?: string | null;
}

/**
 * The slice of `PrivyClient` this server touches: reading the wallet, plus
 * whatever `createViemAccount` calls to sign (`wallets().ethereum()…`).
 * Declared structurally so tests can hand in a fake.
 */
export interface PrivyClientLike {
  wallets(): {
    get(walletId: string): PromiseLike<PrivyWalletRecord>;
  };
}

export type PrivyClientFactory = (opts: { appId: string; appSecret: string }) => PrivyClientLike | Promise<PrivyClientLike>;

/**
 * The real client. Imported lazily so a local-key server never loads Privy's
 * SDK (and its HPKE/JOSE dependencies) at all.
 */
const defaultPrivyClient: PrivyClientFactory = async ({ appId, appSecret }) => {
  const { PrivyClient } = await import("@privy-io/node");
  return new PrivyClient({ appId, appSecret }) as unknown as PrivyClientLike;
};

export interface ResolvedPayer {
  mode: "local" | "privy";
  account: PayerAccount;
  address: Address;
  /** Human description for tool output and the startup log — never a secret. */
  label: string;
  /** Privy only: the policies Privy enforces on this wallet. */
  policyIds: string[];
}

export interface PayerSigner {
  mode: SignerConfig["mode"];
  /** Short description that needs no network round-trip. */
  describe(): string;
  /**
   * The signing account, built on first use and cached for the process.
   * Rejects with an actionable message when no signer is configured or the
   * configured one is unusable.
   */
  resolve(): Promise<ResolvedPayer>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wrap a signer config in a lazily-built, memoised account.
 *
 * A failed build is *not* memoised: a Privy call that failed because the
 * network blipped should succeed on the next tool call, not poison the
 * process until restart. A successful build is kept forever.
 */
export function createPayerSigner(
  config: SignerConfig,
  deps: { privyClient?: PrivyClientFactory } = {},
): PayerSigner {
  let pending: Promise<ResolvedPayer> | null = null;

  const build = async (): Promise<ResolvedPayer> => {
    if (config.mode === "none") throw new Error(config.problem);

    if (config.mode === "local") {
      let account: LocalAccount;
      try {
        account = accountFromKey(config.key);
      } catch (err) {
        throw new Error(`The key in ${config.source} is unusable: ${errorText(err)}`);
      }
      return {
        mode: "local",
        account,
        address: account.address,
        label: `local key (${config.source}) ${account.address}`,
        policyIds: [],
      };
    }

    // Privy: one client, one wallet lookup, one viem account — then reuse.
    let wallet: PrivyWalletRecord;
    let client: PrivyClientLike;
    try {
      client = await (deps.privyClient ?? defaultPrivyClient)({ appId: config.appId, appSecret: config.appSecret });
      wallet = await client.wallets().get(config.walletId);
    } catch (err) {
      throw new Error(
        `Could not load Privy wallet ${config.walletId}: ${errorText(err)} — check XORV_PRIVY_APP_ID, XORV_PRIVY_APP_SECRET and XORV_PRIVY_WALLET_ID`,
      );
    }
    if (wallet.chain_type !== "ethereum") {
      throw new Error(
        `Privy wallet ${config.walletId} is a ${wallet.chain_type} wallet; paying on Monad needs an ethereum (EVM) wallet`,
      );
    }
    const address = normalizeAddress(wallet.address);
    const { createViemAccount } = await import("@privy-io/node/viem");
    const account = createViemAccount(client as unknown as Parameters<typeof createViemAccount>[0], {
      walletId: config.walletId,
      address: address as Hex,
      ...(config.authKey ? { authorizationContext: { authorization_private_keys: [config.authKey] } } : {}),
    });
    const policyIds = wallet.policy_ids ?? [];
    return {
      mode: "privy",
      account,
      address,
      label: `Privy server wallet ${config.walletId} ${address}${
        policyIds.length > 0 ? ` (policy ${policyIds.join(", ")})` : " (NO POLICY attached — Privy will sign anything this app asks)"
      }`,
      policyIds,
    };
  };

  return {
    mode: config.mode,
    describe() {
      switch (config.mode) {
        case "local":
          return `local key (${config.source})`;
        case "privy":
          return `Privy server wallet ${config.walletId}${config.authKey ? " (owner-keyed)" : ""}`;
        default:
          return "none — read-only";
      }
    },
    resolve() {
      if (!pending) {
        pending = build().catch((err: unknown) => {
          pending = null;
          throw err;
        });
      }
      return pending;
    },
  };
}

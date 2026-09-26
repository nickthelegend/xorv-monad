/**
 * Shared test fixtures: throwaway keys and a fake Privy client.
 *
 * The keys are the well-known Anvil/Hardhat development accounts — public,
 * worthless, and never funded on Monad. Using fixed keys keeps signatures and
 * addresses stable across runs.
 */

import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivyClientLike, PrivyWalletRecord } from "../../src/signer.js";

export const BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const BUYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** The key "inside Privy's enclave" for the fake server wallet. */
export const PRIVY_WALLET_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const PRIVY_WALLET_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** A DER-encoded ED25519 key, as the Hedera prototype stored them. */
export const HEDERA_DER_KEY =
  "302e020100300506032b657004220420aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export interface TypedDataRequest {
  walletId: string;
  typed_data: { domain: Record<string, unknown>; message: Record<string, unknown>; primary_type: string; types: Record<string, Array<{ name: string; type: string }>> };
  authorization_context?: { authorization_private_keys?: string[] };
}

/**
 * Privy sends uint/int fields as hex strings (its viem adapter replaces
 * bigints before the request goes over the wire). Turn them back into
 * bigints so the fake "enclave" can sign what Privy would have signed.
 */
function reviveMessage(
  types: TypedDataRequest["typed_data"]["types"],
  primaryType: string,
  message: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...message };
  for (const field of types[primaryType] ?? []) {
    if (/^u?int\d*$/.test(field.type) && out[field.name] !== undefined) out[field.name] = BigInt(out[field.name] as string);
  }
  return out;
}

export interface FakePrivy {
  factory: (opts: { appId: string; appSecret: string }) => PrivyClientLike;
  factoryCalls: Array<{ appId: string; appSecret: string }>;
  walletGets: string[];
  signRequests: TypedDataRequest[];
  /** Make the next N wallet lookups fail. */
  failNextGets: number;
  wallet: PrivyWalletRecord;
  /** Deny signatures whose typed data fails this check, like a Privy policy would. */
  policy?: (request: TypedDataRequest) => boolean;
}

/**
 * A structural stand-in for `PrivyClient`: `wallets().get` for the lookup,
 * and `wallets().ethereum().signTypedData` — the call `createViemAccount`
 * makes — signing with a local key, the way Privy's enclave would.
 */
export function fakePrivy(overrides: Partial<PrivyWalletRecord> = {}): FakePrivy {
  const enclave = privateKeyToAccount(PRIVY_WALLET_KEY as Hex);
  const state: FakePrivy = {
    factoryCalls: [],
    walletGets: [],
    signRequests: [],
    failNextGets: 0,
    wallet: {
      id: "wal_test",
      // Privy may hand the address back lowercase; the signer must normalize it.
      address: PRIVY_WALLET_ADDRESS.toLowerCase(),
      chain_type: "ethereum",
      policy_ids: ["pol_test"],
      owner_id: null,
      ...overrides,
    },
    factory: (opts) => {
      state.factoryCalls.push(opts);
      const client = {
        wallets: () => ({
          get: async (walletId: string) => {
            state.walletGets.push(walletId);
            if (state.failNextGets > 0) {
              state.failNextGets -= 1;
              throw new Error("503 Service Unavailable");
            }
            return state.wallet;
          },
          ethereum: () => ({
            signTypedData: async (
              walletId: string,
              body: { params: { typed_data: TypedDataRequest["typed_data"] }; authorization_context?: TypedDataRequest["authorization_context"] },
            ) => {
              const request: TypedDataRequest = {
                walletId,
                typed_data: body.params.typed_data,
                authorization_context: body.authorization_context,
              };
              state.signRequests.push(request);
              if (state.policy && !state.policy(request)) {
                throw new Error("400 Policy violation: request denied by policy pol_test");
              }
              const { domain, types, primary_type, message } = body.params.typed_data;
              const signature = await enclave.signTypedData({
                domain: domain as never,
                types: types as never,
                primaryType: primary_type as never,
                message: reviveMessage(types, primary_type, message) as never,
              });
              return { signature };
            },
          }),
        }),
      };
      return client as unknown as PrivyClientLike;
    },
  };
  return state;
}

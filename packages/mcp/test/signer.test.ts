/**
 * Signer-mode selection and the Privy server-wallet account.
 *
 * The Privy client is faked structurally, but the viem account is Privy's
 * real `createViemAccount` — so these tests exercise the actual translation
 * from an x402 signing request to a Privy wallet-API call, and check that
 * what comes back is a signature the payee can verify for the Privy wallet's
 * address.
 */

import { describe, expect, it } from "vitest";
import { buyerX402Client } from "@xorv/protocol";
import { verifyTypedData, type Hex } from "viem";
import { createPayerSigner, resolveSignerConfig } from "../src/signer.js";
import { buildAgentPolicy } from "../src/privy-policy.js";
import {
  BUYER_ADDRESS,
  BUYER_KEY,
  HEDERA_DER_KEY,
  PRIVY_WALLET_ADDRESS,
  fakePrivy,
  type TypedDataRequest,
} from "./helpers/fixtures.js";
import { NETWORK, PROVIDER } from "./helpers/mock-broker.js";

const PRIVY_ENV = {
  XORV_PRIVY_APP_ID: "app_test",
  XORV_PRIVY_APP_SECRET: "secret_test",
  XORV_PRIVY_WALLET_ID: "wal_test",
};

describe("resolveSignerConfig", () => {
  it("is read-only with nothing configured, and says how to fix it", () => {
    const cfg = resolveSignerConfig({});
    expect(cfg.mode).toBe("none");
    expect(cfg.mode === "none" && cfg.problem).toMatch(/no payer configured/i);
    expect(cfg.mode === "none" && cfg.problem).toMatch(/XORV_PRIVATE_KEY/);
    expect(cfg.mode === "none" && cfg.problem).toMatch(/XORV_PRIVY_WALLET_ID/);
  });

  it("treats blank values as unset", () => {
    expect(resolveSignerConfig({ XORV_PRIVATE_KEY: "  ", XORV_PRIVY_APP_ID: "" }).mode).toBe("none");
  });

  it("uses a local key from XORV_PRIVATE_KEY, or the CLI's XORV_PAYER_KEY", () => {
    expect(resolveSignerConfig({ XORV_PRIVATE_KEY: BUYER_KEY })).toEqual({
      mode: "local",
      source: "XORV_PRIVATE_KEY",
      key: BUYER_KEY,
    });
    expect(resolveSignerConfig({ XORV_PAYER_KEY: BUYER_KEY })).toMatchObject({ mode: "local", source: "XORV_PAYER_KEY" });
  });

  it("uses Privy when all three Privy variables are set", () => {
    expect(resolveSignerConfig(PRIVY_ENV)).toEqual({
      mode: "privy",
      appId: "app_test",
      appSecret: "secret_test",
      walletId: "wal_test",
      authKey: null,
    });
    expect(resolveSignerConfig({ ...PRIVY_ENV, XORV_PRIVY_AUTH_KEY: "wallet-auth:abc" })).toMatchObject({
      mode: "privy",
      authKey: "wallet-auth:abc",
    });
  });

  it("names exactly what a half-finished Privy setup is missing", () => {
    const cfg = resolveSignerConfig({ XORV_PRIVY_APP_ID: "app_test" });
    expect(cfg.mode).toBe("none");
    const problem = cfg.mode === "none" ? cfg.problem : "";
    expect(problem).toContain("XORV_PRIVY_APP_SECRET");
    expect(problem).toContain("XORV_PRIVY_WALLET_ID");
    expect(problem).not.toContain("XORV_PRIVY_APP_ID,");
    expect(problem).toMatch(/privy:setup/);
  });

  it("refuses to guess when both a key and Privy are configured", () => {
    const cfg = resolveSignerConfig({ ...PRIVY_ENV, XORV_PRIVATE_KEY: BUYER_KEY });
    expect(cfg.mode).toBe("none");
    expect(cfg.mode === "none" && cfg.problem).toMatch(/XORV_SIGNER/);
  });

  it("lets XORV_SIGNER pick when both are configured", () => {
    expect(resolveSignerConfig({ ...PRIVY_ENV, XORV_PRIVATE_KEY: BUYER_KEY, XORV_SIGNER: "local" }).mode).toBe("local");
    expect(resolveSignerConfig({ ...PRIVY_ENV, XORV_PRIVATE_KEY: BUYER_KEY, XORV_SIGNER: "PRIVY" }).mode).toBe("privy");
  });

  it("rejects an unknown XORV_SIGNER, and an explicit mode with nothing behind it", () => {
    expect(resolveSignerConfig({ XORV_SIGNER: "ledger", XORV_PRIVATE_KEY: BUYER_KEY })).toMatchObject({ mode: "none" });
    const privy = resolveSignerConfig({ XORV_SIGNER: "privy", XORV_PRIVATE_KEY: BUYER_KEY });
    expect(privy.mode === "none" && privy.problem).toMatch(/XORV_PRIVY_APP_ID/);
    const local = resolveSignerConfig({ XORV_SIGNER: "local", ...PRIVY_ENV });
    expect(local.mode === "none" && local.problem).toMatch(/no payer configured/i);
  });
});

describe("local signer", () => {
  it("derives the address from the key and builds the account once", async () => {
    const signer = createPayerSigner(resolveSignerConfig({ XORV_PRIVATE_KEY: BUYER_KEY }));
    expect(signer.describe()).toBe("local key (XORV_PRIVATE_KEY)");
    const first = await signer.resolve();
    expect(first.address).toBe(BUYER_ADDRESS);
    expect(first.mode).toBe("local");
    expect(await signer.resolve()).toBe(first);
  });

  it("explains that a Hedera ED25519 key cannot be reused", async () => {
    const signer = createPayerSigner(resolveSignerConfig({ XORV_PRIVATE_KEY: HEDERA_DER_KEY }));
    await expect(signer.resolve()).rejects.toThrow(/XORV_PRIVATE_KEY is unusable.*ED25519/s);
  });

  it("rejects with the configuration problem when there is no signer", async () => {
    const signer = createPayerSigner(resolveSignerConfig({}));
    expect(signer.describe()).toMatch(/read-only/);
    await expect(signer.resolve()).rejects.toThrow(/no payer configured/i);
  });
});

describe("Privy signer", () => {
  it("builds one client and one account per process, from the wallet's own address", async () => {
    const privy = fakePrivy();
    const signer = createPayerSigner(resolveSignerConfig(PRIVY_ENV), { privyClient: privy.factory });
    expect(signer.describe()).toBe("Privy server wallet wal_test");

    const [a, b] = await Promise.all([signer.resolve(), signer.resolve()]);
    const c = await signer.resolve();
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(privy.factoryCalls).toEqual([{ appId: "app_test", appSecret: "secret_test" }]);
    expect(privy.walletGets).toEqual(["wal_test"]);
    // Privy returned it lowercase; everything downstream gets the checksummed form.
    expect(a.address).toBe(PRIVY_WALLET_ADDRESS);
    expect(a.mode).toBe("privy");
    expect(a.policyIds).toEqual(["pol_test"]);
    expect(a.label).toContain("policy pol_test");
  });

  it("signs an x402 USDC authorization through Privy that verifies for the Privy wallet", async () => {
    const privy = fakePrivy();
    const signer = createPayerSigner(resolveSignerConfig(PRIVY_ENV), { privyClient: privy.factory });
    const payer = await signer.resolve();

    const client = buyerX402Client({
      signer: payer.account,
      network: NETWORK,
      maxUsdcUnits: 50_000,
      expect: { payTo: PROVIDER, amount: "10000" },
    });
    const usdc = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "http://broker.test/api/jobs/qte_1", description: "job", mimeType: "application/json" },
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          asset: usdc,
          amount: "10000",
          payTo: PROVIDER,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
      ],
    });

    // Exactly one wallet-API call, for this wallet, for a USDC authorization on Monad testnet.
    expect(privy.signRequests).toHaveLength(1);
    const request = privy.signRequests[0]!;
    expect(request.walletId).toBe("wal_test");
    expect(request.typed_data.primary_type).toBe("TransferWithAuthorization");
    expect(request.typed_data.domain).toMatchObject({ name: "USDC", version: "2", chainId: 10143, verifyingContract: usdc });
    expect(request.authorization_context).toBeUndefined();

    const auth = payload.payload.authorization as Record<string, string>;
    expect(auth.from).toBe(PRIVY_WALLET_ADDRESS);
    const valid = await verifyTypedData({
      address: PRIVY_WALLET_ADDRESS as Hex,
      domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: usdc as Hex },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as Hex,
        to: auth.to as Hex,
        value: BigInt(auth.value!),
        validAfter: BigInt(auth.validAfter!),
        validBefore: BigInt(auth.validBefore!),
        nonce: auth.nonce as Hex,
      },
      signature: payload.payload.signature as Hex,
    });
    expect(valid).toBe(true);
  });

  it("sends requests that the setup script's policy would allow — and that a lower cap would deny", async () => {
    const privy = fakePrivy();
    const policy = buildAgentPolicy({ network: NETWORK, capUnits: 10_000n });
    // A miniature evaluator for exactly the conditions buildAgentPolicy writes.
    const allows = (p: typeof policy, request: TypedDataRequest) =>
      p.rules.some((rule) =>
        rule.conditions.every((c) => {
          const source = c.field_source === "ethereum_typed_data_domain" ? request.typed_data.domain : request.typed_data.message;
          if (c.field_source === "ethereum_typed_data_message" && c.typed_data.primary_type !== request.typed_data.primary_type) return false;
          const actual = source[c.field];
          if (c.operator === "eq") return String(actual) === c.value;
          if (c.operator === "in") return (c.value as string[]).includes(String(actual));
          return BigInt(actual as string) <= BigInt(c.value as string);
        }),
      );
    privy.policy = (request) => allows(policy, request);

    const signer = createPayerSigner(resolveSignerConfig(PRIVY_ENV), { privyClient: privy.factory });
    const payer = await signer.resolve();
    const requirement = (amount: string) => ({
      x402Version: 2,
      resource: { url: "http://broker.test/api/jobs/qte_1" },
      accepts: [
        {
          scheme: "exact",
          network: NETWORK as `${string}:${string}`,
          asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
          amount,
          payTo: PROVIDER,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
      ],
    });
    const client = (amount: string) =>
      buyerX402Client({ signer: payer.account, network: NETWORK, maxUsdcUnits: 1_000_000, expect: { payTo: PROVIDER, amount } });

    await expect(client("10000").createPaymentPayload(requirement("10000"))).resolves.toBeTruthy();
    await expect(client("10001").createPaymentPayload(requirement("10001"))).rejects.toThrow(/policy/i);
  });

  it("passes the owner key as the authorization context", async () => {
    const privy = fakePrivy();
    const signer = createPayerSigner(resolveSignerConfig({ ...PRIVY_ENV, XORV_PRIVY_AUTH_KEY: "wallet-auth:AAAA" }), {
      privyClient: privy.factory,
    });
    expect(signer.describe()).toContain("owner-keyed");
    const payer = await signer.resolve();
    await payer.account.signTypedData({
      domain: { name: "XorvLedger", version: "1", chainId: 10143, verifyingContract: PROVIDER as Hex },
      types: { Ping: [{ name: "n", type: "uint256" }] },
      primaryType: "Ping",
      message: { n: 1n },
    });
    expect(privy.signRequests[0]?.authorization_context).toEqual({ authorization_private_keys: ["wallet-auth:AAAA"] });
  });

  it("retries a failed wallet lookup on the next call instead of caching the failure", async () => {
    const privy = fakePrivy();
    privy.failNextGets = 1;
    const signer = createPayerSigner(resolveSignerConfig(PRIVY_ENV), { privyClient: privy.factory });
    await expect(signer.resolve()).rejects.toThrow(/Could not load Privy wallet wal_test: 503/);
    const payer = await signer.resolve();
    expect(payer.address).toBe(PRIVY_WALLET_ADDRESS);
  });

  it("refuses a non-EVM wallet, and flags a wallet with no policy", async () => {
    const solana = fakePrivy({ chain_type: "solana" });
    await expect(
      createPayerSigner(resolveSignerConfig(PRIVY_ENV), { privyClient: solana.factory }).resolve(),
    ).rejects.toThrow(/solana wallet/);

    const unbounded = fakePrivy({ policy_ids: [] });
    const payer = await createPayerSigner(resolveSignerConfig(PRIVY_ENV), { privyClient: unbounded.factory }).resolve();
    expect(payer.label).toMatch(/NO POLICY/);
  });
});

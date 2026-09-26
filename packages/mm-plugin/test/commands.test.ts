/**
 * The command classes as `mm` runs them: the real `PluginCommand` base and
 * input engine from `@metamask/agent-wallet/plugin`, a mocked restricted
 * context (wallet state, RPC client, wallet executor) and `CommandIO`, and the
 * scripted broker behind a stubbed global `fetch`.
 */

import { CommandError, resolveInputs, type InputSchema } from "@metamask/agent-wallet/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import XorvJob from "../src/commands/xorv/job.js";
import XorvProviders from "../src/commands/xorv/providers.js";
import XorvQuote from "../src/commands/xorv/quote.js";
import XorvRate from "../src/commands/xorv/rate.js";
import XorvRun from "../src/commands/xorv/run.js";
import type { WalletStateSnapshot } from "../src/lib/wallet.js";
import {
  BROKER_URL,
  JOB_ID,
  PAYER,
  PROVIDER_ADDRESS,
  RATE_TX,
  SETTLE_TX,
  fakeBroker,
  fakeMetaMask,
  job,
  provider,
  type BrokerScript,
  type FakeBroker,
  type FakeMetaMask,
} from "./helpers.js";

type AnyCommand = { ctx: unknown; execute(io: unknown): Promise<unknown>; successHint?(data: unknown): string | undefined };
type CommandClass = new (argv: string[], config: never) => AnyCommand;

interface Harness {
  broker: FakeBroker;
  mm: FakeMetaMask;
  lines: string[];
  executorSources: string[];
  balanceReads: number;
}

let harness: Harness;

function setup(script: BrokerScript = {}, opts: { balance?: bigint; mm?: FakeMetaMask } = {}) {
  const broker = fakeBroker(script);
  vi.stubGlobal("fetch", broker.fetch);
  harness = { broker, mm: opts.mm ?? fakeMetaMask(), lines: [], executorSources: [], balanceReads: 0 };
  return opts;
}

function walletState(): WalletStateSnapshot {
  return {
    remoteWallets: [{ id: "w-1", address: PAYER.address.toLowerCase(), namespace: "evm" }],
    byokWallets: [],
    selectedWallet: { mode: "server-wallet", namespace: "evm", ref: { id: "w-1" } },
  };
}

async function exec<T>(Cmd: CommandClass, flags: Record<string, unknown>, opts: { balance?: bigint } = {}): Promise<{ data: T; hint: string | undefined }> {
  const cmd = new Cmd([], {} as never);
  cmd.ctx = {
    walletStateManager: { read: walletState },
    publicClient: (chainId: number) => {
      expect(chainId).toBe(10143);
      return {
        readContract: async () => {
          harness.balanceReads += 1;
          return opts.balance ?? 5_000_000n;
        },
      };
    },
    walletExecutor: async (_io: unknown, source: string) => {
      harness.executorSources.push(source);
      return harness.mm.executor;
    },
  };
  const io = {
    signal: new AbortController().signal,
    flags,
    isInteractive: false,
    emit: (text: string) => harness.lines.push(text),
    yield: () => undefined,
    notify: () => undefined,
    progress: () => undefined,
    log: () => undefined,
    // The host's real input engine, headless (no prompting).
    resolveInputs: (schema: InputSchema) => resolveInputs(schema, { broker: BROKER_URL, ...flags }, null),
  };
  const data = (await cmd.execute(io)) as T;
  return { data, hint: cmd.successHint?.(data) };
}

beforeEach(() => {
  setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mm xorv providers", () => {
  it("lists online providers cheapest first, with agent ids and reputation", async () => {
    setup({
      providers: [
        provider(),
        provider({ id: "prv_bob", label: "bob-box", agentId: null, agentUrl: null, capabilities: [{ id: "codex", adapter: "codex", displayName: "Codex", model: null, priceUsdMicros: 2_000, maxConcurrency: 1 }] }),
        provider({ id: "prv_off", label: "offline-node", status: "offline" }),
      ],
      leaderboard: [
        {
          providerId: "prv_alice",
          label: "alice-mbp",
          address: PROVIDER_ADDRESS,
          agentId: "42",
          jobsTotal: 10,
          jobsOk: 9,
          successRate: 0.9,
          ratingsCount: 4,
          avgRating: 85,
          reputation: { feedbackCount: 6, feedbackAvg: 88, verifiedScore: 90 },
        },
      ],
    });
    const { data, hint } = await exec<Awaited<ReturnType<XorvProviders["execute"]>>>(XorvProviders as unknown as CommandClass, {});
    expect(data.count).toBe(2);
    expect(data.providers.map((p) => p.label)).toEqual(["bob-box", "alice-mbp"]);
    const alice = data.providers[1]!;
    expect(alice).toMatchObject({ agentId: "42", from: "$0.0040", successRate: 0.9 });
    expect(alice.reputation).toMatchObject({ ratingsCount: 4, avgRating: 85, stars: "★★★★☆", feedbackCount: 6, feedbackAvg: 88 });
    expect(alice.agentUrl).toContain("/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/42");
    expect(data.providers[0]!.reputation.stars).toBe("unrated");
    expect(hint).toMatch(/2 providers online; cheapest \$0\.0020/);
    // No wallet was touched.
    expect(harness.executorSources).toHaveLength(0);
  });

  it("filters by adapter and can include offline nodes; survives a broker without a leaderboard", async () => {
    setup({ providers: [provider(), provider({ id: "prv_off", status: "offline" })], leaderboard: "missing" });
    const { data } = await exec<{ count: number; providers: Array<{ successRate: number | null }> }>(
      XorvProviders as unknown as CommandClass,
      { adapter: "qwen", all: true },
    );
    expect(data.count).toBe(2);
    expect(data.providers[0]!.successRate).toBeCloseTo(0.9);
  });

  it("turns an unreachable broker into a CommandError with a hint", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const err = await exec(XorvProviders as unknown as CommandClass, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: "XORV_BROKER_UNREACHABLE", hint: expect.stringContaining("XORV_BROKER_URL") });
  });
});

describe("mm xorv quote", () => {
  it("prices a job without touching the wallet", async () => {
    const { data, hint } = await exec<Awaited<ReturnType<XorvQuote["execute"]>>>(XorvQuote as unknown as CommandClass, {
      prompt: "Write a haiku about Monad",
      adapter: "claude-code",
      max: "0.02",
    });
    expect(data).toMatchObject({
      quoteId: "qte_TestQuote01",
      chainId: 10143,
      price: "$0.0100",
      usdcAmount: "10000",
      usdc: "0.0100 USDC",
      payTo: PROVIDER_ADDRESS,
      provider: { label: "alice-mbp", agentId: "42", adapter: "claude-code" },
    });
    const sent = JSON.parse(harness.broker.seen.find((s) => s.path === "/api/quotes")!.body);
    expect(sent).toMatchObject({ prompt: "Write a haiku about Monad", adapter: "claude-code", maxPriceUsdMicros: 20_000 });
    expect(hint).toMatch(/mm xorv run/);
    expect(harness.executorSources).toHaveLength(0);
  });

  it("maps 'no provider' to XORV_NO_PROVIDERS", async () => {
    setup({ quote: { status: 503, body: { error: "no online provider matches that request under $0.0010" } } });
    await expect(exec(XorvQuote as unknown as CommandClass, { prompt: "x", max: "0.001" })).rejects.toMatchObject({
      code: "XORV_NO_PROVIDERS",
    });
  });

  it("refuses a missing prompt", async () => {
    await expect(exec(XorvQuote as unknown as CommandClass, {})).rejects.toMatchObject({ code: "XORV_INVALID_INPUT" });
  });
});

describe("mm xorv run", () => {
  it("quotes, has MetaMask sign the EIP-3009 authorization, pays over x402 and returns the result", async () => {
    const { data, hint } = await exec<Awaited<ReturnType<XorvRun["execute"]>>>(XorvRun as unknown as CommandClass, {
      prompt: "Write a haiku about Monad",
      max: "0.05",
    });
    expect(data).toMatchObject({
      jobId: JOB_ID,
      status: "completed",
      result: expect.stringContaining("parallel sunrise"),
      chainId: 10143,
      payer: PAYER.address,
      price: "$0.0100",
      usdcAmount: "10000",
      payment: { txHash: SETTLE_TX, explorerUrl: `https://testnet.monadscan.com/tx/${SETTLE_TX}` },
      receiptExplorerUrl: expect.stringContaining("/tx/0xcdcd"),
      rate: `mm xorv rate ${JOB_ID} --stars 5`,
      jobUrl: `${BROKER_URL}/api/jobs/${JOB_ID}`,
    });
    expect(hint).toContain(`https://testnet.monadscan.com/tx/${SETTLE_TX}`);

    // The executor was requested under this command's manifest id, once.
    expect(harness.executorSources).toEqual(["xorv:run"]);
    expect(harness.mm.requests).toHaveLength(1);
    const request = harness.mm.requests[0]!;
    expect(request).toMatchObject({ kind: "typed-data", chainId: 10143 });
    expect(request.typedData.primaryType).toBe("TransferWithAuthorization");
    expect(request.typedData.message).toMatchObject({ from: PAYER.address, to: PROVIDER_ADDRESS, value: "10000" });
    expect(request.intent?.summary).toMatch(/Xorv: pay 0\.0100 USDC to 0x7099.*alice-mbp.*qte_TestQuote01/);

    // The broker accepted the signature (it verifies it), and the balance was checked first.
    expect(harness.broker.payments).toHaveLength(1);
    expect(harness.balanceReads).toBe(1);
    expect(harness.lines.join("\n")).toMatch(/Paid: https:\/\/testnet\.monadscan\.com\/tx\//);
    expect(harness.lines.join("\n")).toMatch(/› Drafting the haiku/);
  });

  it("stops before signing when the wallet cannot cover the job", async () => {
    await expect(
      exec(XorvRun as unknown as CommandClass, { prompt: "x" }, { balance: 9_999n }),
    ).rejects.toMatchObject({ code: "XORV_INSUFFICIENT_USDC", hint: expect.stringContaining("faucet.circle.com") });
    expect(harness.mm.requests).toHaveLength(0);
  });

  it("refuses a quote over --max without asking MetaMask", async () => {
    await expect(exec(XorvRun as unknown as CommandClass, { prompt: "x", max: "0.005" })).rejects.toMatchObject({
      code: "XORV_QUOTE_REFUSED",
    });
    expect(harness.executorSources).toHaveLength(0);
  });

  it("reports a failed job with its payment link", async () => {
    setup({ job: job({ status: "failed", result: null, error: "provider crashed" }) });
    const err = await exec(XorvRun as unknown as CommandClass, { prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: "XORV_JOB_FAILED", message: expect.stringContaining("provider crashed") });
    expect((err as Error).message).toContain(`/tx/${SETTLE_TX}`);
  });

  it("surfaces a MetaMask Guard Mode denial as XORV_SIGNATURE_DENIED", async () => {
    setup({}, { mm: fakeMetaMask({ result: { status: "DENIED", failureDescription: "outside your allowlist" } }) });
    await expect(exec(XorvRun as unknown as CommandClass, { prompt: "x" })).rejects.toMatchObject({
      code: "XORV_SIGNATURE_DENIED",
      message: expect.stringContaining("outside your allowlist"),
    });
    expect(harness.broker.payments).toHaveLength(0);
  });
});

describe("mm xorv job", () => {
  it("reads a job back", async () => {
    const { data, hint } = await exec<Awaited<ReturnType<XorvJob["execute"]>>>(XorvJob as unknown as CommandClass, { "job-id": JOB_ID });
    expect(data).toMatchObject({ jobId: JOB_ID, status: "completed", payment: { txHash: SETTLE_TX, payer: PAYER.address } });
    expect(hint).toMatch(/mm xorv rate/);
  });
});

describe("mm xorv rate", () => {
  it("signs the XorvLedger rating with MetaMask and relays it", async () => {
    const { data, hint } = await exec<Awaited<ReturnType<XorvRate["execute"]>>>(XorvRate as unknown as CommandClass, {
      "job-id": JOB_ID,
      stars: "4",
    });
    expect(data).toMatchObject({ jobId: JOB_ID, stars: 4, value: 80, agentId: "42", txHash: RATE_TX, signer: PAYER.address });
    expect(hint).toContain("ERC-8004 agent #42");
    expect(harness.executorSources).toEqual(["xorv:rate"]);
    const request = harness.mm.requests[0]!;
    expect(request).toMatchObject({ kind: "typed-data", chainId: 10143 });
    expect(request.typedData.primaryType).toBe("Rating");
    expect(request.typedData.domain).toMatchObject({ name: "XorvLedger", version: "1", chainId: 10143 });
    expect(request.typedData.message).toMatchObject({ value: "80" });
    expect(request.intent?.summary).toMatch(/4\/5 stars/);
    // The broker verified the signature against the payer before accepting.
    expect(harness.broker.ratings).toHaveLength(1);
  });

  it("refuses stars outside 1-5 before contacting anyone", async () => {
    await expect(exec(XorvRate as unknown as CommandClass, { "job-id": JOB_ID, stars: "7" })).rejects.toMatchObject({
      code: "XORV_INVALID_INPUT",
    });
    expect(harness.broker.seen).toHaveLength(0);
  });
});

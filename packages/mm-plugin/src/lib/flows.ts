/**
 * What each `mm xorv …` command does, minus the host plumbing.
 *
 * Every flow takes its dependencies explicitly — the broker client, the
 * wallet executor, the wallet state, an RPC client, a reporter for progress
 * lines — so the tests drive them with a scripted broker and a fake MetaMask,
 * and the command classes stay a few lines of wiring each.
 */

import {
  explorerAgent,
  explorerTx,
  formatDuration,
  formatUsd,
  networkConfig,
  type AdapterKind,
  type JobEvent,
  type PublicJob,
  type PublicProvider,
  type QuoteResponse,
} from "@xorv/protocol";
import type { Address, PublicClient } from "viem";
import type { BrokerClient, LeaderboardRow } from "./broker.js";
import { networkName, targetChainIdOf } from "./config.js";
import { XorvPluginError } from "./errors.js";
import { executorSigner, type TypedDataInput, type WalletExecutor } from "./executor.js";
import { preview, short, stars, usdcLabel } from "./format.js";
import { watchJob } from "./job.js";
import { checkUsdcBalance, payForQuote } from "./pay.js";
import { rateJob, type RateResult } from "./rate.js";
import { vetQuote } from "./vet.js";
import { activeEvmAddress, type WalletStateSnapshot } from "./wallet.js";

/** Where progress goes: `io.emit` / `io.progress` in `mm`, a list in tests. */
export interface Reporter {
  line(text: string): void;
  progress(label?: string): void;
}

export const silentReporter: Reporter = { line: () => undefined, progress: () => undefined };

// ---------------------------------------------------------------------------
// mm xorv providers
// ---------------------------------------------------------------------------

export interface ProviderRow {
  id: string;
  label: string;
  status: string;
  connected: boolean;
  address: string;
  agentId: string | null;
  agentUrl: string | null;
  /** Cheapest capability, e.g. "$0.0100". */
  from: string | null;
  capabilities: Array<{ adapter: AdapterKind; name: string; model: string | null; priceUsdMicros: number; price: string }>;
  jobsCompleted: number;
  jobsFailed: number;
  /** 0–1, or null before the first finished job. */
  successRate: number | null;
  avgDurationMs: number;
  reputation: {
    ratingsCount: number;
    /** Mean buyer rating, 0–100. */
    avgRating: number | null;
    stars: string;
    /** ERC-8004 feedback, when the broker's indexer has it. */
    feedbackCount: number | null;
    feedbackAvg: number | null;
  };
}

export interface ProvidersResult {
  broker: string;
  network: string | null;
  count: number;
  providers: ProviderRow[];
}

export async function listProviders(
  broker: BrokerClient,
  opts: { adapter?: string | null; all?: boolean } = {},
): Promise<ProvidersResult> {
  const [providers, board, network] = await Promise.all([
    broker.providers(),
    broker.leaderboard(),
    broker.network().catch(() => null),
  ]);
  const byId = new Map<string, LeaderboardRow>();
  for (const row of board ?? []) if (row.providerId) byId.set(row.providerId, row);

  const adapter = opts.adapter?.trim() || null;
  const rows = providers
    .filter((p) => opts.all || p.status !== "offline")
    .filter((p) => !adapter || p.capabilities.some((c) => c.adapter === adapter))
    .map((p) => providerRow(p, byId.get(p.id) ?? null, network?.network ?? null))
    .sort((a, b) => cheapest(a) - cheapest(b));
  return { broker: broker.baseUrl, network: network?.network ?? null, count: rows.length, providers: rows };
}

function cheapest(row: ProviderRow): number {
  return Math.min(...row.capabilities.map((c) => c.priceUsdMicros), Number.MAX_SAFE_INTEGER);
}

function providerRow(p: PublicProvider, board: LeaderboardRow | null, network: string | null): ProviderRow {
  const finished = p.stats.jobsCompleted + p.stats.jobsFailed;
  const capabilities = p.capabilities.map((c) => ({
    adapter: c.adapter,
    name: c.displayName,
    model: c.model ?? null,
    priceUsdMicros: c.priceUsdMicros,
    price: formatUsd(c.priceUsdMicros),
  }));
  const min = Math.min(...capabilities.map((c) => c.priceUsdMicros));
  const agentUrl = p.agentUrl ?? (p.agentId && network && targetChainIdOf(network) ? explorerAgent(network, p.agentId) : null);
  const avgRating = board?.avgRating ?? null;
  return {
    id: p.id,
    label: p.label,
    status: p.status,
    connected: p.connected,
    address: p.address,
    agentId: p.agentId,
    agentUrl,
    from: capabilities.length > 0 ? formatUsd(min) : null,
    capabilities,
    jobsCompleted: p.stats.jobsCompleted,
    jobsFailed: p.stats.jobsFailed,
    successRate: board?.successRate ?? (finished > 0 ? p.stats.jobsCompleted / finished : null),
    avgDurationMs: p.stats.avgDurationMs,
    reputation: {
      ratingsCount: board?.ratingsCount ?? 0,
      avgRating,
      stars: stars(avgRating),
      feedbackCount: board?.reputation?.feedbackCount ?? null,
      feedbackAvg: board?.reputation?.feedbackAvg ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// mm xorv quote
// ---------------------------------------------------------------------------

export interface QuoteInputs {
  prompt: string;
  adapter?: string | null;
  maxPriceUsdMicros: number;
  chainId?: number | null;
  title?: string | null;
}

export interface QuoteResult {
  quoteId: string;
  network: string;
  chainId: number;
  price: string;
  priceUsdMicros: number;
  /** USDC smallest units the payment will authorize. */
  usdcAmount: string;
  usdc: string;
  max: string;
  expiresAt: number;
  expiresInSeconds: number;
  provider: {
    id: string;
    label: string;
    address: string;
    agentId: string | null;
    agentUrl: string | null;
    adapter: AdapterKind;
    capability: string;
    model: string | null;
    jobsCompleted: number;
  };
  /** Who the 402 will pay: always the provider, never the broker. */
  payTo: string;
  asset: string;
  routing: QuoteResponse["routing"] | null;
  screening: QuoteResponse["screening"] | null;
}

function requestQuote(broker: BrokerClient, inputs: QuoteInputs): Promise<QuoteResponse> {
  const prompt = inputs.prompt?.trim();
  if (!prompt) {
    throw new XorvPluginError("XORV_INVALID_INPUT", "a prompt is required", 'Pass the task as --prompt "…" (or as the first argument).');
  }
  return broker.quote({
    prompt,
    adapter: (inputs.adapter?.trim() || null) as AdapterKind | null,
    maxPriceUsdMicros: inputs.maxPriceUsdMicros,
    title: inputs.title?.trim() || null,
  });
}

export function quoteResult(quote: QuoteResponse, maxPriceUsdMicros: number, chainId: number, now = Date.now()): QuoteResult {
  const cfg = networkConfig(quote.network);
  return {
    quoteId: quote.quoteId,
    network: quote.network,
    chainId,
    price: quote.priceLabel || formatUsd(quote.priceUsdMicros),
    priceUsdMicros: quote.priceUsdMicros,
    usdcAmount: quote.usdcAmount,
    usdc: usdcLabel(quote.usdcAmount),
    max: formatUsd(maxPriceUsdMicros),
    expiresAt: quote.expiresAt,
    expiresInSeconds: Math.max(0, Math.round((quote.expiresAt - now) / 1000)),
    provider: {
      id: quote.provider.id,
      label: quote.provider.label,
      address: quote.provider.address,
      agentId: quote.provider.agentId,
      agentUrl: quote.provider.agentId ? explorerAgent(quote.network, quote.provider.agentId) : null,
      adapter: quote.provider.adapter,
      capability: quote.provider.capability,
      model: quote.provider.model,
      jobsCompleted: quote.provider.stats?.jobsCompleted ?? 0,
    },
    payTo: quote.provider.address,
    asset: cfg.usdc.address,
    routing: quote.routing ?? null,
    screening: quote.screening ?? null,
  };
}

/** Quote without paying: what `run` would buy, at what price, from whom. Needs no wallet. */
export async function getQuote(broker: BrokerClient, inputs: QuoteInputs): Promise<QuoteResult> {
  const quote = await requestQuote(broker, inputs);
  const vetted = vetQuote(quote, { maxPriceUsdMicros: inputs.maxPriceUsdMicros, chainId: inputs.chainId });
  return quoteResult(vetted.quote, inputs.maxPriceUsdMicros, vetted.chainId);
}

// ---------------------------------------------------------------------------
// mm xorv run
// ---------------------------------------------------------------------------

export interface RunDeps {
  broker: BrokerClient;
  /** `ctx.walletExecutor(io, "xorv:run")`, resolved lazily so a bad quote never touches the wallet. */
  executor: () => Promise<WalletExecutor>;
  walletState: () => WalletStateSnapshot | null;
  /** `ctx.publicClient(chainId)`, or null when the host cannot give one. */
  publicClient: (chainId: number) => Pick<PublicClient, "readContract"> | null;
  reporter?: Reporter;
  signal?: AbortSignal;
}

export interface RunInputs extends QuoteInputs {
  timeoutSeconds: number;
  from?: string | null;
}

export interface RunResult {
  jobId: string;
  status: string;
  result: string | null;
  network: string;
  chainId: number;
  payer: string;
  price: string;
  usdcAmount: string;
  provider: QuoteResult["provider"];
  payment: { txHash: string | null; explorerUrl: string | null };
  receiptTxHash: string | null;
  receiptExplorerUrl: string | null;
  resultHash: string | null;
  verification: PublicJob["verification"];
  durationMs: number;
  jobUrl: string;
  /** The follow-up an agent can offer: rating the provider feeds its ERC-8004 reputation. */
  rate: string;
}

export async function runJob(deps: RunDeps, inputs: RunInputs): Promise<RunResult> {
  const report = deps.reporter ?? silentReporter;
  const started = Date.now();

  // 1. Who pays — read before quoting so a self-quote is refused up front.
  const payer = activeEvmAddress(deps.walletState(), inputs.from);

  // 2. Quote, and vet it before anything is signed.
  report.progress("Requesting a quote…");
  const quote = await requestQuote(deps.broker, inputs);
  const vetted = vetQuote(quote, { maxPriceUsdMicros: inputs.maxPriceUsdMicros, chainId: inputs.chainId, payer });
  const summary = quoteResult(quote, inputs.maxPriceUsdMicros, vetted.chainId);
  report.line(
    `Quote ${quote.quoteId}: ${summary.price} to ${quote.provider.label} ` +
      `(${quote.provider.adapter}${quote.provider.agentId ? `, ERC-8004 agent #${quote.provider.agentId}` : ""}) ` +
      `on ${networkName(vetted.network)}`,
  );
  if (quote.routing?.adapter) report.line(`  routed by ${quote.routing.by} (${quote.routing.model}): ${preview(quote.routing.reason, 100)}`);

  // 3. Can this wallet pay? (Best effort — saves a 2FA prompt for a payment that cannot settle.)
  report.progress("Checking USDC balance…");
  await checkUsdcBalance({
    client: safeClient(deps.publicClient, vetted.chainId),
    network: vetted.network,
    owner: payer,
    amount: quote.usdcAmount,
  });

  // 4. Pay: x402 402 → MetaMask signs the EIP-3009 authorization → retry.
  report.line(`Paying ${usdcLabel(quote.usdcAmount)} to ${short(quote.provider.address)} from ${short(payer)} — approve in MetaMask if asked`);
  report.progress("Waiting for MetaMask to sign the USDC authorization…");
  const executor = await deps.executor();
  let signerError: unknown = null;
  const signer = executorSigner({
    executor,
    address: payer as Address,
    chainId: vetted.chainId,
    signal: deps.signal,
    describe: (typedData) => paymentIntent(typedData, quote),
    onError: (err) => {
      signerError ??= err;
    },
  });
  const paid = await payForQuote({
    broker: deps.broker,
    vetted,
    signer,
    maxPriceUsdMicros: inputs.maxPriceUsdMicros,
    signerError: () => signerError,
  });
  const jobId = paid.response.jobId;
  report.line(`Paid: ${paid.settlement.explorerUrl ?? "settled (no transaction hash reported)"}`);
  report.line(`Job ${jobId} is ${paid.response.status} on ${paid.response.provider?.label ?? quote.provider.label}`);

  // 5. Watch it run.
  const job = await watchJob({
    broker: deps.broker,
    jobId,
    timeoutMs: inputs.timeoutSeconds * 1000,
    signal: deps.signal,
    onStatus: (status) => report.progress(`Job ${status}…`),
    onEvent: (event) => {
      const line = eventLine(event);
      if (line) report.line(line);
    },
  });
  report.progress(undefined);

  const txHash = paid.settlement.txHash ?? job.payment?.txHash ?? null;
  const paymentUrl = txHash ? explorerTx(vetted.network, txHash) : null;
  if (job.status !== "completed") {
    throw new XorvPluginError(
      "XORV_JOB_FAILED",
      `job ${jobId} ${job.status}: ${job.error ?? "no result"}${paymentUrl ? ` (payment ${paymentUrl})` : ""}`,
      "The broker already retried it on other providers at no extra charge. Try again, or choose another --adapter.",
    );
  }
  report.line(`Done in ${formatDuration(Date.now() - started)}`);

  return {
    jobId,
    status: job.status,
    result: job.result,
    network: vetted.network,
    chainId: vetted.chainId,
    payer: paid.settlement.payer ?? payer,
    price: summary.price,
    usdcAmount: quote.usdcAmount,
    provider: summary.provider,
    payment: { txHash, explorerUrl: paymentUrl },
    receiptTxHash: job.receiptTxHash,
    receiptExplorerUrl: job.receiptTxHash ? explorerTx(vetted.network, job.receiptTxHash) : null,
    resultHash: job.resultHash,
    verification: job.verification ?? null,
    durationMs: Date.now() - started,
    jobUrl: deps.broker.jobUrl(jobId),
    rate: `mm xorv rate ${jobId} --stars 5`,
  };
}

/** The line shown in MetaMask's approval screen for the payment signature. */
function paymentIntent(typedData: TypedDataInput, quote: QuoteResponse): string {
  const message = typedData.message as { value?: unknown; to?: unknown };
  const units = message.value !== undefined ? String(message.value) : quote.usdcAmount;
  return (
    `Xorv: pay ${usdcLabel(units)} to ${String(message.to ?? quote.provider.address)} ` +
    `(${quote.provider.label}, ${quote.provider.adapter}) for one AI job, quote ${quote.quoteId} — x402 exact, EIP-3009`
  );
}

function eventLine(event: JobEvent): string | null {
  const text = event.text?.trim();
  if (!text) return null;
  if (event.kind === "reasoning") return null; // noisy; the answer is what matters
  const tag = event.kind === "message" ? "" : `[${event.kind}] `;
  return `  › ${tag}${preview(text, 200)}`;
}

function safeClient(
  factory: RunDeps["publicClient"],
  chainId: number,
): Pick<PublicClient, "readContract"> | null {
  try {
    return factory(chainId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// mm xorv job
// ---------------------------------------------------------------------------

export interface JobResult {
  jobId: string;
  status: string;
  result: string | null;
  error: string | null;
  provider: { id: string | null; label: string | null; address: string | null; agentId: string | null };
  price: string | null;
  payment: { txHash: string | null; explorerUrl: string | null; payer: string | null };
  receiptTxHash: string | null;
  rating: PublicJob["rating"];
  verification: PublicJob["verification"];
  jobUrl: string;
}

export async function readJob(broker: BrokerClient, jobId: string): Promise<JobResult> {
  const id = jobId?.trim();
  if (!id) throw new XorvPluginError("XORV_INVALID_INPUT", "a job id is required", "Pass the job id printed by mm xorv run.");
  const job = await broker.job(id);
  return {
    jobId: job.id,
    status: job.status,
    result: job.result,
    error: job.error,
    provider: { id: job.providerId, label: job.providerLabel, address: job.providerAddress, agentId: job.providerAgentId },
    price: job.priceLabel,
    payment: {
      txHash: job.payment?.txHash ?? null,
      explorerUrl: job.payment?.explorerUrl ?? null,
      payer: job.payment?.payer ?? null,
    },
    receiptTxHash: job.receiptTxHash,
    rating: job.rating,
    verification: job.verification,
    jobUrl: broker.jobUrl(job.id),
  };
}

// ---------------------------------------------------------------------------
// mm xorv rate
// ---------------------------------------------------------------------------

export interface RateDeps {
  broker: BrokerClient;
  executor: () => Promise<WalletExecutor>;
  walletState: () => WalletStateSnapshot | null;
  reporter?: Reporter;
  signal?: AbortSignal;
}

export async function rate(
  deps: RateDeps,
  inputs: { jobId: string; stars: number; value: number; from?: string | null },
): Promise<RateResult> {
  const report = deps.reporter ?? silentReporter;
  const jobId = inputs.jobId?.trim();
  if (!jobId) throw new XorvPluginError("XORV_INVALID_INPUT", "a job id is required", "Pass the job id printed by mm xorv run.");
  let address: string | null = null;
  try {
    address = activeEvmAddress(deps.walletState(), inputs.from);
  } catch (err) {
    // Without a readable wallet state the payer check falls to the signature itself.
    if (inputs.from) throw err;
  }
  report.progress("Waiting for MetaMask to sign the rating…");
  const executor = await deps.executor();
  const result = await rateJob({
    broker: deps.broker,
    executor,
    jobId,
    stars: inputs.stars,
    value: inputs.value,
    address,
    signal: deps.signal,
  });
  report.progress(undefined);
  report.line(`Rated ${stars(result.value)} — relayed to ERC-8004: ${result.explorerUrl}`);
  return result;
}

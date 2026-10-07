/**
 * A stand-in Xorv broker on a local port: enough of the HTTP surface for the
 * MCP server to quote, pay over x402, poll and rate — with no chain, no
 * facilitator and no network.
 *
 * It is strict where the real broker is strict. A payment is accepted only if
 * the `PAYMENT-SIGNATURE` header decodes to an EIP-3009 authorization whose
 * EIP-712 signature recovers to the claimed payer, for the amount and payee
 * the 402 asked; a rating only if it is the payer's EIP-712 signature over the
 * typed data this server handed out. So a test that passes here has produced
 * signatures the real thing would verify.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import {
  jobIdHash,
  networkConfig,
  ratingTypedData,
  sameAddress,
  toJsonSafe,
  type PublicJob,
  type QuoteResponse,
} from "@xorv/protocol";
import { verifyTypedData, type Hex } from "viem";

export const NETWORK = "eip155:10143";
export const PROVIDER = "0x00000000000000000000000000000000000000A1";
export const LEDGER = "0x00000000000000000000000000000000000000b2";
export const SETTLE_TX = `0x${"ab".repeat(32)}`;
export const RECEIPT_TX = `0x${"cd".repeat(32)}`;
export const RATE_TX = `0x${"ef".repeat(32)}`;

const usdc = networkConfig(NETWORK).usdc;

export interface MockBrokerOptions {
  /** Price per job in micro-USD (= USDC units). */
  priceUsdMicros?: number;
  /** Override what the 402 asks for, to test quote/402 mismatches. */
  requirements?: Partial<PaymentRequirements>;
  /** Override fields of the quote response. */
  quote?: Partial<QuoteResponse>;
  /** Who the broker says paid for a job (defaults to whoever paid through it). */
  ratingSigner?: string;
  /** Tamper with the rating typed data before it is handed out. */
  tamperRating?: (offer: Record<string, unknown>) => void;
  /** Fail settlement: answer the paid retry with this status instead of 200. */
  settleStatus?: number;
}

export interface PaymentSeen {
  from: string;
  to: string;
  value: string;
  validBefore: string;
  signature: string;
  valid: boolean;
}

export interface MockBroker {
  url: string;
  quotes: Array<Record<string, unknown>>;
  payments: PaymentSeen[];
  ratings: Array<{ value: number; deadline: number; signature: string; valid: boolean }>;
  /** Requests by "METHOD path" in arrival order. */
  hits: string[];
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export async function startMockBroker(opts: MockBrokerOptions = {}): Promise<MockBroker> {
  const price = opts.priceUsdMicros ?? 10_000;
  const quotes: MockBroker["quotes"] = [];
  const payments: PaymentSeen[] = [];
  const ratings: MockBroker["ratings"] = [];
  const hits: string[] = [];
  let payer: string | null = null;
  let base = "";

  const job = (id: string): PublicJob => ({
    id,
    title: null,
    prompt: "what is 2+2?",
    adapter: "echo",
    status: "completed",
    createdAt: Date.now(),
    assignedAt: Date.now(),
    startedAt: Date.now(),
    completedAt: Date.now(),
    providerId: "prv_test",
    providerLabel: "test-node",
    providerAddress: PROVIDER,
    providerAgentId: "7",
    priceUsdMicros: price,
    priceLabel: "$0.0100",
    payment: {
      asset: "usdc",
      assetAddress: usdc.address,
      amount: String(price),
      network: NETWORK,
      txHash: SETTLE_TX,
      payer: payer ?? PROVIDER,
      payTo: PROVIDER,
      settledAt: Date.now(),
      explorerUrl: `https://testnet.monadvision.com/tx/${SETTLE_TX}`,
    },
    result: "4",
    resultHash: `0x${"12".repeat(32)}`,
    error: null,
    receiptTxHash: RECEIPT_TX,
    routing: null,
    screening: null,
    verification: { by: "kimi", model: "kimi-k3", score: 92, pass: true, rationale: "correct", feedbackTxHash: null },
    rating: null,
    eventCount: 0,
  });

  const requirements = (): PaymentRequirements => ({
    scheme: "exact",
    network: NETWORK,
    asset: usdc.address,
    amount: String(price),
    payTo: PROVIDER,
    maxTimeoutSeconds: 300,
    extra: { name: usdc.name, version: usdc.version },
    ...opts.requirements,
  });

  const ratingParts = (jobId: string, value: number, deadline: number) =>
    ratingTypedData({
      network: NETWORK,
      ledger: LEDGER,
      rating: {
        jobId: jobIdHash(jobId),
        value,
        tag2: "echo",
        endpoint: `${base}/api/quotes`,
        feedbackURI: `${base}/feedback/${jobId}.json`,
        feedbackHash: `0x${"34".repeat(32)}`,
        deadline,
      },
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      const route = `${req.method} ${url.pathname}`;
      hits.push(route);

      if (route === "GET /api/network") {
        return send(res, 200, {
          network: NETWORK,
          chainId: 10143,
          label: "testnet",
          explorerUrl: "https://testnet.monadvision.com",
          usdc: { address: usdc.address, symbol: "USDC", decimals: 6 },
          facilitator: { mode: "self", description: "in-process facilitator", address: PROVIDER },
          ledger: { address: LEDGER, url: `https://testnet.monadvision.com/address/${LEDGER}` },
          erc8004: networkConfig(NETWORK).erc8004,
          indexer: null,
          published: { registrations: 1, heartbeats: 0, receipts: 1, ratings: 0 },
          lastPublishError: null,
          ai: { router: { by: "qwen", model: "qwen3.8-max" }, screener: null, verifier: { by: "kimi", model: "kimi-k3" } },
          feeBps: 0,
          epoch: 1,
          stats: { providersLive: 1, providersConnected: 1, capacity: 1, jobsTotal: 1, jobsCompleted: 1, paidUsdMicros: price },
          heartbeatIntervalMs: 15_000,
        });
      }

      if (route === "POST /api/quotes") {
        const body = await readJson(req);
        quotes.push(body);
        if (Number(body.maxPriceUsdMicros) < price) {
          return send(res, 503, { error: "no online provider matches that request under the ceiling" });
        }
        const quote: QuoteResponse = {
          quoteId: `qte_${quotes.length}`,
          payUrl: `http://wrong.invalid/api/jobs/qte_${quotes.length}`,
          network: NETWORK,
          priceUsdMicros: price,
          priceLabel: "$0.0100",
          usdcAmount: String(price),
          expiresAt: Date.now() + 300_000,
          provider: {
            id: "prv_test",
            label: "test-node",
            address: PROVIDER,
            addressUrl: `https://testnet.monadvision.com/address/${PROVIDER}`,
            agentId: "7",
            capability: "Echo",
            adapter: "echo",
            model: null,
            stats: { jobsCompleted: 3, jobsFailed: 0, earnedUsdcMicros: 30_000, avgDurationMs: 100 },
          },
          accepts: [{ ...requirements(), scheme: "exact", extra: { name: usdc.name, version: usdc.version } }],
          ...opts.quote,
        };
        return send(res, 200, quote);
      }

      const pay = /^POST \/api\/jobs\/(qte_\w+)$/.exec(route);
      if (pay) {
        const header = req.headers["payment-signature"];
        if (typeof header !== "string") {
          const paymentRequired = {
            x402Version: 2,
            resource: { url: `${base}${url.pathname}`, description: "Run one AI job", mimeType: "application/json" },
            accepts: [requirements()],
          };
          return send(res, 402, { quoteId: pay[1] }, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
        }
        const decoded = decodePaymentSignatureHeader(header);
        const auth = decoded.payload.authorization as Record<string, string>;
        const signature = decoded.payload.signature as Hex;
        const req402 = requirements();
        const valid = await verifyTypedData({
          address: auth.from as Hex,
          domain: { name: usdc.name, version: usdc.version, chainId: 10143, verifyingContract: req402.asset as Hex },
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
          signature,
        }).catch(() => false);
        payments.push({ from: auth.from!, to: auth.to!, value: auth.value!, validBefore: auth.validBefore!, signature, valid });
        const matches = valid && sameAddress(auth.to, req402.payTo) && auth.value === req402.amount;
        if (!matches || opts.settleStatus) {
          return send(res, opts.settleStatus ?? 402, { error: matches ? "settlement failed" : "invalid payment" });
        }
        payer = auth.from!;
        return send(
          res,
          200,
          { jobId: "job_test1", status: "paid", payment: job("job_test1").payment },
          {
            "PAYMENT-RESPONSE": encodePaymentResponseHeader({
              success: true,
              transaction: SETTLE_TX,
              network: NETWORK,
              payer: auth.from!,
            }),
          },
        );
      }

      const rating = /^GET \/api\/jobs\/(job_\w+)\/rating$/.exec(route);
      if (rating) {
        const value = Number(url.searchParams.get("value"));
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const typedData = ratingParts(rating[1]!, value, deadline);
        const offer: Record<string, unknown> = {
          jobId: rating[1],
          value,
          deadline,
          signer: opts.ratingSigner ?? payer ?? PROVIDER,
          agentId: "7",
          feedbackURI: `${base}/feedback/${rating[1]}.json`,
          feedbackHash: `0x${"34".repeat(32)}`,
          typedData: toJsonSafe(typedData),
        };
        opts.tamperRating?.(offer);
        return send(res, 200, offer);
      }

      const rate = /^POST \/api\/jobs\/(job_\w+)\/rate$/.exec(route);
      if (rate) {
        const body = await readJson(req);
        const value = Number(body.value);
        const deadline = Number(body.deadline);
        const signature = String(body.signature);
        const signer = opts.ratingSigner ?? payer;
        const valid = signer
          ? await verifyTypedData({ ...ratingParts(rate[1]!, value, deadline), address: signer as Hex, signature: signature as Hex }).catch(
              () => false,
            )
          : false;
        ratings.push({ value, deadline, signature, valid });
        if (!valid) return send(res, 401, { error: "the signature is not from this job's payer" });
        return send(res, 200, {
          ok: true,
          jobId: rate[1],
          value,
          txHash: RATE_TX,
          explorerUrl: `https://testnet.monadvision.com/tx/${RATE_TX}`,
          feedbackURI: `${base}/feedback/${rate[1]}.json`,
        });
      }

      const getJob = /^GET \/api\/jobs\/(job_\w+)$/.exec(route);
      if (getJob) return send(res, 200, { job: job(getJob[1]!) });

      if (route === "GET /api/providers") {
        return send(res, 200, {
          providers: [
            {
              id: "prv_test",
              label: "test-node",
              address: PROVIDER,
              addressUrl: `https://testnet.monadvision.com/address/${PROVIDER}`,
              agentId: "7",
              agentUrl: null,
              endpoint: "http://node.invalid",
              status: "online",
              connected: true,
              activeJobs: 0,
              capabilities: [{ id: "echo", adapter: "echo", displayName: "Echo", priceUsdMicros: price, maxConcurrency: 1 }],
              lastHeartbeatAt: Date.now(),
              registeredAt: Date.now(),
              uptimeSeconds: 10,
              version: "0.2.0",
              region: null,
              stats: { jobsCompleted: 3, jobsFailed: 0, earnedUsdcMicros: 30_000, avgDurationMs: 100 },
              registryTxHash: null,
            },
          ],
        });
      }

      return send(res, 404, { error: "not found" });
    })().catch((err: unknown) => {
      send(res, 500, { error: String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    quotes,
    payments,
    ratings,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

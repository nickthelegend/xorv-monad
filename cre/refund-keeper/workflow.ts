/**
 * refund-keeper — a Chainlink CRE workflow that makes XorvEscrow's refund promise real.
 *
 * XorvEscrow lets anyone refund a job once its deadline passes; the money can only
 * go back to the buyer. This workflow is the "anyone", run by a decentralized oracle
 * network instead of the broker, so it keeps working if the broker disappears:
 *
 *   cron ─► HTTP (consensus): ask the Envio index for funded jobs past their deadline
 *        ─► EVM read: confirm each with XorvEscrow.isRefundable(jobId) on Monad
 *        ─► report: abi.encode(bytes32[] jobIds), signed by the DON
 *        ─► EVM write: KeystoneForwarder → XorvRefundKeeper.onReport → escrow.refund(jobId)
 *
 * The index proposes, the chain decides: a job the indexer still thinks is funded but
 * the escrow says is settled is dropped before the report, and the keeper skips
 * anything that changed in between.
 */
import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  type HTTPSendRequester,
  json,
  LATEST_BLOCK_NUMBER,
  ok,
  prepareReportRequest,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  parseAbi,
  parseAbiParameters,
  toHex,
  zeroAddress,
} from "viem";
import { z } from "zod";

export const configSchema = z.object({
  // Cron with a seconds field: "0 */5 * * * *" runs every five minutes.
  schedule: z.string(),
  /** Envio HyperIndex GraphQL endpoint for the Xorv indexer. */
  indexerUrl: z.string().url(),
  chainSelectorName: z.string(),
  escrowAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  keeperAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  /** Most jobs per report; XorvRefundKeeper.MAX_BATCH is 50. */
  maxBatch: z.number().int().min(1).max(50),
  gasLimit: z.string().regex(/^\d+$/),
});
export type Config = z.infer<typeof configSchema>;

const escrowAbi = parseAbi(["function isRefundable(bytes32 jobId) view returns (bool)"]);

// The same query as EXPIRED_ESCROW_JOBS_QUERY in services/indexer/src/queries.ts, which
// the indexer's tests check against its schema.
const EXPIRED_JOBS = `query ExpiredEscrowJobs($now: numeric!, $limit: Int!) {
  EscrowJob(where: { status: { _eq: "Funded" }, deadline: { _lt: $now } }, order_by: { deadline: asc }, limit: $limit) { id }
}`;

/**
 * Funded jobs past their deadline, as the index sees them. Runs on every node; the
 * nodes must agree on the exact list (identical aggregation), so it is sorted and
 * the deadline cut-off is the DON's agreed time, not each node's clock.
 */
export function expiredJobIds(requester: HTTPSendRequester, config: Config, nowSeconds: number): string {
  const body = JSON.stringify({ query: EXPIRED_JOBS, variables: { now: nowSeconds, limit: config.maxBatch } });
  const response = requester
    .sendRequest({
      url: config.indexerUrl,
      method: "POST",
      multiHeaders: { "content-type": { values: ["application/json"] } },
      body: hexToBase64(toHex(body)),
    })
    .result();
  if (!ok(response)) throw new Error(`indexer answered HTTP ${response.statusCode}`);
  const parsed = json(response) as { data?: { EscrowJob?: Array<{ id: string }> }; errors?: unknown };
  if (!parsed.data?.EscrowJob) throw new Error(`indexer query failed: ${JSON.stringify(parsed.errors ?? parsed)}`);
  const ids = parsed.data.EscrowJob.map((j) => j.id.toLowerCase()).filter((id) => /^0x[0-9a-f]{64}$/.test(id));
  return [...new Set(ids)].sort().join(",");
}

export function onCron(runtime: Runtime<Config>): string {
  const config = runtime.config;
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000);

  // 1. Candidates from the index, agreed by the DON.
  const http = new cre.capabilities.HTTPClient();
  const joined = http
    .sendRequest(runtime, expiredJobIds, consensusIdenticalAggregation<string>())(config, nowSeconds)
    .result();
  const candidates = joined ? joined.split(",") : [];
  runtime.log(`index lists ${candidates.length} funded job(s) past their deadline`);
  if (candidates.length === 0) return "nothing to refund";

  // 2. The chain decides: keep only what XorvEscrow says is refundable right now.
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown chain ${config.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const refundable: Hex[] = [];
  for (const id of candidates) {
    const reply = evm
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: config.escrowAddress as Address,
          data: encodeFunctionData({ abi: escrowAbi, functionName: "isRefundable", args: [id as Hex] }),
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result();
    const ok = decodeFunctionResult({ abi: escrowAbi, functionName: "isRefundable", data: bytesToHex(reply.data) });
    if (ok) refundable.push(id as Hex);
    else runtime.log(`skip ${id}: escrow says not refundable (settled since the index saw it)`);
  }
  if (refundable.length === 0) return "index was ahead of the chain; nothing refundable";

  // 3. One DON-signed report, delivered through the KeystoneForwarder to the keeper.
  const payload = encodeAbiParameters(parseAbiParameters("bytes32[] jobIds"), [refundable]);
  const report = runtime.report(prepareReportRequest(payload)).result();
  const write = evm
    .writeReport(runtime, {
      receiver: config.keeperAddress,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result();
  const tx = write.txHash ? bytesToHex(write.txHash) : "(none)";
  runtime.log(`refund report for ${refundable.length} job(s): tx ${tx}, status ${write.txStatus}`);
  return `refunded ${refundable.length}: ${tx}`;
}

export const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCron)];
};

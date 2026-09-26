/**
 * Hedera Consensus Service — Xorv's audit trail.
 *
 * Three append-only topics carry the facts a marketplace has to be honest
 * about: who joined, who was actually alive, and what each job paid. The broker
 * holds the operational state in memory for speed, but HCS holds the record, so
 * "this provider really was online when it took your job" and "this job really
 * paid this much" are checkable by anyone with a mirror node, not just by us.
 *
 * Publishing is deliberately best-effort and never blocks the request path: a
 * consensus round-trip is ~3s, and a job poster should not wait on the audit
 * log to get their answer. Failures are surfaced, not swallowed silently.
 */

import { Client, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { HCS_SCHEMA_VERSION, mirrorNodeUrl } from "./constants.js";
import type { HcsEnvelope, HcsMessageKind } from "./types.js";

/** Wrap a payload in the versioned envelope every Xorv topic message uses. */
export function envelope<T>(kind: HcsMessageKind, data: T): HcsEnvelope<T> {
  return { v: HCS_SCHEMA_VERSION, kind, at: Date.now(), data };
}

/** Create a public topic with a memo, returning its id. */
export async function createTopic(client: Client, memo: string): Promise<string> {
  const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId;
  if (!topicId) throw new Error(`topic creation returned no id (${receipt.status.toString()})`);
  return topicId.toString();
}

export interface SubmitResult {
  topicId: string;
  transactionId: string;
  /** Consensus timestamp, when the receipt carried a sequence number. */
  sequenceNumber?: string;
}

/**
 * Submit one message to a topic.
 *
 * HCS caps a single message at 1024 bytes before the SDK starts chunking it
 * across multiple transactions. Xorv's envelopes are small by design — receipts
 * carry a hash of the result, never the result itself — but a pathological
 * provider label could still push one over, so oversized payloads are rejected
 * here with a clear error rather than silently costing 3× to publish.
 */
export async function submitMessage(
  client: Client,
  topicId: string,
  payload: unknown,
): Promise<SubmitResult> {
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > 1024) {
    throw new Error(`HCS message is ${bytes}B, over the 1024B single-transaction limit`);
  }
  // `TopicMessageSubmitTransaction` is a chunked transaction: `execute()` goes
  // through `executeAll()`, which signs each chunk and therefore requires a
  // frozen body. Left to freeze implicitly it races whenever the same client is
  // executing something else — which, in the broker, it always is, because the
  // facilitator settles payments on this very client. Freezing explicitly makes
  // it deterministic instead of "works until there's traffic".
  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(body)
    .freezeWith(client)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  if (receipt.status.toString() !== "SUCCESS") {
    throw new Error(`HCS submit failed: ${receipt.status.toString()}`);
  }
  return {
    topicId,
    transactionId: tx.transactionId?.toString() ?? "",
    sequenceNumber: receipt.topicSequenceNumber?.toString(),
  };
}

/**
 * Fire-and-forget publish.
 *
 * Returns the result on success and `null` on failure, after handing the error
 * to `onError`. Call sites use this on the request path where the audit write
 * must not be able to fail the thing being audited.
 */
export async function submitMessageSafe(
  client: Client,
  topicId: string | undefined | null,
  payload: unknown,
  onError?: (err: Error) => void,
): Promise<SubmitResult | null> {
  if (!topicId) return null;
  try {
    return await submitMessage(client, topicId, payload);
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}

export interface MirrorTopicMessage {
  consensus_timestamp: string;
  sequence_number: number;
  message: string;
  payer_account_id: string;
}

/**
 * Read a topic back through the Mirror Node.
 *
 * This is how the web app renders the public audit trail without needing a
 * consensus-node connection or any credentials at all — anyone can verify the
 * same feed from the same public endpoint.
 */
export async function readTopic(
  network: string,
  topicId: string,
  opts: { limit?: number; order?: "asc" | "desc" } = {},
): Promise<Array<{ consensusAt: string; sequence: number; payload: unknown; payer: string }>> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const order = opts.order ?? "desc";
  const url = `${mirrorNodeUrl(network)}/api/v1/topics/${topicId}/messages?limit=${limit}&order=${order}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`mirror node topic read → ${res.status}`);
  const body = (await res.json()) as { messages?: MirrorTopicMessage[] };
  return (body.messages ?? []).map((m) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
    } catch {
      // A message we didn't write, or a chunk of one — surfaced as null rather
      // than throwing, so one foreign message can't break the whole feed.
      payload = null;
    }
    return {
      consensusAt: m.consensus_timestamp,
      sequence: m.sequence_number,
      payload,
      payer: m.payer_account_id,
    };
  });
}

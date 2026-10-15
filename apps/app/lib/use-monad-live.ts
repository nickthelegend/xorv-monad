"use client";

/**
 * Monad's live block pipeline and Xorv's own on-chain events, straight from a
 * Monad RPC WebSocket.
 *
 * Two subscriptions on one socket:
 *  - `monadNewHeads`: every block, re-sent as it goes Proposed → Voted →
 *    Finalized → Verified (lib/commit-states.ts tracks it);
 *  - `monadLogs`, filtered to XorvLedger and the ERC-8004 registries on the
 *    same network: Xorv receipts, registrations and reputation, each shown
 *    with the commit state it has reached.
 *
 * Read-only. The socket is open only while the tab is visible (the public RPC
 * is rate-limited, and a hidden tab has no one to show it to), and reconnects
 * with backoff when it drops.
 */
import { useEffect, useReducer, useState } from "react";
import { EMPTY_PIPELINE, applyHead, type CommitState, type HeadMessage, type Pipeline } from "@/lib/commit-states";

export interface LiveLog {
  key: string;
  address: string;
  topic0: string | null;
  blockNumber: number;
  txHash: string;
  seenAt: number;
  state: CommitState;
  ms: Partial<Record<CommitState, number>>;
}

type Action = { kind: "head"; msg: HeadMessage; at: number } | { kind: "log"; log: Record<string, unknown>; at: number } | { kind: "reset" };

interface State {
  pipeline: Pipeline;
  logs: LiveLog[];
}

const RANK: Record<string, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };

function reduce(state: State, action: Action): State {
  if (action.kind === "reset") return { pipeline: EMPTY_PIPELINE, logs: state.logs };
  if (action.kind === "head") return { ...state, pipeline: applyHead(state.pipeline, action.msg, action.at) };
  const log = action.log;
  const commit = String(log.commitState ?? "");
  if (!(commit in RANK)) return state;
  const key = `${String(log.transactionHash)}:${String(log.logIndex)}`;
  const found = state.logs.find((l) => l.key === key);
  if (found) {
    if (RANK[commit]! <= RANK[found.state]!) return state;
    const next = { ...found, state: commit as CommitState, ms: { ...found.ms, [commit]: Math.round(action.at - found.seenAt) } };
    return { ...state, logs: state.logs.map((l) => (l.key === key ? next : l)) };
  }
  const topics = Array.isArray(log.topics) ? (log.topics as string[]) : [];
  const entry: LiveLog = {
    key,
    address: String(log.address ?? ""),
    topic0: topics[0] ?? null,
    blockNumber: Number.parseInt(String(log.blockNumber ?? "0x0"), 16),
    txHash: String(log.transactionHash ?? ""),
    seenAt: action.at,
    state: commit as CommitState,
    ms: commit === "Proposed" ? { Proposed: 0 } : {},
  };
  return { ...state, logs: [entry, ...state.logs].slice(0, 20) };
}

export type LiveStatus = "connecting" | "live" | "paused" | "unavailable";

export function useMonadLive(url: string, watch: readonly string[]): { pipeline: Pipeline; logs: LiveLog[]; status: LiveStatus } {
  const [state, dispatch] = useReducer(reduce, { pipeline: EMPTY_PIPELINE, logs: [] });
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const watchKey = watch.join(",");

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;
    const addresses = watchKey ? watchKey.split(",") : [];

    const open = (): void => {
      if (stopped || document.visibilityState !== "visible") return;
      setStatus("connecting");
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        attempts = 0;
        setStatus("live");
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["monadNewHeads"] }));
        if (addresses.length) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["monadLogs", { address: addresses }] }));
        }
      };
      ws.onmessage = (event) => {
        let message: { id?: number; error?: unknown; params?: { result?: Record<string, unknown> } };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id === 1 && message.error) setStatus("unavailable");
        const result = message.params?.result;
        if (!result) return;
        const at = performance.timeOrigin + performance.now();
        if ("transactionHash" in result) dispatch({ kind: "log", log: result, at });
        else dispatch({ kind: "head", msg: result as unknown as HeadMessage, at });
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        if (stopped || document.visibilityState !== "visible") return;
        attempts += 1;
        setStatus(attempts > 3 ? "unavailable" : "connecting");
        retry = setTimeout(open, Math.min(30_000, 1_000 * 2 ** attempts));
      };
    };

    const close = (): void => {
      if (retry) clearTimeout(retry);
      retry = null;
      const ws = socket;
      socket = null;
      ws?.close();
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        dispatch({ kind: "reset" });
        open();
      } else {
        close();
        setStatus("paused");
      }
    };

    open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [url, watchKey]);

  return { pipeline: state.pipeline, logs: state.logs, status };
}

/**
 * A scripted JSON-RPC endpoint for viem, so chain-facing code is tested
 * through the real viem encode/decode path with no network at all.
 *
 * Each handler receives the raw JSON-RPC params and returns the raw result
 * (hex strings, as a node would). An unscripted method fails loudly — a test
 * that silently gets `undefined` back from an RPC is testing nothing.
 */

import { custom, type Transport } from "viem";

export interface RpcCall {
  method: string;
  params: unknown[];
}

export type RpcHandler = (params: unknown[], call: RpcCall) => unknown | Promise<unknown>;

export class RpcError extends Error {
  code: number;
  constructor(message: string, code = -32000) {
    super(message);
    this.code = code;
  }
}

export function fakeRpc(handlers: Record<string, RpcHandler>): { transport: Transport; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        const call: RpcCall = { method, params: Array.isArray(params) ? params : [] };
        calls.push(call);
        const handler = handlers[method];
        if (!handler) throw new RpcError(`fake rpc: unexpected method ${method}`, -32601);
        return handler(call.params, call);
      },
    },
    { retryCount: 0 },
  );
  return { transport, calls };
}

export const hex = (value: number | bigint): `0x${string}` => `0x${value.toString(16)}`;

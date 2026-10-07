import { describe, expect, it } from "vitest";
import { isSyncUnsupported, sendModeOf, syncReceipt } from "../src/sync-send.js";

describe("eth_sendRawTransactionSync fallback", () => {
  it("falls back only when the node doesn't offer the method", () => {
    expect(isSyncUnsupported({ code: -32601, message: "Method not found" })).toBe(true);
    expect(isSyncUnsupported({ cause: { code: -32601 } })).toBe(true);
    expect(isSyncUnsupported({ message: "the method eth_sendRawTransactionSync does not exist/is not available" })).toBe(true);
    expect(isSyncUnsupported({ details: "method not supported" })).toBe(true);
    // A real failure (a revert, a nonce or balance problem, a timeout) must surface, not silently resend.
    expect(isSyncUnsupported({ code: -32000, message: "nonce too low" })).toBe(false);
    expect(isSyncUnsupported({ code: 5, message: "The transaction is not ready to be processed" })).toBe(false);
    expect(isSyncUnsupported(new Error("execution reverted"))).toBe(false);
  });

  it("knows nothing about a hash it didn't send", () => {
    expect(sendModeOf("0xabc")).toBeNull();
    expect(syncReceipt("0xabc")).toBeNull();
  });
});

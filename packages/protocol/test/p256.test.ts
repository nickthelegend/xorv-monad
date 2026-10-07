import { describe, expect, it } from "vitest";
import { derToRs, p256Input } from "../src/p256.js";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let hex = v.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    let bytes = Buffer.from(hex, "hex");
    if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x30, body.length]), body]));
}

describe("P256 encoding for the 0x0100 precompile", () => {
  it("reads r and s out of DER, padding included, and keeps s in the low half", () => {
    const r = 0x8000000000000000000000000000000000000000000000000000000000000001n; // high bit set: DER pads it
    expect(derToRs(der(r, 5n))).toEqual({ r, s: 5n });
    expect(derToRs(der(r, N - 5n))).toEqual({ r, s: 5n });
    expect(() => derToRs(new Uint8Array([0x31, 0]))).toThrow(/DER/);
  });

  it("lays out hash ‖ r ‖ s ‖ x ‖ y as 160 bytes", () => {
    const input = p256Input({ hash: `0x${"11".repeat(32)}`, r: 2n, s: 3n, x: 4n, y: 5n });
    expect((input.length - 2) / 2).toBe(160);
    expect(input.slice(2 + 64, 2 + 128)).toBe(`${"0".repeat(63)}2`);
  });
});

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

describe("passkey public keys", () => {
  it("reads x and y from the SPKI a passkey hands out at creation", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { spkiToXY } = await import("../src/p256.js");
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = new Uint8Array(publicKey.export({ format: "der", type: "spki" }));
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const coord = (b64: string) => BigInt(`0x${Buffer.from(b64, "base64url").toString("hex")}`);
    expect(spkiToXY(spki)).toEqual({ x: coord(jwk.x), y: coord(jwk.y) });
    expect(() => spkiToXY(new Uint8Array(10))).toThrow();
  });

  it("recovers a passkey's key from two of its assertions, and refuses two different passkeys", async () => {
    const { createHash, generateKeyPairSync, sign } = await import("node:crypto");
    const { recoverPasskeyKey, verifyPasskeyLocally } = await import("../src/p256.js");
    const key = () => {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
      const coord = (b64: string) => BigInt(`0x${Buffer.from(b64, "base64url").toString("hex")}`);
      return { privateKey, x: coord(jwk.x), y: coord(jwk.y) };
    };
    const assert = (k: ReturnType<typeof key>, challenge: string) => {
      const authenticatorData = new Uint8Array(Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([5, 0, 0, 0, 1])]));
      const clientDataJSON = new Uint8Array(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost" })));
      const signature = new Uint8Array(sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), k.privateKey));
      return { authenticatorData, clientDataJSON, signature };
    };
    const a = key();
    const recovered = recoverPasskeyKey(assert(a, "one"), assert(a, "two"));
    expect(recovered).toEqual({ x: a.x, y: a.y });
    expect(verifyPasskeyLocally(assert(a, "three"), recovered!)).toBe(true);
    expect(recoverPasskeyKey(assert(a, "one"), assert(key(), "two"))).toBeNull();
  });
});

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { b64url, recordAssertion, recordCreated, type Registry } from "@/lib/private/passkey-onchain";

function passkey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const hex = (b: string) => `0x${BigInt(`0x${Buffer.from(b, "base64url").toString("hex")}`).toString(16)}`;
  return { privateKey, spki: new Uint8Array(publicKey.export({ format: "der", type: "spki" })), x: hex(jwk.x), y: hex(jwk.y) };
}

function unlock(key: ReturnType<typeof passkey>, challenge: string) {
  const authenticatorData = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([5, 0, 0, 0, 7])]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "http://localhost:8652" }));
  const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), key.privateKey);
  return {
    authenticatorData: b64url(new Uint8Array(authenticatorData)),
    clientDataJSON: b64url(new Uint8Array(clientDataJSON)),
    signature: b64url(new Uint8Array(signature)),
    at: Date.now(),
  };
}

describe("registering a passkey's public key for Monad's P256 check", () => {
  it("keeps the key a passkey hands out at creation", () => {
    const k = passkey();
    const r = recordCreated({}, "cred", k.spki);
    expect(r.cred).toMatchObject({ x: k.x, y: k.y, source: "created" });
    // Later unlocks only refresh the assertion to check.
    const after = recordAssertion(r, "cred", unlock(k, "a"));
    expect(after.cred).toMatchObject({ x: k.x, source: "created", previous: null });
    expect(after.cred!.last).not.toBeNull();
  });

  it("recovers the key of a passkey made earlier from two of its unlocks", () => {
    const k = passkey();
    let r: Registry = recordAssertion({}, "old", unlock(k, "inbox"));
    expect(r.old).toMatchObject({ x: null, source: null });
    r = recordAssertion(r, "old", unlock(k, "vault"));
    expect(r.old).toMatchObject({ x: k.x, y: k.y, source: "recovered", previous: null });
  });

  it("never pins a key from two different passkeys' signatures", () => {
    const r = recordAssertion(recordAssertion({}, "mixed", unlock(passkey(), "a")), "mixed", unlock(passkey(), "b"));
    expect(r.mixed).toMatchObject({ x: null, source: null });
  });

  it("is the same credential-id encoding Mera uses (unpadded base64url)", () => {
    expect(b64url(new Uint8Array([251, 255, 0]))).toBe("-_8A");
  });
});

/**
 * Passkey signatures checked by the P256VERIFY precompile (0x0100) of a real
 * node: anvil implements it as Monad does. Skipped when anvil is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createPublicClient, defineChain, http, toHex, type PublicClient } from "viem";
import { derToRs, p256VerifyOnChain, verifyPasskeyAssertion, webauthnDigest } from "../src/p256.js";

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});
const chain = defineChain({
  id: 10143,
  name: "anvil-as-monad-testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
});

/** A passkey: a P-256 key pair, with the public key as WebAuthn reports it (x, y). */
function passkey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const coord = (b64: string) => BigInt(toHex(Buffer.from(b64, "base64url")));
  return { privateKey, x: coord(jwk.x), y: coord(jwk.y) };
}

/** What a browser's navigator.credentials.get() returns for a challenge, signed by the passkey. */
function assertion(key: ReturnType<typeof passkey>, challenge: string) {
  const rpIdHash = createHash("sha256").update("localhost").digest();
  const authenticatorData = new Uint8Array(Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]));
  const clientDataJSON = new Uint8Array(
    Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(challenge).toString("base64url"), origin: "http://localhost:8652" })),
  );
  // The authenticator signs authenticatorData ‖ sha256(clientDataJSON) with SHA-256, DER-encoded.
  const signature = new Uint8Array(
    sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), key.privateKey),
  );
  return { authenticatorData, clientDataJSON, signature };
}

describe.skipIf(!hasAnvil)("passkey signatures on the P256VERIFY precompile", () => {
  let node: ChildProcess | null = null;
  let client: PublicClient;

  beforeAll(async () => {
    node = spawn("anvil", ["--port", String(PORT), "--chain-id", "10143", "--silent"]);
    client = createPublicClient({ chain, transport: http() }) as PublicClient;
    for (let i = 0; i < 50; i++) {
      try {
        await client.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }, 30_000);

  afterAll(() => {
    node?.kill();
  });

  it("accepts a passkey's WebAuthn assertion, and refuses it for another key, a changed challenge or a tampered signature", async () => {
    const key = passkey();
    const a = assertion(key, "pay job_42 into XorvEscrow");
    expect(await verifyPasskeyAssertion(client, { ...a, x: key.x, y: key.y })).toBe(true);

    const other = passkey();
    expect(await verifyPasskeyAssertion(client, { ...a, x: other.x, y: other.y })).toBe(false);

    const changed = assertion(key, "pay job_43 into XorvEscrow");
    expect(await verifyPasskeyAssertion(client, { ...a, clientDataJSON: changed.clientDataJSON, x: key.x, y: key.y })).toBe(false);

    const { r, s } = derToRs(a.signature);
    const hash = webauthnDigest(a.authenticatorData, a.clientDataJSON);
    expect(await p256VerifyOnChain(client, { hash, r, s: s + 1n, x: key.x, y: key.y })).toBe(false);
  });
});

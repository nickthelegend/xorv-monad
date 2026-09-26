/**
 * A fake passkey authenticator for Mera, with sync.
 *
 * It implements Mera's `WebAuthnClient` seam — so the real Mera code runs
 * (salt checks, output checks, credential pinning) — and computes the PRF the
 * way WebAuthn does: HMAC-SHA256 over the credential's secret, keyed on
 * SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt). `syncedDevice()` returns a second
 * authenticator holding the same credentials, which is what iCloud Keychain or
 * Google Password Manager gives a second phone or a fresh browser profile.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { WebAuthnClient } from "@category-labs/mera";

interface Credential {
  id: Buffer;
  rpId: string;
  secret: Buffer;
}

export interface Ceremony {
  kind: "create" | "get";
  salt: string;
  /** The credential the request was restricted to, if any (hex). */
  allow: string | null;
}

function prf(secret: Buffer, salt: Uint8Array): Uint8Array {
  const evalSalt = createHash("sha256").update(Buffer.concat([Buffer.from("WebAuthn PRF"), Buffer.from([0]), Buffer.from(salt)])).digest();
  return new Uint8Array(createHmac("sha256", secret).update(evalSalt).digest());
}

export class FakeAuthenticator {
  readonly ceremonies: Ceremony[] = [];
  /** Which discoverable credential to answer with when the request names none (default: the first). */
  choose: (candidates: Credential[]) => Credential | undefined = (c) => c[0];
  /** Simulate an authenticator without PRF. */
  prfSupported = true;

  constructor(private readonly credentials: Credential[] = []) {}

  /** A second device where the same passkeys have synced. */
  syncedDevice(): FakeAuthenticator {
    return new FakeAuthenticator(this.credentials.map((c) => ({ ...c })));
  }

  get credentialIds(): string[] {
    return this.credentials.map((c) => c.id.toString("hex"));
  }

  readonly client: WebAuthnClient = {
    createCredential: async (request) => {
      const credential: Credential = { id: randomBytes(16), rpId: request.rp.id, secret: randomBytes(32) };
      this.credentials.push(credential);
      this.ceremonies.push({ kind: "create", salt: Buffer.from(request.prfSalt).toString("hex"), allow: null });
      return {
        credentialId: new Uint8Array(credential.id),
        transports: ["internal", "hybrid"],
        prfEnabled: this.prfSupported,
        ...(this.prfSupported ? { prfOutput: prf(credential.secret, request.prfSalt) } : {}),
      };
    },
    getCredential: async (request) => {
      const allow = request.allowCredential ? Buffer.from(request.allowCredential.credentialId) : null;
      this.ceremonies.push({ kind: "get", salt: Buffer.from(request.prfSalt).toString("hex"), allow: allow?.toString("hex") ?? null });
      const candidates = this.credentials.filter((c) => c.rpId === request.rpId);
      const credential = allow ? candidates.find((c) => c.id.equals(allow)) : this.choose(candidates);
      if (!credential) throw new DOMException("no passkey for this site", "NotAllowedError");
      return {
        credentialId: new Uint8Array(credential.id),
        ...(this.prfSupported ? { prfOutput: prf(credential.secret, request.prfSalt) } : {}),
      };
    },
  };
}

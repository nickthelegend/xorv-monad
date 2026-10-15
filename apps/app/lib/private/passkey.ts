/**
 * The passkey half of private jobs, through Mera.
 *
 * Mera (`@category-labs/mera`) runs the WebAuthn ceremonies and hands back the
 * PRF output for a salt; everything Xorv does with that output — which salt
 * means what, how it becomes a key — lives in `@xorv/protocol` (sealed.ts), so
 * the provider, the broker's tests and this page all agree on it.
 *
 * One ceremony per namespace. WebAuthn can evaluate two salts at once, but
 * Mera exposes one, and that is the right trade here: each namespace's output
 * comes from the authenticator itself rather than from a shared secret fanned
 * out in page memory, and a flow that only needs the inbox (reading a result)
 * only asks for the inbox.
 *
 * This passkey is *not* the wallet. Privy's embedded wallet pays for jobs;
 * this credential exists only to derive encryption keys, and the copy around
 * every button says so.
 */

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
  type WebAuthnClient,
} from "@category-labs/mera";
import { prfSaltFor, type PrfNamespace } from "@xorv/protocol/web";
import { capturingWebAuthnClient } from "./passkey-onchain";

export type { PasskeyCredentialMetadata, WebAuthnClient };

/** Where ceremonies run: the relying party, and (in tests) a fake authenticator. */
export interface PasskeyEnv {
  /** WebAuthn relying party id: the host the passkey is scoped to (and syncs under). */
  rpId: string;
  rpName: string;
  /** Mera's default is the browser's `navigator.credentials`; tests pass a fake. */
  webAuthnClient?: WebAuthnClient;
}

export function browserPasskeyEnv(): PasskeyEnv {
  // Mera's ceremonies, through a client that also keeps the passkey's public key and its
  // unlock assertions, so the passkey can be checked on Monad's P256 precompile.
  return { rpId: window.location.hostname, rpName: "Xorv", webAuthnClient: capturingWebAuthnClient };
}

/** What the authenticator shows as the passkey's name — says what it is for. */
export const PASSKEY_USER = {
  name: "xorv-private-job-keys",
  displayName: "Xorv · private job keys (not a wallet)",
};

export interface PrfResult {
  credential: PasskeyCredentialMetadata;
  /** 32 bytes. The caller derives from it and zeroes it. */
  prfOutput: Uint8Array;
}

/**
 * Create the encryption passkey, evaluating the inbox namespace in the same
 * ceremony (Mera falls back to a second prompt on authenticators that can't
 * evaluate PRF at creation).
 */
export async function createKeyPasskey(env: PasskeyEnv): Promise<PrfResult> {
  const created = await createPasskeyWithPrfOutput({
    rp: { id: env.rpId, name: env.rpName },
    user: PASSKEY_USER,
    prfSalt: prfSaltFor("inbox"),
    ...(env.webAuthnClient ? { webAuthnClient: env.webAuthnClient } : {}),
  });
  const credential: PasskeyCredentialMetadata = {
    credentialId: created.credentialId,
    ...(created.transports ? { transports: created.transports } : {}),
  };
  return { credential, prfOutput: created.prfOutput };
}

/**
 * Evaluate one namespace. Without `credential` the browser offers any
 * discoverable passkey for this site — which is exactly the fresh-device case:
 * the synced passkey is there, nothing else is.
 */
export async function evaluateNamespace(
  env: PasskeyEnv,
  namespace: PrfNamespace,
  credential: PasskeyCredentialMetadata | null,
): Promise<PrfResult> {
  const result = await getPasskeyPrfOutput({
    rpId: env.rpId,
    prfSalt: prfSaltFor(namespace),
    ...(credential ? { credential } : {}),
    ...(env.webAuthnClient ? { webAuthnClient: env.webAuthnClient } : {}),
  });
  const pinned: PasskeyCredentialMetadata =
    credential && credential.credentialId === result.credentialId ? credential : { credentialId: result.credentialId };
  return { credential: pinned, prfOutput: result.prfOutput };
}

export type PasskeyFailure = "cancelled" | "no-prf" | "unsupported" | "other";

/** Turn a Mera (or WebAuthn) failure into something a person can act on. */
export function describePasskeyError(err: unknown): { kind: PasskeyFailure; message: string } {
  if (isMeraError(err)) {
    if (err.code === "PRF_UNAVAILABLE") {
      return {
        kind: "no-prf",
        message:
          "This passkey or browser can't derive encryption keys (the WebAuthn PRF extension). Try Chrome, Edge or Safari 18+ with a synced passkey (Google Password Manager, iCloud Keychain, 1Password).",
      };
    }
    if (err.code === "CRYPTO_UNAVAILABLE") {
      return { kind: "unsupported", message: "This page needs a secure context (https or localhost) for passkeys." };
    }
    const cause = (err as { cause?: unknown }).cause;
    const name = cause && typeof cause === "object" && "name" in cause ? String((cause as { name: unknown }).name) : "";
    if (name === "NotAllowedError" || name === "AbortError") {
      return {
        kind: "cancelled",
        message: "The passkey prompt was dismissed or timed out. No passkey for this site yet? Create one first.",
      };
    }
    if (name === "SecurityError") {
      return { kind: "unsupported", message: "Passkeys aren't allowed on this address. Open the app on its https domain." };
    }
  }
  return { kind: "other", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Best-effort PRF support check, before anyone is asked to touch a sensor.
 *
 * `getClientCapabilities` (WebAuthn L3) answers directly where it exists. Where
 * it doesn't, the honest answer is "unknown" — the ceremony itself is the test,
 * and `describePasskeyError` explains a `PRF_UNAVAILABLE`.
 */
export async function detectPrfSupport(): Promise<"supported" | "unsupported" | "unknown"> {
  if (typeof window === "undefined") return "unknown";
  const PKC = (window as { PublicKeyCredential?: unknown }).PublicKeyCredential as
    | { getClientCapabilities?: () => Promise<Record<string, boolean>> }
    | undefined;
  if (!PKC || !navigator.credentials) return "unsupported";
  try {
    const caps = await PKC.getClientCapabilities?.();
    if (caps && "extension:prf" in caps) return caps["extension:prf"] ? "supported" : "unsupported";
  } catch {
    /* fall through */
  }
  return "unknown";
}

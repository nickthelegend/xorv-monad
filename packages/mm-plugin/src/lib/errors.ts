/**
 * The plugin's own failure type.
 *
 * Everything under `lib/` is plain TypeScript with no dependency on the host
 * CLI, so it can be unit-tested without booting `mm`. A failure still needs
 * the three things MetaMask's `CommandError` carries — a stable code an agent
 * can branch on, a message, and a hint that says what to do next — so the lib
 * throws this, and each command converts it at the boundary
 * (`toCommandError` in `host.ts`).
 */
export class XorvPluginError extends Error {
  readonly code: XorvErrorCode;
  readonly hint: string;

  constructor(code: XorvErrorCode, message: string, hint: string) {
    super(message);
    this.name = "XorvPluginError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Every code the plugin can fail with. Documented in the README and the
 * companion skill, so an agent can react (top up, re-quote, approve in the
 * MetaMask app) without parsing prose.
 */
export type XorvErrorCode =
  | "XORV_INVALID_INPUT"
  | "XORV_BROKER_UNREACHABLE"
  | "XORV_BROKER_ERROR"
  | "XORV_NO_PROVIDERS"
  | "XORV_UNSUPPORTED_NETWORK"
  | "XORV_QUOTE_REFUSED"
  | "XORV_NO_WALLET"
  | "XORV_INSUFFICIENT_USDC"
  | "XORV_SIGNATURE_DENIED"
  | "XORV_SIGNATURE_PENDING"
  | "XORV_SIGNER_MISMATCH"
  | "XORV_PAYMENT_REFUSED"
  | "XORV_JOB_FAILED"
  | "XORV_JOB_TIMEOUT"
  | "XORV_RATING_REFUSED";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

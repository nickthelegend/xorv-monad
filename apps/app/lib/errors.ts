/**
 * Recognising "the user said no".
 *
 * Declining a signature is a decision, not a failure: the UI should say
 * "nothing was paid" quietly rather than print a stack trace in red. Wallets
 * disagree on how to say it — EIP-1193 code 4001, viem's
 * `UserRejectedRequestError`, Privy closing its modal, a bare string from an
 * extension — and x402's fetch wrapper then flattens whatever it got into
 * `Failed to create payment payload: <message>`. So this checks the code and
 * the name on the whole `cause` chain, and falls back to the message text.
 */

const REJECTION_TEXT =
  /user rejected|user denied|rejected the request|request rejected|user cancel|cancelled by user|canceled by user|user closed|closed the modal|declined/i;

function* causes(err: unknown): Generator<unknown> {
  let current: unknown = err;
  for (let depth = 0; current && depth < 8; depth += 1) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

export function isUserRejection(err: unknown): boolean {
  for (const link of causes(err)) {
    const code = (link as { code?: unknown }).code;
    const name = (link as { name?: unknown }).name;
    if (code === 4001 || code === "ACTION_REJECTED") return true;
    if (name === "UserRejectedRequestError") return true;
    const message = link instanceof Error ? link.message : typeof link === "string" ? link : "";
    if (REJECTION_TEXT.test(message)) return true;
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

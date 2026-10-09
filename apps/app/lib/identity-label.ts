import type { IdentityStatus } from "./api";

/** A badge must not convert missing, failed or old reads into a verified claim. */
export function identityLabel(status: IdentityStatus | null, failed: boolean, now: number) {
  if (failed) return { label: "Identity check unavailable", verified: false };
  if (!status) return { label: "Checking identity…", verified: false };
  if (!status.gate) return { label: "Identity gate not configured", verified: false };
  // `now` is the page's clock, read on a timer; 0 until its first tick.
  if (now === 0) return { label: "Checking identity…", verified: false };
  // A check made a moment after the page's clock last ticked is fresh, not "in the future":
  // only a check more than a minute old, or implausibly far ahead (clock skew), needs a refresh.
  if (status.checkedAt === null || now - status.checkedAt > 60_000 || status.checkedAt - now > 60_000) {
    return { label: "Identity check needs refresh", verified: false };
  }
  if (status.verified === true) return { label: "Cleanverse verified", verified: true };
  if (status.verified === false) return { label: "No active Cleanverse A-Pass", verified: false };
  return { label: "Identity not checked", verified: false };
}

import type { IdentityStatus } from "./api";

/** A badge must not convert missing, failed or old reads into a verified claim. */
export function identityLabel(status: IdentityStatus | null, failed: boolean, now: number) {
  if (failed) return { label: "Identity check unavailable", verified: false };
  if (!status) return { label: "Checking identity…", verified: false };
  if (!status.gate) return { label: "Identity gate not configured", verified: false };
  if (status.checkedAt === null || now - status.checkedAt > 60_000 || status.checkedAt > now) return { label: "Identity check needs refresh", verified: false };
  if (status.verified === true) return { label: "Cleanverse verified", verified: true };
  if (status.verified === false) return { label: "No active Cleanverse A-Pass", verified: false };
  return { label: "Identity not checked", verified: false };
}

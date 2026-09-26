/**
 * Which x402 facilitator settles this broker's payments.
 *
 * The facilitator is whoever submits a buyer's signed EIP-3009 authorization
 * and pays the MON gas for it. Self-hosting it (the default when there is a
 * key) keeps settlement independent of anyone else's uptime; the hosted one
 * Monad's docs use needs no key at all, which is what lets a fresh checkout
 * take real payments before its operator has funded anything.
 *
 * The one thing this refuses to do is change an *explicit* choice silently.
 * `XORV_FACILITATOR=self` with no key to self-host with does not quietly
 * become "hosted" — which party moves settlement gas, and sees every payment,
 * is a decision. The paid route answers 503 with the fix instead. Only when
 * nothing was configured at all does the broker pick hosted, and it says so at
 * boot.
 */

import type { FacilitatorClient } from "@x402/core/server";
import { buildFacilitator, networkConfig } from "@xorv/protocol";
import type { BrokerConfig } from "./config.js";

export interface FacilitatorResolution {
  /** Null when payments are unavailable; the paid route then answers 503. */
  facilitator: FacilitatorClient | null;
  mode: "self" | "hosted";
  description: string;
  /** The EOA paying settlement gas when self-hosted. */
  address: string | null;
  url: string | null;
  /** Why `facilitator` is null, phrased as the fix. */
  unavailableReason: string | null;
  /** A boot-time notice worth printing (e.g. "no key, fell back to hosted"). */
  notice: string | null;
}

export function resolveFacilitator(
  config: Pick<BrokerConfig, "network" | "facilitatorMode" | "facilitatorAccount">,
  opts: { injected?: FacilitatorClient; log?: (line: string) => void } = {},
): FacilitatorResolution {
  if (opts.injected) {
    return {
      facilitator: opts.injected,
      mode: "self",
      description: "injected (test)",
      address: config.facilitatorAccount?.address ?? null,
      url: null,
      unavailableReason: null,
      notice: null,
    };
  }

  const cfg = networkConfig(config.network);
  const explicit = config.facilitatorMode;
  const mode = explicit ?? (config.facilitatorAccount ? "self" : "hosted");

  if (mode === "self" && !config.facilitatorAccount) {
    return {
      facilitator: null,
      mode: "self",
      description: "self-hosted (unavailable: no key)",
      address: null,
      url: null,
      unavailableReason:
        "payments are disabled: XORV_FACILITATOR=self needs XORV_FACILITATOR_KEY (or XORV_OPERATOR_KEY) " +
        `funded with MON — or set XORV_FACILITATOR=hosted to use ${cfg.facilitatorUrl}`,
      notice: null,
    };
  }

  const choice = buildFacilitator({
    mode,
    network: config.network,
    account: config.facilitatorAccount,
    log: opts.log,
  });
  return {
    facilitator: choice.facilitator,
    mode: choice.mode,
    description: choice.description,
    address: choice.address,
    url: choice.url,
    unavailableReason: null,
    notice:
      explicit === null && choice.mode === "hosted"
        ? `no facilitator key configured — settling through the hosted facilitator (${choice.url}). ` +
          "Set XORV_FACILITATOR_KEY to self-host settlement."
        : null,
  };
}

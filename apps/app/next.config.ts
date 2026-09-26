import type { NextConfig } from "next";

/**
 * No special bundling rules.
 *
 * The Hedera build had to keep its SDK out of the server bundle because a
 * bundled Hiero signed subtly wrong. Nothing on the Monad path needs that:
 * viem, `@x402/*` and `@xorv/protocol` are plain ESM with no native modules,
 * and a payment is an EIP-712 signature whose bytes do not depend on how the
 * code that produced it was packaged. The demo route (`/api/pay`) and the
 * browser wallet path run the same `payQuote`, bundled the ordinary way.
 */
const nextConfig: NextConfig = {};

export default nextConfig;

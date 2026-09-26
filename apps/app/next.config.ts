import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep the Hedera and x402 packages out of the server bundle.
   *
   * `/api/pay` signs a real Hedera transaction. The Hiero SDK reaches for
   * protobuf builders, node crypto and gRPC at runtime, and bundling it
   * produces a module that loads fine and then signs *subtly wrong* — the
   * broker's facilitator rejects the signature and every payment comes back
   * 402, with nothing in the logs to say why. Loading these from node_modules
   * instead makes the route behave exactly like the CLI, which is the reference
   * implementation of the same flow.
   */
  serverExternalPackages: [
    "@hiero-ledger/sdk",
    "@hiero-ledger/proto",
    "@x402/hedera",
    "@x402/core",
    "@x402/fetch",
  ],
};

export default nextConfig;

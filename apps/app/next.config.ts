import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Keep the x402 packages out of the server bundle.
   *
   * `/api/pay` signs a real EIP-3009 authorization for the demo payer. Bundled,
   * `@x402/*` loads fine and then signs *subtly wrong* — the broker's
   * facilitator rejects the signature and every payment comes back 402, with
   * nothing in the logs to say why. Loading these from node_modules instead
   * makes the route behave exactly like the CLI, which is the reference
   * implementation of the same flow.
   */
  serverExternalPackages: ["@x402/core", "@x402/evm", "@x402/fetch"],
};

export default nextConfig;

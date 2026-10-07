import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // config.yaml is parsed (with env interpolation) when the test indexer starts, so a
    // realistic ledger address here makes srcAddress/clientAddress checks meaningful
    // instead of everything defaulting to the zero address. No network is touched:
    // every test feeds events through the `simulate` source.
    //
    // lib/trust.ts reads the same variables, so the configured ledger and verifier count
    // as trusted feedback clients even before any XorvLedger event is indexed.
    env: {
      ENVIO_XORV_LEDGER_ADDRESS: "0x1ed9e7c0a5f4c3b2a19d8e7f6a5b4c3d2e1f0a9b",
      ENVIO_XORV_ESCROW_ADDRESS: "0xe5c0000000000000000000000000000000000e5c",
      ENVIO_XORV_VERIFIER_ADDRESSES: "0x00000000000000000000000000000000000000ee",
      ENVIO_TUI: "false",
    },
  },
});

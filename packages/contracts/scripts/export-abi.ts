/**
 * Writes abi/XorvLedger.json, the committed copy of XorvLedger's ABI.
 *
 * Other workspaces don't compile Solidity: packages/protocol hand-writes XORV_LEDGER_ABI and the
 * Envio indexer reads an ABI file, and both are checked against this one. It is a plain JSON ABI
 * array (what Envio's abi_file_path and viem's parseAbi-free imports expect), pretty-printed so a
 * contract change shows up as a readable diff. test/abi.test.ts fails when this file is stale.
 *
 *   pnpm --filter @xorv/contracts abi
 */
import { mkdir, writeFile } from "node:fs/promises";

import hre from "hardhat";

import { ABI_PATH, formatAbi } from "./lib/abi-file.js";

const artifact = await hre.artifacts.readArtifact("XorvLedger");
await mkdir(new URL(".", ABI_PATH), { recursive: true });
await writeFile(ABI_PATH, formatAbi(artifact.abi));

const counts = { function: 0, event: 0, error: 0 } as Record<string, number>;
for (const item of artifact.abi) counts[item.type] = (counts[item.type] ?? 0) + 1;
console.log(
  `Wrote abi/XorvLedger.json: ${counts.function} functions, ${counts.event} events, ${counts.error} errors.`,
);

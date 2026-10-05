/**
 * Regenerate the TypeScript ABI modules from the Foundry build output, so the
 * broker, CLI and app can never drift from the deployed contracts' interface.
 *
 *   pnpm gen:abi
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const root = new URL("..", import.meta.url);
execSync("forge build -q", { cwd: new URL("contracts/", root), stdio: "inherit" });

const targets = [
  ["XorvEscrow", "XORV_ESCROW_ABI", "xorv-escrow.abi.ts"],
];

for (const [contract, name, file] of targets) {
  const { abi } = JSON.parse(
    readFileSync(new URL(`contracts/out/${contract}.sol/${contract}.json`, root), "utf8"),
  );
  const body =
    `/**\n * GENERATED from contracts/src/${contract}.sol — do not edit by hand.\n` +
    ` * Regenerate: pnpm gen:abi (runs forge build, then scripts/gen-abi.mjs).\n */\n` +
    `export const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  writeFileSync(new URL(`packages/protocol/src/${file}`, root), body);
  console.log(`wrote packages/protocol/src/${file} (${abi.length} entries)`);
}

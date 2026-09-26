// Mark the built entry executable so `npx @xorv/mcp` and a global install can
// run it directly through its shebang.
//
// This replaces a bare `chmod +x` in the build script: pnpm runs scripts
// through cmd.exe on Windows, where `chmod` does not exist and the whole build
// failed on its last step. Windows has no executable bit to set (npm writes a
// .cmd shim for the bin instead), so there the call is a harmless no-op.
import { chmodSync, existsSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/make-executable.mjs <file>...");
  process.exit(1);
}
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`make-executable: ${file} does not exist — did tsc run?`);
    process.exit(1);
  }
  chmodSync(file, 0o755);
}

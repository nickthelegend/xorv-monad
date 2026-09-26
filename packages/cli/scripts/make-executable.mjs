#!/usr/bin/env node
/**
 * Mark the built CLI entry executable, so `npm i -g` and `pnpm link` produce a
 * `xorv` that runs straight from a POSIX shell.
 *
 * This replaces a bare `chmod +x` in the build script, which failed the whole
 * build on Windows: pnpm runs package scripts through cmd.exe there, and cmd
 * has no `chmod`. On win32 there is nothing to do — npm writes `.cmd`/`.ps1`
 * shims that invoke node explicitly, and NTFS has no execute bit to set — so
 * this is a deliberate no-op rather than an error.
 */

import fs from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: make-executable.mjs <file>...");
  process.exit(2);
}

if (process.platform !== "win32") {
  for (const file of files) {
    // Add the execute bits alongside whatever read/write bits the file has.
    const mode = fs.statSync(file).mode & 0o777;
    fs.chmodSync(file, mode | 0o111);
  }
}

/**
 * @xorv/protocol is published alongside the CLI, MCP server and MetaMask
 * plugin that depend on it, so its npm page must name this repository (the
 * root package.json's), not the Hedera prototype (nickthelegend/xorv) that
 * Xorv was ported from and that has none of the Monad work. The package has
 * no README of its own, so its homepage is the repository's.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageJson {
  homepage?: string;
  repository?: { type: string; url: string; directory?: string };
  bugs?: string;
}

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as PackageJson;
const pkg = read(join(pkgDir, "package.json"));
const root = read(join(pkgDir, "..", "..", "package.json"));
const repo = "https://github.com/nickthelegend/xorv-monad";

describe("package metadata", () => {
  it("points repository, homepage and bugs at this repository", () => {
    expect(root.repository?.url).toBe(`git+${repo}.git`);
    expect(pkg.repository).toEqual({ type: "git", url: root.repository?.url, directory: "packages/protocol" });
    expect(pkg.homepage).toBe(root.homepage);
    expect(pkg.bugs).toBe(`${repo}/issues`);
    expect(JSON.stringify(pkg)).not.toMatch(/github\.com\/nickthelegend\/xorv(?!-monad)/);
  });
});

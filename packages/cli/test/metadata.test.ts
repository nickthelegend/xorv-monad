/**
 * npm's package page and `xorv --help` are where people go looking for the
 * source. Both must name this repository, not the Hedera prototype
 * (nickthelegend/xorv) that Xorv was ported from and that has none of the
 * Monad work. The root package.json is the reference.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_URL } from "../src/links.js";

interface PackageJson {
  homepage?: string;
  repository?: { type: string; url: string; directory?: string };
  bugs?: string;
}

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as PackageJson;
const pkg = read(join(pkgDir, "package.json"));
const root = read(join(pkgDir, "..", "..", "package.json"));

/** Any link to the prototype repo: `nickthelegend/xorv` not followed by `-monad`. */
const PROTOTYPE_REPO = /github\.com\/nickthelegend\/xorv(?!-monad)/;

describe("package metadata", () => {
  it("points repository, homepage and bugs at this repository", () => {
    expect(root.repository?.url).toBe(`git+${REPO_URL}.git`);
    expect(pkg.repository).toEqual({ type: "git", url: root.repository?.url, directory: "packages/cli" });
    expect(pkg.homepage).toBe(`${REPO_URL}#readme`);
    expect(pkg.bugs).toBe(`${REPO_URL}/issues`);
  });

  it("links nothing in the CLI's source to the Hedera prototype", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && PROTOTYPE_REPO.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(join(pkgDir, "src"));
    expect(offenders).toEqual([]);
    expect(PROTOTYPE_REPO.test(JSON.stringify(pkg))).toBe(false);
  });
});

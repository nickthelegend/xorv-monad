import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * What npm serves as `@xorv/cli` today is 0.1.0, the pre-port Hedera
 * prototype: a node the Monad broker can neither register nor pay. And
 * `@xorv/mm-plugin` isn't on npm at all. Until 0.2.0 is published, nothing
 * the app shows may tell a visitor to install either from npm; the "No
 * providers online" empty state points at the from-source provider guide.
 */

const root = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(rel);
    return /\.(tsx?|mdx?)$/.test(entry.name) ? [rel] : [];
  });
}

describe("install instructions in the app", () => {
  it("never tell anyone to install the unpublished packages from npm", () => {
    const files = [...sources("app"), ...sources("components"), ...sources("lib")];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toMatch(/npm (i|install) (-g |--global )?@xorv\/cli(?!@\^?0\.2)/);
      expect(text, file).not.toMatch(/mm plugins install @xorv\/mm-plugin/);
    }
  });

  it("the empty provider list links to the from-source provider guide", () => {
    const text = fs.readFileSync(path.join(root, "components/live-lists.tsx"), "utf8");
    expect(text).toContain("https://github.com/nickthelegend/xorv-monad/tree/main/packages/cli#readme");
    expect(text).toMatch(/install the CLI from source/);
  });
});

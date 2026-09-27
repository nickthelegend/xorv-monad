/**
 * The agent skill shipped in `skills/xorv-metamask`.
 *
 * An agent follows it literally, so its install step has to be one that
 * works. `@xorv/mm-plugin` is not on npm yet: `mm plugins install
 * @xorv/mm-plugin` is a 404. Until it is published, the skill must send the
 * user to the local `file:` install (packages/mm-plugin/README.md) instead.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "..", "skills", "xorv-metamask", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");

describe("xorv-metamask skill", () => {
  it("never tells an agent to install the plugin from npm by name", () => {
    expect(skill).not.toMatch(/mm plugins install @xorv\/mm-plugin/);
  });

  it("gives the from-source install that works today, without accepting permissions for the user", () => {
    expect(skill).toContain("pnpm --filter @xorv/mm-plugin build");
    expect(skill).toMatch(/mm plugins install "file:[^"]*packages\/mm-plugin"/);
    expect(skill).toContain("experimentalAllowUnverifiedInstalls");
    expect(skill).toMatch(/do not pass `--accept-permissions` for them/);
  });
});

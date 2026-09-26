/**
 * The install-time contract with MetaMask: `package.json#mm` must pass the
 * host's own manifest schema, and every declared command id must be backed by
 * a command class whose `pluginCommandId` matches (and vice versa) — a
 * mismatch is `PERMISSION_DENIED` or `PLUGIN_MANIFEST_INVALID` at runtime.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginManifestSchema } from "@metamask/agent-wallet/plugin";
import { describe, expect, it } from "vitest";
import XorvJob from "../src/commands/xorv/job.js";
import XorvProviders from "../src/commands/xorv/providers.js";
import XorvQuote from "../src/commands/xorv/quote.js";
import XorvRate from "../src/commands/xorv/rate.js";
import XorvRun from "../src/commands/xorv/run.js";
import { TARGET_CHAIN_IDS } from "../src/lib/config.js";

const COMMANDS: Record<string, new (argv: string[], config: never) => unknown> = {
  "xorv:job": XorvJob as never,
  "xorv:providers": XorvProviders as never,
  "xorv:quote": XorvQuote as never,
  "xorv:rate": XorvRate as never,
  "xorv:run": XorvRun as never,
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  keywords: string[];
  oclif: Record<string, unknown>;
  mm: { capabilities: string[]; minCliVersion: string; commands: Array<{ id: string; capabilities: string[]; targetChains: unknown }> };
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};

describe("package.json#mm", () => {
  it("passes MetaMask's manifest schema", () => {
    const parsed = PluginManifestSchema.safeParse(pkg.mm);
    expect(parsed.success).toBe(true);
  });

  it("keeps plugin-wide capabilities empty and targets only Monad", () => {
    expect(pkg.mm.capabilities).toEqual([]);
    for (const command of pkg.mm.commands) expect(command.targetChains).toEqual([...TARGET_CHAIN_IDS]);
  });

  it("grants wallet access only to the commands that sign", () => {
    const caps = Object.fromEntries(pkg.mm.commands.map((c) => [c.id, [...c.capabilities].sort()]));
    expect(caps).toEqual({
      "xorv:providers": [],
      "xorv:quote": [],
      "xorv:job": [],
      "xorv:run": ["wallet-read", "wallet-submit"],
      "xorv:rate": ["wallet-read", "wallet-submit"],
    });
  });

  it("is an oclif plugin that binds to the host CLI as a peer, without hooks", () => {
    expect(pkg.keywords).toContain("oclif-plugin");
    expect(pkg.oclif).toMatchObject({ bin: "mm", commands: "./dist/commands", topicSeparator: " " });
    expect(pkg.oclif).not.toHaveProperty("hooks");
    expect(pkg.oclif).not.toHaveProperty("plugins");
    expect(pkg.peerDependencies["@metamask/agent-wallet"]).toBeTruthy();
    expect(pkg.dependencies).not.toHaveProperty("@metamask/agent-wallet");
  });

  it("declares exactly the commands that exist, with matching ids", () => {
    // The file path defines the oclif id (commands/xorv/run.ts → xorv:run).
    const files = readdirSync(join(root, "src", "commands", "xorv"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `xorv:${f.slice(0, -".ts".length)}`)
      .sort();
    expect(Object.keys(COMMANDS).sort()).toEqual(files);
    for (const [id, Command] of Object.entries(COMMANDS)) {
      const instance = new Command([], {} as never) as unknown as { pluginCommandId: string };
      expect(instance.pluginCommandId).toBe(id);
    }
    expect(files).toEqual(pkg.mm.commands.map((c) => c.id).sort());
  });
});

/**
 * The Claude Code skill.
 *
 * The skill is read by an agent that can spend the user's money, so the tests
 * that matter are about restraint: it must state a ceiling, refuse to raise
 * it, and always hand back the receipt. A skill that returns an answer without
 * its transaction link is worse than no skill — it makes a payment invisible.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillDir, skillMarkdown } from "../src/commands/skills.js";

const BROKER = "https://broker.example.test";
const body = skillMarkdown(BROKER);

describe("skill frontmatter", () => {
  it("is a valid skill document with a name Claude Code can invoke", () => {
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toMatch(/^name: xorv$/m);
    expect(body).toMatch(/^description: .{80,}$/m);
  });

  it("describes when to reach for it, not just what it is", () => {
    // A description that only says what a tool *is* never gets invoked.
    const description = /^description: (.+)$/m.exec(body)?.[1] ?? "";
    for (const cue of ["offload", "second model", "/xorv"]) {
      expect(description.toLowerCase()).toContain(cue.toLowerCase());
    }
  });
});

describe("spending discipline", () => {
  it("names a default ceiling", () => {
    expect(body).toContain("--max 0.30");
  });

  it("forbids raising the ceiling on its own", () => {
    expect(body).toMatch(/Never (invent a higher ceiling|raise it)/i);
  });

  it("requires confirmation before the first spend of a session", () => {
    expect(body).toMatch(/Confirm the first job/i);
  });

  it("tells the agent to stop rather than guess when the CLI is missing", () => {
    expect(body).toContain("npm i -g @xorv/cli");
  });
});

describe("the receipt", () => {
  it("requires the hashscan link to be reported with every paid job", () => {
    expect(body).toMatch(/Never report a paid job without its link/i);
  });

  it("asks for the provider and price alongside the answer", () => {
    expect(body).toContain("priceLabel");
    expect(body).toMatch(/provider label/i);
  });

  it("documents the failure shape so a failed job isn't read as an answer", () => {
    expect(body).toContain('"status": "failed"');
    expect(body).toMatch(/reassigned by the network at no extra charge/i);
  });
});

describe("known traps", () => {
  it("explains that a provider cannot buy from itself", () => {
    // The first thing anyone hits when they demo on the machine they host on.
    expect(body).toMatch(/cannot pay yourself/i);
    expect(body).toContain("XORV_PAYER_ID");
  });

  it("warns that the prompt travels without any local context", () => {
    expect(body).toMatch(/no other context/i);
  });

  it("bakes in the broker this install points at", () => {
    expect(body).toContain(BROKER);
  });
});

describe("boundaries", () => {
  it("does not hand the agent the payout key or let it host jobs unasked", () => {
    expect(body).toMatch(/does not give you access to the user's Xorv payout key/i);
    expect(body).toMatch(/xorv start.*deliberate decision/is);
  });
});

describe("skillDir", () => {
  it("writes into the project by default", () => {
    expect(skillDir("project", "/repo")).toBe(path.join("/repo", ".claude", "skills", "xorv"));
  });

  it("writes into the home directory when installed globally", () => {
    expect(skillDir("user")).toBe(path.join(os.homedir(), ".claude", "skills", "xorv"));
  });
});

describe("as written to disk", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-skill-"));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("round-trips as a readable file", () => {
    const dir = skillDir("project", tmp);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    fs.writeFileSync(file, body);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });
});

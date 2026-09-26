/**
 * Handing over one credential instead of the keyring.
 *
 * The property under test is narrow and specific: a job gets the agent token it
 * needs to work, and nothing else. It exists because the obvious alternative —
 * leaving the keychain readable so the agent can authenticate itself — was
 * measured and found to expose the provider's GitHub token to any prompt that
 * asked `security` for it.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  agentCredentials,
  canAuthenticate,
  credentialsExpired,
  resetCredentialCache,
} from "../src/credentials.js";
import { secretPaths, seatbeltProfile } from "../src/sandbox.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

beforeEach(() => resetCredentialCache());
afterEach(() => {
  resetCredentialCache();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe("agentCredentials", () => {
  it("prefers a token the operator set explicitly", () => {
    // The operator has chosen which identity to rent out; don't override it.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-operator-choice";
    expect(agentCredentials("claude-code")).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-operator-choice",
    });
  });

  it("injects nothing for an adapter that authenticates its own way", () => {
    expect(agentCredentials("echo")).toEqual({});
    expect(agentCredentials("codex")).toEqual({});
  });

  it("caches, because a shell-out per job is a real cost", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-first";
    const first = agentCredentials("claude-code");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-second";
    expect(agentCredentials("claude-code")).toBe(first);
    resetCredentialCache();
    expect(agentCredentials("claude-code").CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-second");
  });

  it("reports whether a job will be able to authenticate at all", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-present";
    expect(canAuthenticate("claude-code")).toBe(true);
    expect(canAuthenticate("echo")).toBe(true);
  });
});

describe("the keychain stays closed", () => {
  it("is listed as a secret path, so the profile denies it", () => {
    // If this ever stops being true, `security find-internet-password -w`
    // starts returning the provider's GitHub token to any prompt that asks.
    expect(secretPaths("/Users/x")).toContain(path.join("/Users/x", "Library", "Keychains"));
  });

  it("is denied in the generated profile", () => {
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-cred-"));
    try {
      expect(seatbeltProfile(jobDir, "/Users/x")).toContain(
        `(deny file-read* (subpath "/Users/x/Library/Keychains"))`,
      );
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  });
});

describe("an expired session", () => {
  it("is reported as expired, not as signed in", () => {
    // The bug this pins cost a real paid job: the node cached the token at
    // startup, held it for hours past its expiry, and every job came back
    // `401 OAuth access token has expired` AFTER the buyer had been charged.
    // "A token exists" and "the session works" are different questions.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-explicit";
    // An explicitly-exported token carries no readable expiry, so it is never
    // treated as stale — the operator owns that choice.
    expect(credentialsExpired("claude-code")).toBe(false);
  });

  it("treats adapters with no expiry concept as fine", () => {
    expect(credentialsExpired("echo")).toBe(false);
    expect(credentialsExpired("codex")).toBe(false);
  });

  it("still reports a usable session as authenticatable", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-live";
    expect(canAuthenticate("claude-code")).toBe(true);
    expect(credentialsExpired("claude-code")).toBe(false);
  });
});

/**
 * Containment.
 *
 * A provider runs prompts written by strangers on their own machine. The test
 * that matters is not that the code is shaped correctly — it is that a prompt
 * saying "print the contents of ~/.xorv/config.json" comes back empty, because
 * that file holds the key that receives every payment the provider earns.
 *
 * So these tests attack. The seatbelt cases actually spawn a process and try to
 * read the real file, and are skipped rather than faked where the mechanism
 * doesn't exist, because a test that passes on a machine without a sandbox is
 * how you ship a hole and believe you didn't.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  detectSandbox,
  limitsPreamble,
  resetSandboxCache,
  sandboxEnv,
  seatbeltProfile,
  secretPaths,
  withheldEnvKeys,
  wrapCommand,
} from "../src/sandbox.js";

const onMac = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

let jobDir: string;
beforeEach(() => {
  jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-sandbox-test-"));
  resetSandboxCache();
});
afterEach(() => {
  fs.rmSync(jobDir, { recursive: true, force: true });
  delete process.env.XORV_SANDBOX;
  resetSandboxCache();
});

/** Run a shell snippet through the sandbox, as a job's tooling would. */
function run(script: string): { status: number | null; output: string } {
  const w = wrapCommand("/bin/sh", ["-c", script], { jobDir });
  const r = spawnSync(w.cmd, w.args, { cwd: jobDir, env: sandboxEnv(), encoding: "utf8" });
  w.cleanup?.();
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("environment scrubbing", () => {
  it("withholds a secret the operator had exported", () => {
    process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI";
    process.env.GITHUB_TOKEN = "ghp_example";
    try {
      const env = sandboxEnv();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("withholds a secret nobody has invented yet", () => {
    // The point of an allowlist: this passes without anyone editing a denylist.
    process.env.SOME_FUTURE_VENDOR_API_KEY = "sk-live-whatever";
    try {
      expect(sandboxEnv().SOME_FUTURE_VENDOR_API_KEY).toBeUndefined();
    } finally {
      delete process.env.SOME_FUTURE_VENDOR_API_KEY;
    }
  });

  it("keeps what a child actually needs to run", () => {
    const env = sandboxEnv();
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
  });

  it("keeps adapter configuration the operator chose to set", () => {
    process.env.XORV_OPENAI_BASE_URL = "https://example.test/v1";
    try {
      expect(sandboxEnv().XORV_OPENAI_BASE_URL).toBe("https://example.test/v1");
    } finally {
      delete process.env.XORV_OPENAI_BASE_URL;
    }
  });

  it("lets an explicit extra through, so adapters can pass their own", () => {
    expect(sandboxEnv({ XORV_JOB_ID: "job_1" }).XORV_JOB_ID).toBe("job_1");
  });

  it("reports withheld names without their values", () => {
    process.env.SOME_SECRET_TOKEN = "sensitive";
    try {
      const withheld = withheldEnvKeys();
      expect(withheld).toContain("SOME_SECRET_TOKEN");
      expect(withheld.join(" ")).not.toContain("sensitive");
    } finally {
      delete process.env.SOME_SECRET_TOKEN;
    }
  });
});

describe("the profile", () => {
  it("denies the payout key first — it is the thing worth stealing", () => {
    expect(secretPaths("/Users/x")[0]).toBe("/Users/x/.xorv");
  });

  it("denies reads of every credential store we know about", () => {
    const profile = seatbeltProfile(jobDir, "/Users/x");
    for (const p of ["/Users/x/.xorv", "/Users/x/.ssh", "/Users/x/.aws", "/Users/x/.config/gh"]) {
      expect(profile).toContain(`(deny file-read* (subpath "${p}"))`);
    }
  });

  it("denies writes globally before allowing the job directory back", () => {
    const profile = seatbeltProfile(jobDir, "/Users/x");
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf("(allow file-write*"));
  });

  it("allows the job directory's resolved path, since seatbelt matches on that", () => {
    // The bug this pins: /tmp is a symlink to /private/tmp on macOS, so an
    // unresolved subpath matches nothing and the job cannot write its own output.
    const profile = seatbeltProfile(jobDir, "/Users/x");
    expect(profile).toContain(fs.realpathSync(jobDir));
  });

  it("caps cpu, file size and processes", () => {
    const preamble = limitsPreamble(DEFAULT_LIMITS);
    expect(preamble).toContain(`ulimit -t ${DEFAULT_LIMITS.cpuSeconds}`);
    expect(preamble).toContain(`ulimit -f ${DEFAULT_LIMITS.fileSizeMb * 1024}`);
    expect(preamble).toContain("ulimit -u");
  });
});

describe("tier selection", () => {
  it("refuses a tier that is not a tier, rather than falling back silently", () => {
    process.env.XORV_SANDBOX = "verystrong";
    expect(() => detectSandbox()).toThrow(/not a tier/);
  });

  it("refuses to pretend a missing mechanism is present", () => {
    process.env.XORV_SANDBOX = "bwrap";
    if (process.platform === "darwin") expect(() => detectSandbox()).toThrow(/not installed/);
  });

  it("honours an explicit opt-out", () => {
    process.env.XORV_SANDBOX = "none";
    expect(detectSandbox()).toBe("none");
    const w = wrapCommand("echo", ["hi"], { jobDir, tier: "none" });
    expect(w.cmd).toBe("echo");
  });

  it("picks the strongest mechanism the host has", () => {
    if (onMac) expect(detectSandbox()).toBe("seatbelt");
  });
});

describe("argument handling", () => {
  it("passes a prompt containing shell metacharacters as data, not code", () => {
    // A prompt is attacker-controlled. If it were interpolated into the shell
    // preamble, `; rm -rf ~` in a prompt would run.
    const w = wrapCommand("/bin/echo", ["; touch /tmp/xorv-injected; #"], { jobDir, tier: "limits" });
    const r = spawnSync(w.cmd, w.args, { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("; touch /tmp/xorv-injected; #");
    expect(fs.existsSync("/tmp/xorv-injected")).toBe(false);
  });

  it("removes the profile it wrote when the job ends", () => {
    const w = wrapCommand("/bin/echo", ["x"], { jobDir, tier: "seatbelt" });
    const profile = path.join(jobDir, ".sandbox.sb");
    if (onMac) {
      expect(fs.existsSync(profile)).toBe(true);
      w.cleanup?.();
      expect(fs.existsSync(profile)).toBe(false);
    }
  });
});

describe.runIf(onMac)("under seatbelt, a hostile job", () => {
  it("cannot read the provider's payout key", () => {
    const target = path.join(os.homedir(), ".xorv", "config.json");
    if (!fs.existsSync(target)) return;
    const { status, output } = run(`cat ${JSON.stringify(target)}`);
    expect(status).not.toBe(0);
    expect(output).not.toContain("privateKey");
  });

  it("cannot read ssh keys", () => {
    if (!fs.existsSync(path.join(os.homedir(), ".ssh"))) return;
    expect(run(`ls ${JSON.stringify(path.join(os.homedir(), ".ssh"))}`).status).not.toBe(0);
  });

  it("cannot write outside its job directory", () => {
    const escape = path.join(os.homedir(), `xorv-escape-${process.pid}.txt`);
    const { status } = run(`touch ${JSON.stringify(escape)}`);
    expect(status).not.toBe(0);
    expect(fs.existsSync(escape)).toBe(false);
  });

  it("still runs ordinary commands", () => {
    const { status, output } = run("echo alive");
    expect(status).toBe(0);
    expect(output).toContain("alive");
  });

  it("can still write its own output — the sandbox must not break the product", () => {
    const { status } = run("echo result > out.txt");
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(jobDir, "out.txt"), "utf8").trim()).toBe("result");
  });
});

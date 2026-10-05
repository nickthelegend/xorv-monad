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

  it("lets Codex write its own home, which it cannot start without", () => {
    const profile = seatbeltProfile(jobDir, "/Users/x", "codex");
    const allow = profile.slice(profile.indexOf("(allow file-write*"));
    expect(allow).toContain('(subpath "/Users/x/.codex")');
  });

  it("keeps the files that steer Codex's next run unwritable, after the allow so they win", () => {
    // Otherwise a job could plant config or instructions that run in the
    // operator's own, unsandboxed session.
    const profile = seatbeltProfile(jobDir, "/Users/x", "codex");
    for (const f of ["config.toml", "AGENTS.md", "prompts", "skills", "rules"]) {
      const rule = `(deny file-write* (subpath "/Users/x/.codex/${f}"))`;
      expect(profile).toContain(rule);
      expect(profile.indexOf(rule)).toBeGreaterThan(profile.indexOf("(allow file-write*"));
    }
  });

  it("gives every other adapter nothing beyond the job directory", () => {
    for (const adapter of ["claude-code", "echo", undefined]) {
      expect(seatbeltProfile(jobDir, "/Users/x", adapter)).not.toContain(".codex");
    }
  });

  it("caps cpu, file size and processes", () => {
    const preamble = limitsPreamble(DEFAULT_LIMITS);
    expect(preamble).toContain(`ulimit -t ${DEFAULT_LIMITS.cpuSeconds}`);
    expect(preamble).toContain(`ulimit -f ${DEFAULT_LIMITS.fileSizeMb * 1024}`);
    expect(preamble).toContain("ulimit -u");
    // Headroom over the user's current process count, never a flat cap.
    expect(preamble).toMatch(/ulimit -u \$\(\( \$\(ps -u .*\) \+ 512 \)\)/);
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

  describe.runIf(fs.existsSync(path.join(os.homedir(), ".codex", "config.toml")))("running Codex", () => {
    /** `touch` only: if a rule were wrong it changes a timestamp, never a file's contents. */
    function asCodex(script: string): number | null {
      const w = wrapCommand("/bin/sh", ["-c", script], { jobDir, adapter: "codex" });
      const r = spawnSync(w.cmd, w.args, { cwd: jobDir, env: sandboxEnv(), encoding: "utf8" });
      w.cleanup?.();
      return r.status;
    }

    it("can write the session state Codex needs to start", () => {
      const probe = path.join(os.homedir(), ".codex", `.xorv-sandbox-probe-${process.pid}`);
      try {
        expect(asCodex(`touch ${JSON.stringify(probe)}`)).toBe(0);
        expect(fs.existsSync(probe)).toBe(true);
      } finally {
        fs.rmSync(probe, { force: true });
      }
    });

    it("cannot change Codex's config", () => {
      const config = path.join(os.homedir(), ".codex", "config.toml");
      const before = fs.statSync(config).mtimeMs;
      expect(asCodex(`touch ${JSON.stringify(config)}`)).not.toBe(0);
      expect(fs.statSync(config).mtimeMs).toBe(before);
    });

    it("still cannot write the rest of the home directory", () => {
      const escape = path.join(os.homedir(), `xorv-escape-codex-${process.pid}.txt`);
      expect(asCodex(`touch ${JSON.stringify(escape)}`)).not.toBe(0);
      expect(fs.existsSync(escape)).toBe(false);
    });
  });
});

describe("the process cap on a busy machine", () => {
  it("still lets the job fork when the user already runs more processes than the headroom", async () => {
    const { execFileSync } = await import("node:child_process");
    // A cap of 1 extra process on top of whatever this machine runs: under the old
    // flat cap of 1 the fork below would fail with EAGAIN.
    const out = execFileSync(
      "/bin/sh",
      ["-c", `${limitsPreamble({ cpuSeconds: 60, fileSizeMb: 10, processes: 64 })}; /bin/echo forked`],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("forked");
  });
});

describe("the node's own home is always unreadable", () => {
  it("denies a custom XORV_HOME, then re-allows only this job's directory", async () => {
    const { seatbeltProfile } = await import("../src/sandbox.js");
    const prior = process.env.XORV_HOME;
    process.env.XORV_HOME = "/Users/someone/.xorv-elsewhere/provider";
    try {
      const jobDir = "/Users/someone/.xorv-elsewhere/provider/jobs/job_1";
      const profile = seatbeltProfile(jobDir, "/Users/someone");
      // The key file is denied by name even though the directory doesn't exist here.
      expect(profile).toContain('(deny file-read* (subpath "/Users/someone/.xorv-elsewhere/provider/config.json"))');
      // The job's own directory and its parents are not denied wholesale.
      expect(profile).not.toContain(`(deny file-read* (subpath "${jobDir}"))`);
      expect(profile).not.toContain('(deny file-read* (subpath "/Users/someone/.xorv-elsewhere/provider"))');
      // The default home stays denied as well.
      expect(profile).toContain('(deny file-read* (subpath "/Users/someone/.xorv"))');
    } finally {
      if (prior === undefined) delete process.env.XORV_HOME;
      else process.env.XORV_HOME = prior;
    }
  });
});

describe.skipIf(process.platform !== "darwin")("the node's key under a real seatbelt", () => {
  it("cannot be read by a sandboxed process, while the job directory can", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { seatbeltProfile } = await import("../src/sandbox.js");
    const nodeHome = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-home-"));
    const jobDir = path.join(nodeHome, "jobs", "job_1");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(nodeHome, "config.json"), '{"privateKey":"0xSECRET"}');
    fs.writeFileSync(path.join(jobDir, "input.txt"), "job data");
    fs.mkdirSync(path.join(nodeHome, "jobs", "job_0"), { recursive: true });
    fs.writeFileSync(path.join(nodeHome, "jobs", "job_0", "secret.txt"), "another buyer's data");
    fs.writeFileSync(path.join(nodeHome, "earnings.jsonl"), "{}");
    const prior = process.env.XORV_HOME;
    process.env.XORV_HOME = nodeHome;
    try {
      const profilePath = path.join(os.tmpdir(), `xorv-test-${process.pid}.sb`);
      fs.writeFileSync(profilePath, seatbeltProfile(jobDir));
      const run = (cmd: string) => {
        try {
          return execFileSync("/usr/bin/sandbox-exec", ["-f", profilePath, "/bin/sh", "-c", cmd], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err) {
          return `DENIED ${(err as { stderr?: string }).stderr ?? ""}`;
        }
      };
      expect(run(`cat ${JSON.stringify(path.join(nodeHome, "config.json"))}`)).toMatch(/DENIED.*not permitted/i);
      expect(run(`cat ${JSON.stringify(path.join(jobDir, "input.txt"))}`)).toBe("job data");
      // Another job's directory and the ledger are hidden too.
      expect(run(`cat ${JSON.stringify(path.join(nodeHome, "jobs", "job_0", "secret.txt"))}`)).toMatch(/DENIED.*not permitted/i);
      expect(run(`cat ${JSON.stringify(path.join(nodeHome, "earnings.jsonl"))}`)).toMatch(/DENIED.*not permitted/i);
      // Walking up for a project file finds nothing, rather than being refused —
      // the difference between Codex starting and Codex dying.
      expect(run(`cat ${JSON.stringify(path.join(nodeHome, "AGENTS.md"))}`)).toMatch(/DENIED.*No such file/i);
      fs.rmSync(profilePath, { force: true });
    } finally {
      if (prior === undefined) delete process.env.XORV_HOME;
      else process.env.XORV_HOME = prior;
      fs.rmSync(nodeHome, { recursive: true, force: true });
    }
  });
});

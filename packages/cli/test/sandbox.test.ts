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
 *
 * On Windows the POSIX-only cases are skipped, each saying why: seatbelt
 * profiles are written in POSIX paths (`/Users/x/...`), and the shell-quoting
 * test drives `/bin/sh` and `/bin/echo`, which do not exist there. CI runs
 * them on Linux and macOS.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentCredentials, resetCredentialCache } from "../src/credentials.js";
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
  xorvHomeDir,
} from "../src/sandbox.js";

const onMac = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
const onWindows = process.platform === "win32";

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

describe("sponsor-model keys stay with their own adapter", () => {
  const KEYS = {
    XORV_QWEN_API_KEY: "sk-qwen-secret",
    DASHSCOPE_API_KEY: "sk-dashscope-secret",
    XORV_KIMI_API_KEY: "sk-kimi-secret",
    MOONSHOT_API_KEY: "sk-moonshot-secret",
    XORV_HUNYUAN_API_KEY: "sk-hunyuan-secret",
    TOKENHUB_API_KEY: "sk-tokenhub-secret",
    OPENAI_API_KEY: "sk-operator-openai",
  };
  beforeEach(() => {
    Object.assign(process.env, KEYS);
    resetCredentialCache();
  });
  afterEach(() => {
    for (const key of Object.keys(KEYS)) delete process.env[key];
    delete process.env.XORV_QWEN_BASE_URL;
    resetCredentialCache();
  });

  it("never reaches a job through the global allowlist", () => {
    // A Claude Code job has no business being able to `echo $DASHSCOPE_API_KEY`.
    const env = sandboxEnv();
    for (const key of Object.keys(KEYS)) expect(env[key]).toBeUndefined();
    const withheld = withheldEnvKeys();
    for (const key of Object.keys(KEYS)) expect(withheld).toContain(key);
  });

  it("reaches qwen-code only as OPENAI_*, from the Qwen preset", () => {
    process.env.XORV_QWEN_BASE_URL = "https://dashscope-us.aliyuncs.com/compatible-mode/v1/";
    expect(agentCredentials("qwen-code")).toEqual({
      OPENAI_API_KEY: "sk-qwen-secret",
      OPENAI_BASE_URL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      OPENAI_MODEL: "qwen3.8-max",
    });
  });

  it("falls back to DASHSCOPE_API_KEY, and never to the operator's own OPENAI_API_KEY", () => {
    delete process.env.XORV_QWEN_API_KEY;
    expect(agentCredentials("qwen-code").OPENAI_API_KEY).toBe("sk-dashscope-secret");
    delete process.env.DASHSCOPE_API_KEY;
    expect(agentCredentials("qwen-code")).toEqual({});
  });

  it("is not handed to any other adapter's child", () => {
    for (const kind of ["claude-code", "codex", "grok", "opencode", "echo"] as const) {
      const creds = agentCredentials(kind);
      expect(Object.values(creds).join(" ")).not.toMatch(/sk-(qwen|dashscope|kimi|moonshot|hunyuan|tokenhub)/);
      expect(creds.OPENAI_API_KEY).toBeUndefined();
    }
  });
});

describe("secret paths follow XORV_HOME", () => {
  const home = path.resolve(os.tmpdir(), "xorv-fake-home");

  it("denies ~/.xorv first by default — it is the thing worth stealing", () => {
    expect(secretPaths(home, {})[0]).toBe(path.join(home, ".xorv"));
  });

  it("denies a relocated XORV_HOME first, and still denies the old ~/.xorv", () => {
    const moved = path.resolve(os.tmpdir(), "somewhere-else", "xorv");
    const paths = secretPaths(home, { XORV_HOME: moved });
    expect(paths[0]).toBe(moved);
    expect(paths).toContain(path.join(home, ".xorv"));
  });

  it("does not list the default home twice when XORV_HOME points at it", () => {
    const paths = secretPaths(home, { XORV_HOME: path.join(home, ".xorv") });
    expect(paths.filter((p) => p === path.join(home, ".xorv"))).toHaveLength(1);
  });

  it("resolves a relative XORV_HOME the same way the config module does", () => {
    expect(xorvHomeDir(home, { XORV_HOME: "rel/xorv" })).toBe(path.resolve("rel/xorv"));
  });
});

describe("the profile", () => {
  it.skipIf(onWindows)("denies the payout key first — it is the thing worth stealing (POSIX paths)", () => {
    expect(secretPaths("/Users/x", {})[0]).toBe("/Users/x/.xorv");
  });

  it.skipIf(onWindows)("denies a relocated XORV_HOME in the seatbelt profile (POSIX paths)", () => {
    process.env.XORV_HOME = "/srv/xorv-node";
    try {
      expect(seatbeltProfile(jobDir, "/Users/x")).toContain(`(deny file-read* (subpath "/srv/xorv-node"))`);
    } finally {
      delete process.env.XORV_HOME;
    }
  });

  it.skipIf(onWindows)("re-allows reading the job's own directory after the denies (POSIX paths)", () => {
    // The job directory lives under the denied Xorv home by default; seatbelt
    // applies the last matching rule, so the allow must come after the deny.
    const profile = seatbeltProfile(jobDir, "/Users/x");
    const deny = profile.indexOf('(deny file-read* (subpath "/Users/x/.xorv"))');
    const allow = profile.indexOf("(allow file-read*");
    expect(deny).toBeGreaterThan(0);
    expect(allow).toBeGreaterThan(deny);
    expect(profile.slice(allow)).toContain(JSON.stringify(jobDir));
  });

  it.skipIf(onWindows)("denies reads of every credential store we know about (POSIX paths)", () => {
    const profile = seatbeltProfile(jobDir, "/Users/x");
    for (const p of ["/Users/x/.xorv", "/Users/x/.ssh", "/Users/x/.aws", "/Users/x/.config/gh"]) {
      expect(profile).toContain(`(deny file-read* (subpath "${p}"))`);
    }
  });

  it.skipIf(onWindows)("denies writes globally before allowing the job directory back (POSIX paths)", () => {
    const profile = seatbeltProfile(jobDir, "/Users/x");
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf("(allow file-write*"));
  });

  it.skipIf(onWindows)("allows the job directory's resolved path, since seatbelt matches on that (POSIX paths)", () => {
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
  // Drives /bin/sh and /bin/echo, which Windows does not have — and wrapCommand
  // never goes through a shell there, so there is nothing to inject into.
  it.skipIf(onWindows)("passes a prompt containing shell metacharacters as data, not code (POSIX shell)", () => {
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

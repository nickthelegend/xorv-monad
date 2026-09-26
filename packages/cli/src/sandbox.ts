/**
 * Containing a job.
 *
 * A Xorv provider executes prompts written by strangers, on their own machine,
 * as their own user. Until this module existed the only containment was a fresh
 * working directory, which stops nothing: `cat ~/.xorv/config.json` reads the
 * provider's **payout private key**, and `cat ~/.aws/credentials` reads rather
 * more than that. A marketplace that pays people cannot ship with a key-theft
 * hole in the thing that earns the money.
 *
 * Containment is layered, because no single mechanism is available everywhere:
 *
 *   env       — always. A scrubbed environment, allowlisted rather than
 *               denylisted, so a secret added to a shell profile next year is
 *               excluded by default instead of leaking until someone notices.
 *   limits    — always on POSIX. rlimits via a shell preamble: no fork bombs,
 *               no filling the disk, no runaway CPU.
 *   seatbelt  — macOS. Denies *reads* of every credential path we can name and
 *               *writes* anywhere outside the job directory.
 *   bwrap     — Linux. A read-only bind of the filesystem with a private /home.
 *   container — opt-in, the only real boundary. `XORV_SANDBOX=container`.
 *
 * ## What this still does not do
 *
 * The agent CLIs must reach their own credentials to authenticate at all —
 * `claude` needs `~/.claude`, `codex` needs `~/.codex`. Those stay readable, so
 * a hostile prompt can still read the provider's *agent session*. It cannot
 * read their payout key, SSH keys, cloud credentials, or browser profile, and
 * it cannot write outside its job directory.
 *
 * Closing that last gap needs a container, which is why `container` exists and
 * why `xorv doctor` names the active tier rather than saying "sandboxed".
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SandboxTier = "none" | "env" | "limits" | "seatbelt" | "bwrap" | "container";

/** Ranked weakest to strongest, so `doctor` can compare. */
export const TIER_RANK: Record<SandboxTier, number> = {
  none: 0,
  env: 1,
  limits: 2,
  seatbelt: 3,
  bwrap: 4,
  container: 5,
};

export interface SandboxLimits {
  /** Wall-clock CPU seconds. */
  cpuSeconds: number;
  /** Max file size the job may create, in MB — stops a disk-filling loop. */
  fileSizeMb: number;
  /** Max processes, so a fork bomb hits a wall rather than the machine. */
  processes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpuSeconds: 600,
  fileSizeMb: 512,
  processes: 512,
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Variables a child genuinely needs, plus the ones the agent CLIs read.
 *
 * An allowlist, deliberately. A denylist has to be updated every time someone
 * invents a new `${VENDOR}_API_KEY`, and the failure mode is silent leakage;
 * an allowlist's failure mode is a CLI that visibly doesn't work, which someone
 * reports in a minute.
 */
const ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "PWD",
  // Node, for adapters that shell out to node tooling.
  "NODE_OPTIONS",
  "NVM_DIR",
  // Proxy settings, so a provider behind one still works.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/**
 * Prefixes an adapter may legitimately need.
 *
 * `openai-compatible` is configured entirely from the environment, so its own
 * variables have to survive. They are the operator's deliberate choice to
 * expose, unlike everything else in the shell.
 */
const ENV_ALLOW_PREFIX = ["XORV_OPENAI_"];

export function sandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOW.has(key) || ENV_ALLOW_PREFIX.some((p) => key.startsWith(p))) {
      clean[key] = value;
    }
  }

  // Nested Claude Code sessions leak session-scoped plumbing that breaks a
  // child's auth; the allowlist already drops it, and this documents why we
  // don't want it back.
  delete clean.CLAUDECODE;

  return { ...clean, ...extra };
}

/** Which variables were withheld — reported by `doctor`, never their values. */
export function withheldEnvKeys(): string[] {
  return Object.keys(process.env)
    .filter((k) => !ENV_ALLOW.has(k) && !ENV_ALLOW_PREFIX.some((p) => k.startsWith(p)))
    .sort();
}

// ---------------------------------------------------------------------------
// Paths a job must never read
// ---------------------------------------------------------------------------

/**
 * Everything worth stealing that a job has no reason to touch.
 *
 * `~/.xorv` is first for a reason: it holds the payout key, and a job reading
 * it can take every future payment the provider earns.
 */
export function secretPaths(home = os.homedir()): string[] {
  return [
    path.join(home, ".xorv"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gh"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".pypirc"),
    path.join(home, ".git-credentials"),
    path.join(home, "Library", "Keychains"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Firefox"),
    path.join(home, ".mozilla"),
    path.join(home, ".local", "share", "keyrings"),
  ];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function has(bin: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? [bin] : ["-v", bin],
    { stdio: "ignore", shell: process.platform !== "win32" });
  return probe.status === 0;
}

/**
 * Absolute path to a binary, or null if it isn't on PATH.
 *
 * Wrapping turns a missing binary into a shell exit code instead of a spawn
 * error, which would quietly change "claude is not installed" into "the job
 * failed with status 71". Resolving first preserves the ENOENT contract that
 * every adapter's error handling is written against.
 */
export function resolveBinary(cmd: string): string | null {
  if (cmd.includes("/")) return fs.existsSync(cmd) ? cmd : null;
  try {
    const found = execFileSync("command", ["-v", cmd], {
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return found.split("\n")[0] || null;
  } catch {
    return null;
  }
}

let cachedTier: SandboxTier | null = null;

/**
 * The strongest tier this machine can actually deliver.
 *
 * `XORV_SANDBOX` forces one. Forcing a tier the host can't provide is an error
 * rather than a silent downgrade — an operator who asked for a container and
 * quietly got environment scrubbing has been misled about their own exposure.
 */
export function detectSandbox(): SandboxTier {
  if (cachedTier) return cachedTier;

  const forced = process.env.XORV_SANDBOX?.trim() as SandboxTier | undefined;
  if (forced) {
    if (!(forced in TIER_RANK)) {
      throw new Error(
        `XORV_SANDBOX="${forced}" is not a tier (none, env, limits, seatbelt, bwrap, container)`,
      );
    }
    if (forced === "container" && !has("docker") && !has("podman")) {
      throw new Error("XORV_SANDBOX=container but neither docker nor podman is installed");
    }
    if (forced === "seatbelt" && process.platform !== "darwin") {
      throw new Error("XORV_SANDBOX=seatbelt only works on macOS");
    }
    if (forced === "bwrap" && !has("bwrap")) {
      throw new Error("XORV_SANDBOX=bwrap but bubblewrap is not installed");
    }
    cachedTier = forced;
    return forced;
  }

  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    cachedTier = "seatbelt";
  } else if (process.platform === "linux" && has("bwrap")) {
    cachedTier = "bwrap";
  } else if (process.platform === "win32") {
    // No portable mechanism; the env allowlist is all we have.
    cachedTier = "env";
  } else {
    cachedTier = "limits";
  }
  return cachedTier;
}

/** For tests, which need to re-detect under a changed environment. */
export function resetSandboxCache(): void {
  cachedTier = null;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * A macOS seatbelt profile.
 *
 * Deny-listed rather than allow-listed, and that is a deliberate weakening: an
 * allow-list strict enough to be airtight also blocks the agent CLIs from
 * reading their own credentials, and a sandbox that stops the product working
 * gets switched off. This denies every secret we can name and confines writes
 * to the job directory.
 */
export function seatbeltProfile(jobDir: string, home = os.homedir()): string {
  const deny = secretPaths(home)
    .map((p) => `  (deny file-read* (subpath ${JSON.stringify(p)}))`)
    .join("\n");

  // Seatbelt matches on the *resolved* path. On macOS the job directory lives
  // under /tmp or /var/folders, both symlinks into /private, so an unresolved
  // subpath rule silently matches nothing and the job cannot write to its own
  // working directory. Both spellings are allowed because the process may open
  // either one.
  const writable = new Set<string>([jobDir, realpath(jobDir), realpath(os.tmpdir()), os.tmpdir()]);

  return `(version 1)
(allow default)

; --- secrets: unreadable, whatever the prompt asks for -----------------------
${deny}
  (deny file-read* (regex #"^${escapeRegex(home)}/\\.env.*"))

; --- writes: the job directory and the temp dir, nothing else ----------------
(deny file-write*)
(allow file-write*
${[...writable].map((p) => `  (subpath ${JSON.stringify(p)})`).join("\n")}
  (subpath "/dev"))

; --- process control ---------------------------------------------------------
(deny mach-priv-task-port)
`;
}

/** Resolve symlinks, tolerating a path that does not exist yet. */
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A `ulimit` preamble, so limits apply to the whole job process tree. */
export function limitsPreamble(limits: SandboxLimits = DEFAULT_LIMITS): string {
  return [
    `ulimit -t ${limits.cpuSeconds}`,
    `ulimit -f ${limits.fileSizeMb * 1024}`,
    // Process caps are advisory on some shells; failure must not abort the job.
    `ulimit -u ${limits.processes} 2>/dev/null || true`,
  ].join("; ");
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

export interface WrappedCommand {
  cmd: string;
  args: string[];
  tier: SandboxTier;
  /** Written for seatbelt; the caller removes it when the job ends. */
  cleanup?: () => void;
}

/**
 * Wrap a command so it runs under the strongest available containment.
 *
 * Returns the command unchanged at `none`/`env`, since those tiers are enforced
 * through the environment rather than by re-invoking through a helper.
 */
export function wrapCommand(
  cmd: string,
  args: string[],
  opts: { jobDir: string; tier?: SandboxTier; limits?: SandboxLimits },
): WrappedCommand {
  const tier = opts.tier ?? detectSandbox();
  const limits = opts.limits ?? DEFAULT_LIMITS;

  if (tier === "none" || tier === "env" || process.platform === "win32") {
    return { cmd, args, tier };
  }

  // A container brings its own filesystem, so the binary is resolved inside it.
  if (tier !== "container") {
    const resolved = resolveBinary(cmd);
    if (!resolved) {
      const err = new Error(`spawn ${cmd} ENOENT`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      err.syscall = `spawn ${cmd}`;
      err.path = cmd;
      throw err;
    }
    cmd = resolved;
  }

  // Everything below runs the real command through `sh -c` so the rlimits are
  // in force before it starts. Arguments are passed positionally ("$@") rather
  // than interpolated, so a prompt containing shell metacharacters is data.
  const shellArgs = (inner: string): string[] => [
    "-c",
    `${limitsPreamble(limits)}; exec ${inner} "$@"`,
    "sh",
  ];

  if (tier === "seatbelt") {
    const profilePath = path.join(opts.jobDir, ".sandbox.sb");
    fs.writeFileSync(profilePath, seatbeltProfile(opts.jobDir), { mode: 0o600 });
    return {
      cmd: "/bin/sh",
      args: [
        ...shellArgs(`/usr/bin/sandbox-exec -f ${shellQuote(profilePath)} ${shellQuote(cmd)}`),
        ...args,
      ],
      tier,
      cleanup: () => {
        try {
          fs.rmSync(profilePath, { force: true });
        } catch {
          /* the job directory is removed wholesale anyway */
        }
      },
    };
  }

  if (tier === "bwrap") {
    // Read-only root, a private empty /home, and the job directory writable.
    // The agent's own config is bound back in read-only so it can authenticate.
    const home = os.homedir();
    const binds = [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", home,
      "--bind", opts.jobDir, opts.jobDir,
      "--tmpfs", "/tmp",
    ];
    for (const dir of [".claude", ".codex", ".config/opencode"]) {
      const full = path.join(home, dir);
      if (fs.existsSync(full)) binds.push("--ro-bind", full, full);
    }
    return {
      cmd: "bwrap",
      args: [...binds, "--die-with-parent", "--", "/bin/sh", ...shellArgs(shellQuote(cmd)), ...args],
      tier,
    };
  }

  if (tier === "container") {
    const runtime = has("docker") ? "docker" : "podman";
    const image = process.env.XORV_SANDBOX_IMAGE?.trim() || "node:24-slim";
    return {
      cmd: runtime,
      args: [
        "run", "--rm", "-i",
        "--network", process.env.XORV_SANDBOX_NETWORK?.trim() || "bridge",
        "--memory", "2g",
        "--pids-limit", String(limits.processes),
        "--cpus", "2",
        "--read-only",
        "--tmpfs", "/tmp",
        "-v", `${opts.jobDir}:/job`,
        "-w", "/job",
        image,
        cmd,
        ...args,
      ],
      tier,
    };
  }

  // `limits`
  return { cmd: "/bin/sh", args: [...shellArgs(shellQuote(cmd)), ...args], tier };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One line for `doctor` and the node banner. */
export function describeSandbox(tier: SandboxTier = detectSandbox()): string {
  switch (tier) {
    case "container":
      return "container — full isolation; the job cannot see the host filesystem";
    case "bwrap":
      return "bubblewrap — read-only root, private home, writes confined to the job dir";
    case "seatbelt":
      return "macOS seatbelt — credentials unreadable, writes confined to the job dir";
    case "limits":
      return "resource limits + scrubbed environment — no filesystem boundary";
    case "env":
      return "scrubbed environment only — no filesystem boundary";
    default:
      return "NONE — a job runs with your full user privileges";
  }
}

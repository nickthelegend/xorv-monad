/**
 * Adapter plumbing.
 *
 * An adapter's job is narrow: take a prompt from a stranger, drive one local
 * agent CLI with it, stream what happens, and return the final text.
 *
 * ## The security model, stated plainly
 *
 * A Xorv provider runs prompts written by people they have never met, on their
 * own machine, against their own paid subscription. That is the product, and it
 * is also the risk. Three things contain it:
 *
 *  1. **Every job gets a fresh empty directory** under `~/.xorv/jobs/`, which is
 *     the process's cwd. Agent CLIs resolve relative paths and their own
 *     permission scopes against cwd, so the blast radius of a hostile prompt is
 *     a scratch directory, not the operator's source tree.
 *  2. **The directory is deleted when the job ends**, pass or fail.
 *  3. **`XORV_SAFE_MODE=1` turns tools off entirely** and leaves a pure
 *     text-generation service — worth less per job, but it cannot touch a disk.
 *
 * What this does *not* do is contain a determined attacker: these CLIs can run
 * shell commands, and a shell command can leave a directory. Operators who want
 * a real boundary should run the node in a container or a VM, which the README
 * says in as many words. Pretending a cwd is a sandbox would be worse than
 * saying where the line is.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AdapterKind, JobEvent } from "@xorv/protocol";
import { DEFAULT_LIMITS, detectSandbox, sandboxEnv, wrapCommand, type SandboxTier } from "../sandbox.js";
import { agentCredentials } from "../credentials.js";

export type EmitEvent = (event: Omit<JobEvent, "at">) => void;

export interface RunInput {
  prompt: string;
  /** Fresh scratch directory, already created, deleted by the caller. */
  cwd: string;
  timeoutMs: number;
  /** Aborted when the broker cancels or the job times out. */
  signal: AbortSignal;
  emit: EmitEvent;
  model?: string | null;
  /**
   * What the job actually cost the provider, in USD, when the CLI reports it.
   *
   * Only Claude Code volunteers a dollar figure; Codex reports tokens and the
   * rest report nothing. It exists so `xorv test` can tell an operator that
   * they are selling below cost, which is otherwise invisible until the
   * subscription bill arrives.
   */
  onCost?: (usd: number) => void;
}

export interface JobAdapter {
  readonly kind: AdapterKind;
  /** Is the underlying CLI installed and runnable? */
  available(): Promise<boolean>;
  /** Where to get it, shown by `xorv doctor` when it's missing. */
  readonly installHint: string;
  run(input: RunInput): Promise<string>;
}

/** Tools off — see the safety note above. */
export function safeMode(): boolean {
  return process.env.XORV_SAFE_MODE === "1" || process.env.XORV_SAFE_MODE === "true";
}

/**
 * Is a CLI on PATH?
 *
 * Bounded, because this runs behind `xorv doctor` and behind every heartbeat's
 * availability check — a binary that hangs on `--version` must not wedge the
 * node's reporting.
 */
export function cliAvailable(
  cmd: string,
  args: string[] = ["--version"],
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, timeoutMs);
      timer.unref();
      const done = (value: boolean): void => {
        clearTimeout(timer);
        resolve(value);
      };
      child.on("close", (code) => done(code === 0));
      child.on("error", () => done(false));
    } catch {
      resolve(false);
    }
  });
}

/** First existing path from a list of candidates — for CLIs bundled in apps. */
export function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable path, keep looking */
    }
  }
  return null;
}

/**
 * Environment for spawned agent CLIs.
 *
 * When the node itself is started from inside a Claude Code session, the
 * environment carries session-scoped plumbing (`CLAUDECODE`, a session
 * `ANTHROPIC_BASE_URL`, …) that breaks a nested spawn in confusing ways. Strip
 * it so a child authenticates exactly as it would from a fresh terminal.
 */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // An allowlist, not the parent environment. A job used to inherit every
  // secret the operator had exported — cloud keys, tokens, anything a shell
  // profile happens to set. See sandbox.ts for why the list is positive.
  return sandboxEnv(extra);
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a child to completion, streaming stdout lines to `onLine`.
 *
 * Kills the whole process *group* on abort, not just the direct child: these
 * CLIs spawn their own subprocesses, and killing only the parent leaves an
 * orphaned model call burning the operator's quota after the job is gone.
 */
export function runChild(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  stdin?: string;
  /** Override the containment tier; defaults to the strongest available. */
  sandbox?: SandboxTier;
  /**
   * Which adapter this is for, so its own credential can be injected.
   *
   * The sandbox denies the keychain outright, so an agent that authenticates
   * from it needs the token handed in. Doing that here rather than in each
   * adapter means a new adapter cannot forget and silently fall back to an
   * unauthenticated run.
   */
  adapter?: AdapterKind;
}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let wrapped: ReturnType<typeof wrapCommand>;
    try {
      // Every adapter reaches the operating system through here, so this is the
      // one place containment has to be applied — an adapter cannot forget to.
      // It also throws ENOENT for a missing binary, matching what spawn did
      // before the sandbox sat in between.
      wrapped = wrapCommand(opts.cmd, opts.args, {
        jobDir: opts.cwd,
        tier: opts.sandbox,
        limits: DEFAULT_LIMITS,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    try {
      child = spawn(wrapped.cmd, wrapped.args, {
        cwd: opts.cwd,
        env: opts.env ?? agentEnv(opts.adapter ? agentCredentials(opts.adapter) : {}),
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      wrapped.cleanup?.();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let pending = "";
    let killed = false;

    const kill = (): void => {
      killed = true;
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
    };

    if (opts.signal.aborted) {
      kill();
    } else {
      opts.signal.addEventListener("abort", kill, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!opts.onLine) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) opts.onLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // Bounded: a CLI that spews warnings must not grow the node's heap for
      // the whole job. The tail is what a failure message needs anyway.
      stderr = (stderr + text).slice(-8_000);
      opts.onStderr?.(text);
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }

    child.on("error", (err) => {
      opts.signal.removeEventListener("abort", kill);
      wrapped.cleanup?.();
      reject(err);
    });

    child.on("close", (code, signal) => {
      opts.signal.removeEventListener("abort", kill);
      wrapped.cleanup?.();
      if (pending.trim() && opts.onLine) opts.onLine(pending);
      if (killed) {
        reject(new Error("job was cancelled or timed out"));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Create a fresh per-job scratch directory. */
export function makeJobDir(root: string, jobId: string): string {
  const dir = path.join(root, jobId.replace(/[^\w-]/g, ""));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Remove a job directory, never throwing — cleanup must not fail a paid job. */
export function removeJobDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leave it; `xorv doctor` reports the leftovers */
  }
}

/**
 * Trim a result to something that fits in a JSON response and a browser.
 *
 * Truncation is announced in the text rather than silent, so nobody reads a cut
 * answer as a complete one.
 */
export function clampResult(text: string, max = 80_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…[truncated ${text.length - max} characters]`;
}

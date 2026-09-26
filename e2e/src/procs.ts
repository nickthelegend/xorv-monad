/**
 * Child processes for the harness: started, logged, waited on, and always
 * killed.
 *
 * The harness runs five or six real programs at once (a forked chain, the
 * broker, a provider node, buyers), and on a small machine a stray one left
 * behind by a failed run is worse than the failure. So every process started
 * here is registered with the group, and the group is torn down on every exit
 * path: success, a failed assertion, an exception, Ctrl-C, SIGTERM. On Windows
 * `ChildProcess.kill()` terminates only the direct child, so the tree is taken
 * down with `taskkill /T /F`; elsewhere each child leads its own process group
 * and the whole group is signalled.
 *
 * Every child's output is kept (bounded) for assertions and failure reports,
 * and streamed to a per-process log file in the run directory.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";
/** Enough to hold any one run's output; older output is dropped first. */
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

export interface StartOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Echo each output line to the harness's own stderr, prefixed with the name. */
  echo?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export class ManagedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly logFile: string;
  readonly startedAt = Date.now();
  readonly exited: Promise<number | null>;
  private stdoutText = "";
  private stderrText = "";
  private listeners = new Set<() => void>();
  private exitCode: number | null | undefined = undefined;

  constructor(name: string, child: ChildProcess, logFile: string, echo: boolean) {
    this.name = name;
    this.child = child;
    this.logFile = logFile;
    const log = fs.createWriteStream(logFile, { flags: "a" });
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") this.stdoutText = clamp(this.stdoutText + text);
      else this.stderrText = clamp(this.stderrText + text);
      log.write(text);
      if (echo) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) process.stderr.write(`  [${name}] ${line}\n`);
      }
      for (const listener of this.listeners) listener();
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    this.exited = new Promise((resolve) => {
      child.on("exit", (code) => {
        this.exitCode = code;
        log.end();
        for (const listener of this.listeners) listener();
        resolve(code);
      });
      child.on("error", (err) => {
        this.stderrText = clamp(`${this.stderrText}\n[spawn error] ${err.message}\n`);
        this.exitCode = null;
        log.end();
        for (const listener of this.listeners) listener();
        resolve(null);
      });
    });
  }

  get stdout(): string {
    return this.stdoutText;
  }

  get stderr(): string {
    return this.stderrText;
  }

  get output(): string {
    return `${this.stdoutText}${this.stderrText ? `\n${this.stderrText}` : ""}`;
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  /** Resolve with the first match of `pattern` in the combined output; reject on exit or timeout. */
  waitFor(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const match = this.output.match(pattern);
        if (match) {
          done();
          resolve(match);
          return true;
        }
        if (!this.running) {
          done();
          reject(new Error(`${this.name} exited (code ${this.exitCode}) before printing ${pattern}\n${tail(this.output)}`));
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`${this.name} did not print ${pattern} within ${timeoutMs}ms\n${tail(this.output)}`));
      }, timeoutMs);
      const listener = () => void check();
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
      check();
    });
  }
}

/**
 * Every process the harness started. `stopAll` is idempotent and safe to call
 * from any exit path; `killAllSync` is for `process.on("exit")`, where only
 * synchronous work runs.
 */
export class ProcessGroup {
  private readonly procs: ManagedProcess[] = [];
  /** Processes someone else spawned (the MCP SDK's stdio transport) that must still die with the run. */
  private readonly adopted: Array<{ name: string; pid: number }> = [];
  private readonly logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
  }

  start(name: string, command: string, args: string[], opts: StartOptions): ManagedProcess {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group off Windows, so the whole tree can be signalled.
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    const logFile = path.join(this.logDir, `${name}.log`);
    fs.writeFileSync(logFile, `$ ${command} ${args.join(" ")}\n(cwd ${opts.cwd})\n\n`);
    const proc = new ManagedProcess(name, child, logFile, opts.echo ?? false);
    this.procs.push(proc);
    return proc;
  }

  /** Run a command to completion (bounded), killing it on timeout. */
  async run(name: string, command: string, args: string[], opts: StartOptions & { timeoutMs: number }): Promise<RunResult> {
    const started = Date.now();
    const proc = this.start(name, command, args, opts);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
    });
    const outcome = await Promise.race([proc.exited, timeout]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      killTree(proc);
      throw new Error(`${name} did not finish within ${opts.timeoutMs}ms\n${tail(proc.output)}`);
    }
    return { code: outcome, stdout: proc.stdout, stderr: proc.stderr, ms: Date.now() - started };
  }

  adopt(name: string, pid: number): void {
    this.adopted.push({ name, pid });
  }

  /** Stop everything still running, newest first, and wait (bounded) for the exits. */
  async stopAll(): Promise<void> {
    for (const { pid } of this.adopted) killPid(pid, true);
    const alive = [...this.procs].reverse().filter((p) => p.running);
    for (const proc of alive) killTree(proc);
    await Promise.race([Promise.all(alive.map((p) => p.exited)), delay(10_000)]);
    // Anything that ignored the polite signal off Windows gets the hard one.
    for (const proc of alive) if (proc.running) killTree(proc, true);
  }

  killAllSync(): void {
    for (const { pid } of this.adopted) killPid(pid, true);
    for (const proc of this.procs) if (proc.running) killTree(proc, true);
  }

  list(): readonly ManagedProcess[] {
    return this.procs;
  }
}

function killTree(proc: ManagedProcess, hard = false): void {
  const pid = proc.child.pid;
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, hard ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // Already gone.
  }
}

/** A process that isn't a group leader (spawned by a library): the pid itself, and its tree on Windows. */
function killPid(pid: number, hard: boolean): void {
  try {
    if (IS_WINDOWS) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, hard ? "SIGKILL" : "SIGTERM");
  } catch {
    // Already gone.
  }
}

function clamp(text: string): string {
  return text.length > MAX_CAPTURE_CHARS ? text.slice(text.length - MAX_CAPTURE_CHARS) : text;
}

/** The last lines of some output, for an error message. */
export function tail(text: string, lines = 40): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).map((line) => `    | ${line}`).join("\n");
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adapters and the process plumbing under them.
 *
 * `runChild` is exercised against real binaries (`node`, `sh`) rather than a
 * mock, because the things that go wrong here — a child that ignores SIGTERM,
 * output arriving split across chunk boundaries, a process group that outlives
 * its parent — only go wrong against a real process.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EchoAdapter } from "../src/adapters/echo.js";
import { allAdapters, createAdapter, detectAvailable } from "../src/adapters/index.js";
import {
  clampResult,
  cliAvailable,
  firstExisting,
  makeJobDir,
  removeJobDir,
  runChild,
  safeMode,
} from "../src/adapters/base.js";
import type { JobEvent } from "@xorv/protocol";

function collector() {
  const events: Array<Omit<JobEvent, "at">> = [];
  return { events, emit: (e: Omit<JobEvent, "at">) => events.push(e) };
}

describe("adapter registry", () => {
  it("builds every declared kind", () => {
    const kinds = allAdapters().map((a) => a.kind).sort();
    expect(kinds).toEqual(
      ["claude-code", "codex", "echo", "grok", "openai-compatible", "opencode"].sort(),
    );
  });

  it("gives every adapter an install hint, so `doctor` can always say what to do", () => {
    for (const adapter of allAdapters()) {
      expect(adapter.installHint.length).toBeGreaterThan(5);
    }
  });

  it("throws on an unknown kind rather than returning undefined", () => {
    // @ts-expect-error deliberately invalid
    expect(() => createAdapter("nope")).toThrow(/unknown adapter/);
  });

  it("probes availability without throwing, even when a CLI is missing", async () => {
    const results = await detectAvailable();
    expect(results).toHaveLength(6);
    for (const r of results) expect(typeof r.available).toBe("boolean");
    // Echo needs nothing installed and must always be usable.
    expect(results.find((r) => r.adapter.kind === "echo")!.available).toBe(true);
  });
});

describe("EchoAdapter", () => {
  it("returns a reply that quotes the prompt, and streams progress first", async () => {
    const { events, emit } = collector();
    const result = await new EchoAdapter().run({
      prompt: "hello world",
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      emit,
    });
    expect(result).toContain("hello world");
    expect(result).toContain("Xorv provider node");
    expect(events.filter((e) => e.kind === "status").length).toBeGreaterThan(1);
    expect(events.at(-1)!.kind).toBe("message");
  });

  it("aborts promptly when cancelled mid-run", async () => {
    const controller = new AbortController();
    const { emit } = collector();
    const promise = new EchoAdapter().run({
      prompt: "x",
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      signal: controller.signal,
      emit,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow(/cancel/i);
  });
});

describe("runChild", () => {
  const cwd = os.tmpdir();

  it("captures stdout and the exit code", async () => {
    const result = await runChild({
      cmd: "node",
      args: ["-e", "process.stdout.write('hi'); process.exit(0)"],
      cwd,
      signal: new AbortController().signal,
    });
    expect(result.stdout).toBe("hi");
    expect(result.code).toBe(0);
  });

  it("reassembles lines split across chunk boundaries", async () => {
    const lines: string[] = [];
    await runChild({
      cmd: "node",
      args: [
        "-e",
        // Deliberately write a partial line, pause, then finish it.
        "process.stdout.write('part'); setTimeout(()=>{process.stdout.write('ial\\nsecond\\n')},30)",
      ],
      cwd,
      signal: new AbortController().signal,
      onLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(["partial", "second"]);
  });

  it("emits a trailing line that never got its newline", async () => {
    const lines: string[] = [];
    await runChild({
      cmd: "node",
      args: ["-e", "process.stdout.write('no-newline')"],
      cwd,
      signal: new AbortController().signal,
      onLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(["no-newline"]);
  });

  it("reports a non-zero exit rather than throwing", async () => {
    const result = await runChild({
      cmd: "node",
      args: ["-e", "process.exit(3)"],
      cwd,
      signal: new AbortController().signal,
    });
    expect(result.code).toBe(3);
  });

  it("rejects when aborted, and actually kills a child that ignores SIGTERM", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runChild({
      cmd: "node",
      args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      cwd,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    await expect(promise).rejects.toThrow(/cancelled|timed out/);
    // SIGKILL, not a polite request — this must not wait for the interval.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("rejects when the binary does not exist", async () => {
    await expect(
      runChild({
        cmd: "definitely-not-a-real-binary-xyz",
        args: [],
        cwd,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  it("bounds retained stderr so a noisy child can't grow the heap", async () => {
    const result = await runChild({
      cmd: "node",
      args: ["-e", "for(let i=0;i<20000;i++) process.stderr.write('noise-line-'+i+'\\n')"],
      cwd,
      signal: new AbortController().signal,
    });
    expect(result.stderr.length).toBeLessThanOrEqual(8_000);
  });

  it("writes stdin when provided", async () => {
    const result = await runChild({
      cmd: "node",
      args: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))"],
      cwd,
      signal: new AbortController().signal,
      stdin: "fed via stdin",
    });
    expect(result.stdout).toBe("FED VIA STDIN");
  });
});

describe("cliAvailable", () => {
  it("finds a binary that exists", async () => {
    expect(await cliAvailable("node", ["--version"])).toBe(true);
  });

  it("returns false for one that doesn't, without throwing", async () => {
    expect(await cliAvailable("definitely-not-a-real-binary-xyz")).toBe(false);
  });

  it("gives up on a binary that hangs instead of wedging the caller", async () => {
    const started = Date.now();
    const available = await cliAvailable("node", ["-e", "setInterval(()=>{},1000)"], 300);
    expect(available).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("job directories", () => {
  it("creates and removes an isolated per-job directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-test-"));
    const dir = makeJobDir(root, "job_abc123");
    expect(fs.existsSync(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, "scratch.txt"), "x");
    removeJobDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("strips path separators from a job id so it can't escape the sandbox root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-test-"));
    const dir = makeJobDir(root, "../../../etc/evil");
    expect(path.dirname(dir)).toBe(root);
    expect(dir.includes("..")).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("never throws when removing a directory that is already gone", () => {
    expect(() => removeJobDir("/tmp/xorv-does-not-exist-xyz")).not.toThrow();
  });
});

describe("clampResult", () => {
  it("passes short results through untouched", () => {
    expect(clampResult("short")).toBe("short");
  });

  it("announces truncation rather than silently cutting", () => {
    const clamped = clampResult("x".repeat(200), 100);
    expect(clamped).toContain("truncated 100 characters");
    expect(clamped.length).toBeLessThan(200);
  });
});

describe("misc helpers", () => {
  it("firstExisting finds the first real path", () => {
    expect(firstExisting(["/definitely/not/here", os.tmpdir()])).toBe(os.tmpdir());
    expect(firstExisting(["/nope/a", "/nope/b"])).toBeNull();
  });

  it("safeMode reads the environment", () => {
    const original = process.env.XORV_SAFE_MODE;
    process.env.XORV_SAFE_MODE = "1";
    expect(safeMode()).toBe(true);
    process.env.XORV_SAFE_MODE = "";
    expect(safeMode()).toBe(false);
    if (original === undefined) delete process.env.XORV_SAFE_MODE;
    else process.env.XORV_SAFE_MODE = original;
  });
});

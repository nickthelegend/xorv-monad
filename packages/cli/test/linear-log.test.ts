/**
 * `xorv start` off a terminal — under a service manager, in a container, or
 * with its output sent to a file.
 *
 * Regression test for what the e2e harness's provider log showed: the live
 * dashboard repaints every second, and off a terminal each repaint printed
 * the block's last line — the static "payout … ctrl-c to stop" footer. A
 * minute of uptime was sixty identical lines and not one line about the jobs
 * the node ran.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { followLinear, plainLogLine } from "../src/commands/start.js";
import { c, liveRegion } from "../src/ui.js";

describe("liveRegion off a terminal", () => {
  it("writes nothing, however often it is repainted", () => {
    const written: string[] = [];
    // Anywhere it could write: the injected sink, console.log, stdout itself.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const region = liveRegion({ tty: false, write: (chunk) => written.push(chunk) });
      for (let i = 0; i < 60; i++) region.render(["LIVE", "earned $0.04", "  payout 0x1663…5100 · ctrl-c to stop"]);
      region.clear();
      expect(written).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      stdout.mockRestore();
    }
  });

  it("still repaints in place on a terminal", () => {
    const written: string[] = [];
    const region = liveRegion({ tty: true, write: (chunk) => written.push(chunk) });
    region.render(["a", "b"]);
    region.render(["a", "c"]);
    // The second paint moves the cursor back up over the two lines it replaces.
    expect(written[1]).toBe("\u001b[2A");
    expect(written.join("")).toContain("c");
  });
});

describe("followLinear", () => {
  it("prints the backlog, then one plain line per node event", () => {
    const node = new EventEmitter();
    const printed: string[] = [];
    const at = Date.UTC(2026, 8, 26, 18, 40, 0);
    followLinear(node, [{ level: "ok", text: c.ok("control channel open"), at }], (line) => printed.push(line));
    node.emit("log", { level: "ok", text: "job job_SQqhEIQ3 done in 2.1s — earned $0.04" });
    node.emit("log", { level: "bad", text: "job job_tD4a40mx failed: adapter exited 1" });

    expect(printed).toHaveLength(3);
    expect(printed[0]).toBe("2026-09-26T18:40:00.000Z ok    control channel open");
    expect(printed[1]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z ok    job job_SQqhEIQ3 done in 2\.1s — earned \$0\.04$/);
    expect(printed[2]).toMatch(/ error job job_tD4a40mx failed: adapter exited 1$/);
    // Plain text: a log file or journald gets no colour codes.
    for (const line of printed) expect(line).not.toContain("\u001b[");
  });
});

describe("plainLogLine", () => {
  it("keeps the level readable and the message uncoloured", () => {
    expect(plainLogLine({ level: "warn", text: c.warn("paused — not taking new jobs"), at: 0 })).toBe(
      "1970-01-01T00:00:00.000Z warn  paused — not taking new jobs",
    );
  });
});

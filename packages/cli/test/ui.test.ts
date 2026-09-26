/**
 * The layout helpers all do arithmetic on strings that contain invisible ANSI
 * escapes. Every alignment bug in a terminal UI is the same bug — counting
 * escape bytes as characters — so that's what these pin down.
 */

import { describe, expect, it } from "vitest";
import {
  box,
  gradient,
  kv,
  meter,
  sparkline,
  stripAnsi,
  table,
  visibleLength,
  wrap,
} from "../src/ui.js";

describe("stripAnsi / visibleLength", () => {
  it("ignores colour codes when measuring", () => {
    const coloured = gradient("hello");
    expect(stripAnsi(coloured)).toBe("hello");
    expect(visibleLength(coloured)).toBe(5);
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain")).toBe("plain");
    expect(visibleLength("plain")).toBe(5);
  });
});

describe("wrap", () => {
  it("breaks on word boundaries and never exceeds the width", () => {
    const lines = wrap("the quick brown fox jumps over the lazy dog", 12);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(12);
    expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("returns short text as a single line", () => {
    expect(wrap("short", 40)).toEqual(["short"]);
  });

  it("hard-breaks a token with no word boundary, so a box border can't blow out", () => {
    const lines = wrap("supercalifragilistic", 5);
    expect(lines).toEqual(["super", "calif", "ragil", "istic"]);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(5);
  });

  it("hard-breaks a long URL — the case that actually broke the receipt box", () => {
    const url = "https://hashscan.io/testnet/transaction/0.0.9842030-1785475549-131327424";
    const lines = wrap(url, 40);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(40);
    expect(lines.join("")).toBe(url);
  });

  it("keeps ANSI escapes attached to the character they colour when hard-breaking", () => {
    const coloured = gradient("abcdefghij");
    const lines = wrap(coloured, 4);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(4);
    expect(stripAnsi(lines.join(""))).toBe("abcdefghij");
  });
});

describe("box", () => {
  it("produces rows of identical visible width, colour included", () => {
    const rendered = box([gradient("coloured"), "plain"], { title: "test", width: 40 });
    const widths = new Set(rendered.split("\n").map((l) => visibleLength(l)));
    expect(widths.size).toBe(1);
  });

  it("splits embedded newlines instead of measuring them as characters", () => {
    // A multi-line job result arrives as one string; if \n isn't split the
    // right-hand border comes apart.
    const rendered = box(["line one\nline two\nline three"], { width: 40 });
    const widths = new Set(rendered.split("\n").map((l) => visibleLength(l)));
    expect(widths.size).toBe(1);
    expect(rendered).toContain("line two");
  });

  it("wraps content that is wider than the box", () => {
    const rendered = box(["x".repeat(200)], { width: 40 });
    for (const line of rendered.split("\n")) expect(visibleLength(line)).toBe(40);
  });
});

describe("kv", () => {
  it("aligns values to the widest label", () => {
    const rows = kv([
      ["a", "1"],
      ["longer-label", "2"],
    ]);
    const columns = rows.map((r) => stripAnsi(r).indexOf("1") + stripAnsi(r).indexOf("2") + 1);
    // Both values start at the same column.
    expect(stripAnsi(rows[0]!).indexOf("1")).toBe(stripAnsi(rows[1]!).indexOf("2"));
    expect(columns.length).toBe(2);
  });
});

describe("table", () => {
  it("sizes columns to their widest cell and keeps rows aligned", () => {
    const rendered = table(
      [{ header: "name" }, { header: "price", align: "right" }],
      [
        ["short", "$1"],
        ["a-much-longer-name", "$1000"],
      ],
    );
    const lines = rendered.split("\n");
    // header, rule, two rows
    expect(lines).toHaveLength(4);
    const widths = new Set(lines.map((l) => visibleLength(l)));
    expect(widths.size).toBe(1);
  });

  it("right-aligns when asked", () => {
    const rendered = table([{ header: "n", align: "right" }], [["1"], ["1000"]]);
    const rows = rendered.split("\n").slice(2);
    expect(stripAnsi(rows[0]!)).toBe("   1");
    expect(stripAnsi(rows[1]!)).toBe("1000");
  });

  it("handles an empty row set without throwing", () => {
    expect(() => table([{ header: "x" }], [])).not.toThrow();
  });
});

describe("sparkline", () => {
  it("renders one bar per value and scales to the maximum", () => {
    expect(visibleLength(sparkline([1, 2, 3, 4]))).toBe(4);
    expect(stripAnsi(sparkline([0, 100]))).toBe("▁█");
  });

  it("degrades to a dash when there is nothing to plot", () => {
    expect(stripAnsi(sparkline([]))).toBe("—");
  });

  it("does not divide by zero on an all-zero series", () => {
    expect(() => sparkline([0, 0, 0])).not.toThrow();
  });
});

describe("meter", () => {
  it("fills proportionally and clamps out-of-range input", () => {
    expect(stripAnsi(meter(0, 10))).toBe("░".repeat(10));
    expect(stripAnsi(meter(1, 10))).toBe("█".repeat(10));
    expect(stripAnsi(meter(0.5, 10))).toBe("█".repeat(5) + "░".repeat(5));
    expect(visibleLength(meter(5, 10))).toBe(10);
    expect(visibleLength(meter(-3, 10))).toBe(10);
  });
});

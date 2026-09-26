/**
 * The small shared helpers, the adapter roster, and the contract that
 * `@xorv/protocol/web` stays browser-safe: a stray `node:crypto` or
 * facilitator import there breaks every Next.js client bundle at build time.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as node from "../src/index.js";
import * as web from "../src/web.js";
import { ADAPTER_KINDS } from "../src/types.js";

describe("node helpers", () => {
  it("hashes deterministically, so fingerprints are comparable", () => {
    expect(node.sha256("hello")).toBe(node.sha256("hello"));
    expect(node.sha256("hello")).not.toBe(node.sha256("hello "));
    expect(node.sha256("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("mints prefixed, URL-safe, non-colliding ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => node.newId("job")));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^job_[A-Za-z0-9_-]+$/);
  });
});

describe("formatting", () => {
  it("formats durations across the ms/s/m boundaries", () => {
    expect(web.formatDuration(820)).toBe("820ms");
    expect(web.formatDuration(4_200)).toBe("4.2s");
    expect(web.formatDuration(72_000)).toBe("1m 12s");
  });

  it("formats relative times", () => {
    const now = Date.now();
    expect(web.formatAgo(now, now)).toBe("just now");
    expect(web.formatAgo(now - 12_000, now)).toBe("12s ago");
    expect(web.formatAgo(now - 4 * 60_000, now)).toBe("4m ago");
    expect(web.formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(web.formatAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(web.formatAgo(now + 5_000, now)).toBe("just now");
  });
});

describe("JSON helpers", () => {
  it("toJsonSafe turns bigints into decimal strings, deeply, and drops undefined", () => {
    const value = { a: 1n, b: [2n, { c: 3n }], d: "x", e: undefined, f: null, g: true };
    expect(web.toJsonSafe(value)).toEqual({ a: "1", b: ["2", { c: "3" }], d: "x", f: null, g: true });
    expect(() => JSON.stringify(web.toJsonSafe({ max: 2n ** 256n - 1n }))).not.toThrow();
    expect(web.toJsonSafe(5n)).toBe("5");
  });

  it("canonicalJson sorts keys at every level and is stable", () => {
    expect(web.canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2n } })).toBe(
      '{"a":{"c":"2","d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(web.canonicalJson({ x: 1, y: 2 })).toBe(web.canonicalJson({ y: 2, x: 1 }));
  });
});

describe("adapters", () => {
  it("offers the sponsor adapters alongside the originals", () => {
    expect(ADAPTER_KINDS).toEqual([
      "claude-code",
      "codex",
      "grok",
      "opencode",
      "qwen",
      "kimi",
      "hunyuan",
      "qwen-code",
      "openai-compatible",
      "echo",
    ]);
  });
});

describe("constants", () => {
  it("keeps the protocol timings and x402 identifiers", () => {
    expect(web.X402_VERSION).toBe(2);
    expect(web.XORV_SCHEME).toBe("exact");
    expect(web.HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(web.HEARTBEAT_OFFLINE_MS).toBe(45_000);
    expect(web.PROVIDER_REAP_MS).toBe(600_000);
    expect(web.QUOTE_TTL_SECONDS).toBe(300);
    expect(web.JOB_TIMEOUT_MS).toBe(600_000);
  });
});

describe("entry points", () => {
  it("the node entry re-exports the whole web surface plus the server-only pieces", () => {
    for (const name of Object.keys(web)) expect(node).toHaveProperty(name);
    for (const name of ["sha256", "newId", "buildFacilitator", "buildLocalFacilitator", "streamChat", "chatJson", "LLM_PRESETS"]) {
      expect(node).toHaveProperty(name);
      expect(web).not.toHaveProperty(name);
    }
  });

  it("the web entry exposes what the apps need", () => {
    for (const name of [
      "networkConfig",
      "explorerTx",
      "normalizeAddress",
      "sameAddress",
      "fetchBalances",
      "ratingTypedData",
      "readLedgerEvents",
      "XORV_LEDGER_ABI",
      "buildFeedbackFile",
      "buyerX402Client",
      "usdcPaymentOption",
      "formatUsd",
    ]) {
      expect(web).toHaveProperty(name);
    }
  });

  it("the web entry's import graph never reaches node built-ins, the facilitator or the LLM client", () => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const seen = new Set<string>();
    const external = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(join(srcDir, file), "utf8");
      for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
        const spec = match[1]!;
        if (spec.startsWith("./")) walk(spec.slice(2).replace(/\.js$/, ".ts"));
        else external.add(spec);
      }
    };
    walk("web.ts");

    expect(seen.has("x402.ts")).toBe(false);
    expect(seen.has("llm.ts")).toBe(false);
    expect(seen.has("index.ts")).toBe(false);
    for (const spec of external) {
      expect(spec.startsWith("node:")).toBe(false);
      expect(spec).not.toMatch(/facilitator|server/);
    }
    expect([...external].sort()).toEqual(
      ["@x402/core/client", "@x402/core/http", "@x402/core/types", "@x402/evm", "@x402/evm/exact/client", "viem", "viem/accounts", "viem/chains"].sort(),
    );
  });
});

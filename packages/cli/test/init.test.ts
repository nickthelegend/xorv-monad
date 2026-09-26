/**
 * `xorv init`'s payout step, driven by a scripted prompter.
 *
 * Every path ends in a checksummed address and, only when the operator chose
 * it, a key: generate (key stored), import (a bad key first, then a good one),
 * address-only (a typo'd checksum first, then a good address — and never a key
 * on disk), and reuse. The address-only path is the one worth pinning: it is
 * the safest node there is, and a regression that quietly wrote *some* key
 * would undo the point of offering it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { setupWallet, type Prompter } from "../src/commands/init.js";
import type { NodeConfig } from "../src/config.js";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PRIVY_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** Answers questions in order; `select` picks by label prefix. */
function script(answers: { selects?: string[]; asks?: string[]; confirms?: boolean[] }): Prompter & { asked: string[] } {
  const selects = [...(answers.selects ?? [])];
  const asks = [...(answers.asks ?? [])];
  const confirms = [...(answers.confirms ?? [])];
  const asked: string[] = [];
  return {
    asked,
    async ask(question) {
      asked.push(question);
      const next = asks.shift();
      if (next === undefined) throw new Error(`unscripted question: ${question}`);
      return next;
    },
    async confirm(question) {
      asked.push(question);
      const next = confirms.shift();
      if (next === undefined) throw new Error(`unscripted confirm: ${question}`);
      return next;
    },
    async select(question, options) {
      asked.push(question);
      const want = selects.shift();
      const hit = options.find((o) => want && o.label.startsWith(want));
      if (!hit) throw new Error(`unscripted select: ${question} (${options.map((o) => o.label).join(" | ")})`);
      return hit;
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("setupWallet", () => {
  it("offers generate, address-only and import — with address-only called the safest", async () => {
    let labels: Array<{ label: string; hint?: string }> = [];
    const prompter = script({ selects: ["Generate"] });
    const spy: Prompter = {
      ...prompter,
      async select(question, options) {
        labels = options;
        return prompter.select(question, options);
      },
    };
    await setupWallet(null, spy);
    expect(labels.map((o) => o.label)).toEqual([
      "Generate a new key for me",
      "Use an address I already control",
      "Import an existing private key",
    ]);
    expect(labels[1]!.hint).toMatch(/safest.*Privy.*no key is stored/);
  });

  it("generates a fresh key whose address is the payout address", async () => {
    const choice = await setupWallet(null, script({ selects: ["Generate"] }));
    expect(choice.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(choice.address).toBe(privateKeyToAccount(choice.privateKey as `0x${string}`).address);
  });

  it("generates a different key each time", async () => {
    const a = await setupWallet(null, script({ selects: ["Generate"] }));
    const b = await setupWallet(null, script({ selects: ["Generate"] }));
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("imports a key, re-asking after one it cannot use", async () => {
    const prompter = script({
      selects: ["Import"],
      asks: ["302e020100300506032b657004220420deadbeef", KEY.slice(2)],
    });
    const choice = await setupWallet(null, prompter);
    expect(choice).toEqual({ address: ADDRESS, privateKey: KEY });
    expect(prompter.asked.filter((q) => q.includes("private key"))).toHaveLength(2);
  });

  it("takes an address alone and keeps no key at all", async () => {
    const typo = PRIVY_WALLET.replace("C51812dc", "c51812DC"); // valid hex, broken checksum
    const prompter = script({ selects: ["Use an address"], asks: ["not an address", typo, PRIVY_WALLET.toLowerCase()] });
    const choice = await setupWallet(null, prompter);
    expect(choice).toEqual({ address: PRIVY_WALLET, privateKey: "" });
    expect(prompter.asked.filter((q) => q.includes("payout address"))).toHaveLength(3);
  });

  it("reuses the existing payout address, key or no key, when the operator says so", async () => {
    const withKey = { address: ADDRESS, privateKey: KEY } as NodeConfig;
    expect(await setupWallet(withKey, script({ confirms: [true] }))).toEqual({ address: ADDRESS, privateKey: KEY });

    const addressOnly = { address: PRIVY_WALLET.toLowerCase(), privateKey: "" } as NodeConfig;
    const prompter = script({ confirms: [true] });
    expect(await setupWallet(addressOnly, prompter)).toEqual({ address: PRIVY_WALLET, privateKey: "" });
    expect(prompter.asked[0]).toMatch(/address only, no key here/);
  });

  it("asks again when the operator declines to reuse", async () => {
    const previous = { address: ADDRESS, privateKey: KEY } as NodeConfig;
    const choice = await setupWallet(previous, script({ confirms: [false], selects: ["Use an address"], asks: [PRIVY_WALLET] }));
    expect(choice).toEqual({ address: PRIVY_WALLET, privateKey: "" });
  });
});

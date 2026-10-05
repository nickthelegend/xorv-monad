"use client";

import Link from "next/link";
import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";
import { CHAIN, REPO_URL } from "@/lib/links";

/**
 * The two contracts that make a broker's promise into a guarantee.
 *
 * Laid out as the state machine it is — four verbs, who may call each, where
 * the money goes — because the claim "your money is safe" is only worth the
 * table that backs it. The registry sits beside it as a code excerpt: its
 * one rule (only the escrow writes outcomes, and nothing can make it revert a
 * payment) is shorter to show than to describe.
 */

const VERBS = [
  { verb: "fund", who: "attester, with the buyer's signature", money: "buyer → escrow" },
  { verb: "release", who: "attester before the deadline · buyer any time", money: "escrow → provider" },
  { verb: "reassign", who: "attester, before the deadline", money: "stays put · payee changes" },
  { verb: "refund", who: "attester any time · anyone after the deadline", money: "escrow → buyer" },
];

const GUARANTEES = [
  ["The buyer never needs gas", "EIP-3009 ReceiveWithAuthorization, relayed by the attester"],
  ["A signature can't be redirected", "the nonce is derived from the job id and deadline, on chain"],
  ["It can't be front-run", "the token only lets the escrow itself redeem it"],
  ["The owner can't touch escrowed money", "no withdrawal; sweep reaches only the excess"],
  ["A stalled broker can't keep it", "permissionless refund after the deadline, even while paused"],
  ["Reputation can't be skipped", "gas for the registry call is required up front (EIP-150)"],
  ["Only verified identities move money", "with the Cleanverse gate on, funding and payouts need an active A-Pass; refunds never do"],
];

/** Excerpted from contracts/src/XorvRegistry.sol. */
const SOL = `function recordOutcome(address provider, bool success, uint256 amount) external {
    // A zero escrow disables reporting: no caller is address(0).
    if (msg.sender != _escrow) revert Unauthorized(msg.sender);
    if (provider == address(0)) revert ZeroAddress();

    Provider storage rec = _providers[provider];
    // …
    if (success) {
        if (completed != type(uint64).max) completed++;   // saturate, never revert
        rec.completed = completed;
        rec.earned = sum < earned ? type(uint256).max : sum;
    } else {
        if (failed != type(uint64).max) failed++;
        rec.failed = failed;
    }
    emit OutcomeRecorded(provider, success, amount, completed, failed);
}`;

export function Contracts() {
  return (
    <Section id="contracts">
      <Reveal>
        <SectionHeading
          title="The broker can stall. It can't keep the money."
          sub="Every job's payment waits in XorvEscrow — Solidity — until the work is delivered. Every outcome is written into XorvRegistry by the same transaction that pays or refunds — both on Monad."
        />
      </Reveal>

      <div className="mx-auto mt-16 grid max-w-5xl grid-cols-1 gap-px overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--line)] *:min-w-0 lg:grid-cols-2">
        <Reveal>
          <div className="h-full min-w-0 bg-[var(--bg)] p-6 sm:p-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-[15px] font-medium text-fg">XorvEscrow</h3>
              <span className="mono text-[11.5px] text-fg-4">Solidity · OpenZeppelin 5</span>
            </div>
            <ul className="mt-5 border-t border-[var(--line)]">
              {VERBS.map((v) => (
                <li
                  key={v.verb}
                  className="grid grid-cols-[5.5rem_1fr] gap-x-4 border-b border-[var(--line)] py-3"
                >
                  <span className="mono text-[13px] text-fg">{v.verb}()</span>
                  <div>
                    <p className="text-[13px] text-fg-2">{v.money}</p>
                    <p className="mt-0.5 text-[12px] text-fg-4">{v.who}</p>
                  </div>
                </li>
              ))}
            </ul>
            <ul className="mt-6 space-y-2.5">
              {GUARANTEES.map(([claim, how]) => (
                <li key={claim} className="text-[13px] leading-relaxed">
                  <span className="text-fg">{claim}</span>
                  <span className="text-fg-4"> — {how}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[12px] text-fg-4">
              125 Solidity tests (unit, fuzz, 4 invariants), and fork tests against the real AUSD, USDC and Cleanverse A-Pass on Monad testnet.{" "}
              {CHAIN.escrowUrl ? (
                <Link href={CHAIN.escrowUrl} target="_blank" rel="noopener noreferrer" className="text-fg-3 underline decoration-[var(--line-2)] underline-offset-2 hover:text-fg">
                  Contract ↗
                </Link>
              ) : (
                <Link href={`${REPO_URL}/tree/main/contracts`} target="_blank" rel="noopener noreferrer" className="text-fg-3 underline decoration-[var(--line-2)] underline-offset-2 hover:text-fg">
                  Source ↗
                </Link>
              )}
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="h-full min-w-0 bg-black p-6 sm:p-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="text-[15px] font-medium text-fg">XorvRegistry</h3>
              <span className="mono text-[11.5px] text-fg-4">Solidity · on Monad</span>
            </div>
            <pre className="mono mt-5 overflow-x-auto text-[11.5px] leading-[1.65] text-fg-2">
              <code>{SOL}</code>
            </pre>
            <p className="mt-6 text-[12px] leading-relaxed text-fg-4">
              Called from Solidity with a fixed gas budget and a try/catch, so a registry fault can
              never block a payment. 45 tests, ported from the Rust original; worst-case write
              measured at 50k gas against a 150k budget.{" "}
              {CHAIN.registryUrl ? (
                <Link href={CHAIN.registryUrl} target="_blank" rel="noopener noreferrer" className="text-fg-3 underline decoration-[var(--line-2)] underline-offset-2 hover:text-fg">
                  Contract ↗
                </Link>
              ) : (
                <Link href={`${REPO_URL}/blob/main/contracts/src/XorvRegistry.sol`} target="_blank" rel="noopener noreferrer" className="text-fg-3 underline decoration-[var(--line-2)] underline-offset-2 hover:text-fg">
                  Source ↗
                </Link>
              )}
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

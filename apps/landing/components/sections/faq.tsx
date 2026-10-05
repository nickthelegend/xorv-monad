"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";
import { cn } from "@/lib/utils";

/**
 * The questions a careful person actually asks.
 *
 * Including the uncomfortable ones. Someone is about to run prompts from
 * strangers against a paid account on their own laptop; pretending that has no
 * downside is the fastest way to lose them.
 */
const FAQ = [
  {
    q: "Is this against my AI provider's terms of service?",
    a: "Possibly — check yours. Most consumer AI subscriptions are licensed to an individual, and reselling that capacity may breach them. Xorv is infrastructure and doesn't decide this for you: run it against quota you're entitled to share, a team or enterprise plan that permits it, or your own local models via the OpenAI-compatible adapter.",
  },
  {
    q: "What can a stranger's prompt do to my machine?",
    a: "Every job runs inside an OS-level sandbox — seatbelt on macOS, bubblewrap on Linux, or a container anywhere — in a fresh directory that is deleted when the job ends. Your credentials, including the payout key, are unreadable, and writes are confined to the job directory (see Security above). It is still code from a stranger: run the node in a container or a VM for the strongest boundary, or set XORV_SAFE_MODE=1 to disable tools entirely and sell text generation only.",
  },
  {
    q: "Do I need ETH to pay for a job?",
    a: "No. Gas on Arbitrum is ETH, but a buyer never spends any: you sign an EIP-3009 authorization, which is typed data rather than a transaction, and Xorv's own facilitator relays it and pays the gas. All you hold is the stablecoin you pay with — USDG by default, or USDC. Providers need nothing either: any address can receive USDG immediately, with no setup at all.",
  },
  {
    q: "What stops a provider taking the money and not doing the work?",
    a: "The provider never has it until the work is delivered. The payment sits in XorvEscrow; the broker releases it when the result arrives, with the result's hash on chain. A provider that fails is replaced (the escrow's payee changes, the money doesn't move) or the buyer is refunded — and either way the failure is written into the provider's on-chain reputation, which is what the matcher ranks on.",
  },
  {
    q: "Why Arbitrum, and why USDG?",
    a: "Because per-job payments only work where fees are a rounding error and blocks are fast: on Arbitrum a settlement costs a fraction of a cent and lands in well under a second, so a $0.001 job is viable and a buyer isn't waiting on confirmations. It runs on Arbitrum Sepolia and on Robinhood Chain Testnet, an Arbitrum chain, from the same code. Jobs are priced in Paxos USDG, a regulated dollar stablecoin that supports EIP-3009 — so the buyer's side is an EIP-712 signature every wallet already produces, and no gas token is ever needed. USDC is accepted too.",
  },
  {
    q: "What if the broker disappears with my job?",
    a: "Then you refund yourself. Every escrowed job has a deadline, and after it XorvEscrow.refund can be called by anyone — the money can only go back to the buyer who paid. The broker's key can fund, release, refund and reassign; it can never send escrowed money anywhere else, and the contract's owner can't touch it either. The job page shows a refund button the moment it's allowed.",
  },
  {
    q: "Is the broker a middleman that can take a cut?",
    a: "It isn't the payee: the escrow is, and it pays the provider. The fee is set in the contract, snapshotted per job so it can't be raised on work already paid for, capped at 5% in code, and currently zero.",
  },
  {
    q: "Why is the registry written in Rust?",
    a: "Because it's the contract written on every settled job, so its per-call cost matters most — and Arbitrum Stylus runs Rust as WASM with cheaper compute and storage than the EVM. The Solidity escrow calls it inside each release, refund and reassignment with a fixed gas budget and a try/catch, so a registry problem can never hold a payment hostage.",
  },
  {
    q: "Can an agent use this without a human?",
    a: "That's the point. Xorv ships an MCP server: an agent discovers capacity, prices a job, pays for it on-chain and gets the result back with an Arbiscan link — no account, no card, no human in the loop. It carries a hard per-call spending ceiling, because a model that can spend without a bound is a model that can empty an account through a loop it didn't mean to write.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <Section id="faq" className="border-t border-[var(--line)]">
      <Reveal>
        <SectionHeading title="The questions worth asking" sub="Including the ones with awkward answers." />
      </Reveal>

      <div className="mx-auto mt-14 max-w-3xl border-t border-[var(--line)]">
        {FAQ.map((item, i) => {
          const isOpen = open === i;
          return (
            <Reveal key={item.q} delay={Math.min(i * 0.035, 0.18)}>
              <div className="border-b border-[var(--line)]">
                <h3>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center justify-between gap-6 py-5 text-left"
                  >
                    <span
                      className={cn(
                        "text-[15.5px] font-medium tracking-[-0.01em] transition-colors",
                        isOpen ? "text-fg" : "text-fg-2 hover:text-fg",
                      )}
                    >
                      {item.q}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "relative mt-1 h-[9px] w-[9px] shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                        isOpen && "rotate-45",
                      )}
                    >
                      <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-fg-3" />
                      <span
                        className={cn(
                          "absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-fg-3 transition-opacity duration-300",
                          isOpen && "opacity-0",
                        )}
                      />
                    </span>
                  </button>
                </h3>
                <AnimatePresence initial={false}>
                  {isOpen ? (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="measure pb-6 text-[14.5px] leading-relaxed text-fg-2">
                        {item.a}
                      </p>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            </Reveal>
          );
        })}
      </div>
    </Section>
  );
}

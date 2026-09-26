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
    a: "Each job runs in a fresh empty directory under ~/.xorv/jobs that is deleted when the job ends, and that directory is the agent's working directory. But these CLIs can run shell commands, and a shell command can leave a directory — so this is blast-radius reduction, not a sandbox. Run the node in a container or a VM if you want a real boundary, or set XORV_SAFE_MODE=1 to disable tools entirely and sell text generation only.",
  },
  {
    q: "How do I get paid if I hold no HBAR?",
    a: "You don't need any. Xorv runs its own x402 facilitator, which signs as fee payer and covers the network fee on every settlement. Your account needs only to be able to receive USDC — and accounts with automatic association slots can do that with no setup at all.",
  },
  {
    q: "What stops a provider taking the money and not doing the work?",
    a: "Payment settles before the job runs, because a signed Hedera transaction expires after 180 seconds and a five-minute job would outlive it. The protection is at the network level: a failed job is reassigned to another provider at no extra cost to the buyer, and the failure counts against the original provider's success rate, which is what the matcher sorts on.",
  },
  {
    q: "Why Hedera rather than an EVM chain?",
    a: "Three properties this specifically needs: fixed, predictable fees measured in hundredths of a cent, so a sub-cent job isn't eaten by gas; finality in about three seconds, so the buyer isn't waiting on confirmations; and a native fee-payer model, which is what lets buyers transact without holding the gas token. Consensus Service also gives an ordered public audit log without deploying a contract.",
  },
  {
    q: "Is the broker a middleman that can take a cut?",
    a: "It isn't the payee. The 402 response names the matched provider's own Hedera account as payTo, so funds move directly from buyer to provider in one transfer and the broker never has custody. The protocol fee is currently zero.",
  },
  {
    q: "Can an agent use this without a human?",
    a: "That's the point. Xorv ships an MCP server: an agent discovers capacity, prices a job, pays for it on-chain and gets the result back with a HashScan link — no account, no card, no human in the loop. It carries a hard per-call spending ceiling, because a model that can spend without a bound is a model that can empty an account through a loop it didn't mean to write.",
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

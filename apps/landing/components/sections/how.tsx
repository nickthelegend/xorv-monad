import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";

/**
 * How a job gets paid for.
 *
 * Numbered, and the numbers are load-bearing: this is a protocol sequence where
 * step 3 cannot happen before step 2, and the reader needs the order. Rendered
 * as a ruled list rather than a card grid — five equal boxes would flatten a
 * sequence into a menu.
 */
const STEPS = [
  {
    n: "01",
    title: "Someone posts a job",
    body: "A prompt, a preferred model, a price ceiling. The network matches it to the cheapest live provider that can run it — liveness proven by heartbeat, not by a status page.",
  },
  {
    n: "02",
    title: "The network quotes a price",
    body: "The quote pins one provider at one price and answers HTTP 402 with the exact amounts, payable in USDC or HBAR.",
  },
  {
    n: "03",
    title: "The buyer signs a transfer",
    body: "A real Hedera transaction, signed but unsubmitted. Xorv's facilitator adds the second signature and pays the gas, so the buyer only ever needs the stablecoin.",
  },
  {
    n: "04",
    title: "Money moves, then the job runs",
    body: "Settlement lands in about three seconds — buyer to provider, directly. The broker never takes custody. Then the job is dispatched and streams back live.",
  },
  {
    n: "05",
    title: "A receipt goes on-chain",
    body: "Job id, provider, amount, transaction id and a SHA-256 of the result are written to a Hedera Consensus Service topic. Public, ordered, append-only.",
  },
];

export function How() {
  return (
    <Section id="how">
      <Reveal>
        <SectionHeading
          title="A job, a payment and a receipt — in one request"
          sub="x402 turns HTTP 402 from a status code nobody used into a working payment rail. Xorv runs the whole loop on Hedera."
        />
      </Reveal>

      <ol className="mx-auto mt-16 max-w-3xl">
        {STEPS.map((step, i) => (
          <Reveal key={step.n} delay={i * 0.05}>
            <li className="group grid grid-cols-[2.5rem_1fr] gap-x-5 border-t border-[var(--line)] py-7 sm:grid-cols-[3.5rem_1fr] sm:gap-x-8">
              <span className="mono tnum pt-0.5 text-[12px] text-fg-4 transition-colors group-hover:text-fg-2">
                {step.n}
              </span>
              <div>
                <h3 className="text-[16.5px] font-medium tracking-[-0.015em] text-fg">
                  {step.title}
                </h3>
                <p className="measure mt-2 text-[14.5px] leading-relaxed text-fg-2">{step.body}</p>
              </div>
            </li>
          </Reveal>
        ))}
        <li className="border-t border-[var(--line)]" aria-hidden />
      </ol>

      <Reveal delay={0.1}>
        <p className="measure mx-auto mt-12 text-center text-[13.5px] leading-relaxed text-fg-3">
          Payment settles <em className="not-italic text-fg-2">before</em> the job runs. A signed
          Hedera transaction is only valid for 180 seconds, so waiting for a five-minute coding job
          would leave the provider unpaid for work already done. A failed job is reassigned to
          another provider at no extra charge.
        </p>
      </Reveal>
    </Section>
  );
}

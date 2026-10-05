import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";
import { PRIMARY_TOKEN } from "@/lib/links";

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
    body: "The quote pins one provider at one price and answers HTTP 402 with the exact amount, the token, and the EIP-712 domain to sign against.",
  },
  {
    n: "03",
    title: "The buyer signs an authorization",
    body: "Not a transaction — an EIP-3009 authorization, which is typed data. It is never broadcast and never enters a mempool. Xorv's facilitator relays it and pays the fee, so the buyer needs nothing but the stablecoin.",
  },
  {
    n: "04",
    title: "The money waits in escrow while the job runs",
    body: "The authorization funds XorvEscrow, not the provider, and the signature's nonce is derived from the job itself — so it can only ever pay for this job, by this deadline. Then the job is dispatched and streams back live.",
  },
  {
    n: "05",
    title: "Delivered: released. Failed: refunded.",
    body: "When the result arrives, the escrow pays the provider and records a SHA-256 of the result next to the payment. If the job fails it's reassigned or refunded — and if nobody settles it by the deadline, anyone can refund the buyer.",
  },
  {
    n: "06",
    title: "Reputation is written by the payment",
    body: "The same transaction that pays or refunds records the outcome in XorvRegistry, on Monad. A provider's track record can't be claimed, only earned — and the matcher ranks on it.",
  },
];

export function How() {
  return (
    <Section id="how">
      <Reveal>
        <SectionHeading
          title="A job, a payment and a receipt — in one request"
          sub={`x402 turns HTTP 402 from a status code nobody used into a working payment rail. Xorv runs the whole loop on Monad, in ${PRIMARY_TOKEN.symbol}, and the buyer never touches MON.`}
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
          The authorization is redeemed <em className="not-italic text-fg-2">before</em> the job
          runs, because it carries a validity window a five-minute coding job would outlive. What
          waits is the escrowed balance — so the provider knows the money is there, and the buyer
          knows it can come back.
        </p>
      </Reveal>
    </Section>
  );
}

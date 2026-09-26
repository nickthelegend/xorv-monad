import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";

/**
 * How a job gets paid for.
 *
 * Numbered, and the numbers are load-bearing: this is a protocol sequence where
 * step 3 cannot happen before step 2, and the reader needs the order. Rendered
 * as a ruled list rather than a card grid — six equal boxes would flatten a
 * sequence into a menu.
 */
const STEPS = [
  {
    n: "01",
    title: "Someone posts a job",
    body: "A prompt, an optional model, a price ceiling. Hunyuan hy4 screens the prompt, Qwen 3.8 Max picks a model when the buyer didn't, and the matcher takes the cheapest live provider that can run it — liveness proven by heartbeat, not by a status page.",
  },
  {
    n: "02",
    title: "The network answers 402",
    body: "The quote freezes one provider at one price, single-use, for five minutes. The paid request answers HTTP 402 with the exact USDC amount — and the provider's own address as the payee, never the broker's.",
  },
  {
    n: "03",
    title: "The buyer signs, and pays no gas",
    body: "An EIP-712 signature over an EIP-3009 transferWithAuthorization — a message, not a transaction. The facilitator submits it and pays the MON gas, so the buyer only ever holds USDC. In the app, a Privy embedded wallet does the signing.",
  },
  {
    n: "04",
    title: "Money moves, then the job runs",
    body: "Settlement lands in one Monad block — about 300 ms, final in well under a second — buyer to provider, directly. The broker never takes custody. Then the job is dispatched to the provider's node and streams back live.",
  },
  {
    n: "05",
    title: "A receipt goes on-chain",
    body: "XorvLedger records the job, the provider's ERC-8004 agent, buyer, payee, amount, the settlement transaction, and hashes of the prompt and the result. It refuses any receipt whose payee isn't the agent's registered wallet.",
  },
  {
    n: "06",
    title: "The buyer rates it — gaslessly",
    body: "A second EIP-712 signature, relayed by the broker. The contract checks it came from the wallet that paid, allows one rating per job, and forwards it to the ERC-8004 Reputation Registry. Kimi K3 scores every public result there too.",
  },
];

export function How() {
  return (
    <Section id="how">
      <Reveal>
        <SectionHeading
          title="A job, a payment and a receipt — in one request"
          sub="x402 turns HTTP 402 from a status code nobody used into a working payment rail. Xorv runs the whole loop on Monad, and every step that moves money or reputation leaves an event you can read."
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
          Payment settles <em className="not-italic text-fg-2">before</em> the job runs. The provider
          is about to spend real quota on a stranger&rsquo;s prompt, and on Monad paying first costs
          the buyer a third of a second. The authorization carries a single-use nonce and expires
          with the quote, so it can&rsquo;t be replayed or cashed late. A failed job is reassigned
          to another provider at no extra charge.
        </p>
      </Reveal>
    </Section>
  );
}

import { Reveal } from "@/components/ui/reveal";
import { Button, Section } from "@/components/ui/kit";
import { Command } from "@/components/ui/command";
import { REPO_URL } from "@/lib/links";

/**
 * The provider pitch.
 *
 * A split: the argument on the left, the three commands that make it true on
 * the right. The four claims underneath are set as a definition list rather
 * than four equal cards — they are answers to objections, not features, and
 * they read better as prose than as boxes.
 */
const CLAIMS = [
  [
    "You keep 100%",
    "The protocol fee is zero, and payment goes from the buyer's account to yours in a single transfer. Xorv is never the payee, so there is nothing to withhold.",
  ],
  [
    "You never need HBAR",
    "Xorv's facilitator is the fee payer on every settlement. Your account can hold nothing but earnings and still get paid.",
  ],
  [
    "You set the price",
    "Per capability, per job. The cheapest matching provider wins, so the market decides what idle Claude quota is worth. `xorv test` warns if you price below cost.",
  ],
  [
    "You stay behind NAT",
    "The node dials out to the broker. No port forwarding, no inbound surface on your machine. A Cloudflare tunnel is optional, not required.",
  ],
] as const;

export function Earn() {
  return (
    <Section id="earn" className="border-t border-[var(--line)]">
      <div className="grid gap-14 lg:grid-cols-[1fr_1fr] lg:items-start lg:gap-20">
        <div>
          <Reveal>
            <h2 className="display-sm text-balance">
              Ninety seconds from install to income
            </h2>
            <p className="measure mt-5 text-[15px] leading-relaxed text-fg-2">
              Xorv drives the agent CLIs you already have installed and signed in. It never asks for
              an API key, because it never calls an API on your behalf — it runs the same binary you
              run.
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="mt-8">
              <Button href={REPO_URL} variant="secondary" external>
                Read the provider guide
              </Button>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.06}>
          <div className="space-y-2.5">
            <Command>npm i -g @xorv/cli</Command>
            <Command>xorv init</Command>
            <Command>xorv start</Command>
          </div>
        </Reveal>
      </div>

      <dl className="mt-20 grid gap-x-16 gap-y-10 sm:grid-cols-2">
        {CLAIMS.map(([title, body], i) => (
          <Reveal key={title} delay={i * 0.05}>
            <div className="border-t border-[var(--line)] pt-5">
              <dt className="text-[15px] font-medium tracking-[-0.01em] text-fg">{title}</dt>
              <dd className="mt-2 text-[14px] leading-relaxed text-fg-2">{body}</dd>
            </div>
          </Reveal>
        ))}
      </dl>
    </Section>
  );
}

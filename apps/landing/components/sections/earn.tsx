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
    "The protocol fee is zero. The buyer's payment waits in the escrow contract while your node runs the job, and the contract pays the whole amount to your address the moment the result is delivered. Xorv's operator never holds the money — the contract can only pay you or refund the buyer.",
  ],
  [
    "You never need MON",
    "Gas on Monad is MON, and you spend none of it: Xorv's facilitator pays the fee on every settlement. A brand-new address can receive the stablecoin immediately, having done nothing.",
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
      {/* Zero-minimum tracks: a `1fr`/auto track grows to its longest command instead of truncating it. */}
      <div className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:gap-20">
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
            <Command>git clone https://github.com/nickthelegend/xorv-monad && cd xorv-monad</Command>
            <Command>pnpm install && pnpm build</Command>
            <Command>alias xorv="node $PWD/packages/cli/dist/index.js"</Command>
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

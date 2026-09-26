import { Reveal } from "@/components/ui/reveal";
import { Button, Section } from "@/components/ui/kit";
import { Command } from "@/components/ui/command";
import { CLI_GUIDE_URL, REPO_URL } from "@/lib/links";

/**
 * The provider pitch.
 *
 * A split: the argument on the left, the commands that make it true on the
 * right. The claims underneath are set as a definition list rather than equal
 * cards — they are answers to objections, not features, and they read better
 * as prose than as boxes.
 *
 * Install is from source until the Monad build of the CLI (0.2.0) is on npm.
 * What npm serves under that name today is the pre-port prototype, and telling
 * a provider to install it would hand them a node that can't be paid here.
 */
const STEPS = [
  {
    cmd: `git clone ${REPO_URL} && cd xorv-monad`,
    note: "Monad build of the CLI — from source until it's on npm",
  },
  { cmd: "pnpm install && pnpm build", note: "then `pnpm link --global` in packages/cli" },
  { cmd: "xorv init", note: "detects your agents, sets prices, asks where to get paid" },
  { cmd: "xorv identity register", note: "optional — mints your ERC-8004 agent" },
  { cmd: "xorv start", note: "goes live and starts taking jobs" },
] as const;

const CLAIMS = [
  [
    "You keep 100%",
    "The protocol fee is zero, and payment goes from the buyer's wallet to yours in a single USDC transfer. Xorv is never the payee, so there is nothing to withhold.",
  ],
  [
    "No key on this machine",
    "A provider never signs anything to get paid. `xorv init` can take just an address — your Privy wallet from the Xorv app, say — and then the node stores no private key at all.",
  ],
  [
    "You never need MON to earn",
    "The facilitator pays the gas on every settlement, and any Monad address can receive USDC with no opt-in. The one thing you'd pay gas for is the optional identity: a single transaction.",
  ],
  [
    "Reputation you keep",
    "With an ERC-8004 identity, receipts and ratings accrue to your agent in Monad's public registries, where any marketplace can read them — not in Xorv's database.",
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
            <h2 className="display-sm text-balance">From idle quota to income in five commands</h2>
            <p className="measure mt-5 text-[15px] leading-relaxed text-fg-2">
              Xorv drives the agent CLIs you already have installed and signed in — Claude Code,
              Codex, Qwen Code — running the same binary you run. For Qwen 3.8 Max, Kimi K3 and
              Hunyuan it streams from the API key you set in your own environment, which never
              reaches a job.
            </p>
            <p className="measure mt-4 text-[15px] leading-relaxed text-fg-2">
              Payouts arrive in USDC, before the job runs, at the address you chose.
            </p>
          </Reveal>

          <Reveal delay={0.08}>
            <div className="mt-8">
              <Button href={CLI_GUIDE_URL} variant="secondary" external>
                Read the provider guide
              </Button>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.06}>
          <ol className="space-y-3.5">
            {STEPS.map((step) => (
              <li key={step.cmd}>
                <Command>{step.cmd}</Command>
                <p className="mt-1.5 pl-4 text-[12px] leading-relaxed text-fg-4">{step.note}</p>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>

      <dl className="mt-20 grid gap-x-16 gap-y-10 sm:grid-cols-2">
        {CLAIMS.map(([title, body], i) => (
          <Reveal key={title} delay={Math.min(i * 0.05, 0.2)}>
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

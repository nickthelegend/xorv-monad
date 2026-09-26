import type { ReactNode } from "react";
import { Hunyuan, Kimi, Qwen } from "@lobehub/icons";
import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";
import { ERC8004_URL, MONAD_URL } from "@/lib/links";

/**
 * What Xorv is built with.
 *
 * Not a logo wall. A row of sponsor logos says "we used these" and nothing
 * else; the claim worth making is *where each one sits in the loop*, and that
 * is a sentence, not a picture. So every entry is a wordmark set in the page's
 * own type, a one-word role, and what it actually does.
 *
 * Text only, on purpose: no fetched third-party logos. The three model marks
 * are the monochrome glyphs from `@lobehub/icons` that the adapter table and
 * the app's model picker already ship.
 */

interface Item {
  name: string;
  role: string;
  href: string;
  mark?: ReactNode;
  body: string;
}

const ITEMS: Item[] = [
  {
    name: "Monad",
    role: "chain",
    href: MONAD_URL,
    body: "Settlement, receipts and reputation all live here. Blocks every ~300 ms mean paying before the job runs costs the buyer a third of a second, and gas is small enough that a one-cent job isn't eaten by it.",
  },
  {
    name: "Privy",
    role: "wallets",
    href: "https://privy.io",
    body: "The app's embedded wallet signs each x402 payment and each gasless rating right in the browser — sign in with email, no extension. Agents buying over MCP pay from a Privy server wallet held to a spending policy.",
  },
  {
    name: "Envio",
    role: "indexer",
    href: "https://envio.dev",
    body: "HyperIndex follows XorvLedger and the ERC-8004 registries and derives earnings, success rate and reputation per provider. It powers the live stats and the leaderboard further down this page.",
  },
  {
    name: "MetaMask Agent Wallet",
    role: "agent wallet",
    href: "https://docs.metamask.io/agent-wallet/",
    body: "The mm xorv plugin lets an agent quote, pay for and rate jobs from its MetaMask wallet. MetaMask signs the EIP-3009 authorization under the user's own policy; the plugin never sees a key.",
  },
  {
    name: "ERC-8004",
    role: "identity",
    href: ERC8004_URL,
    body: "Providers mint an agent on Monad's Identity Registry. A receipt binds to it only when the payee is the agent's own wallet, and ratings land in the Reputation Registry, where any marketplace can read them.",
  },
  {
    name: "Qwen 3.8 Max",
    role: "router",
    href: "https://www.qwencloud.com/models/qwen3.8-max-0902",
    mark: <Qwen size={15} />,
    body: "Routes each job that doesn't name a model to the adapter best suited to it, before the quote is frozen — so the price the buyer signs is for the model that will run.",
  },
  {
    name: "Hunyuan hy4",
    role: "screen",
    href: "https://www.tencentcloud.com/products/tokenhub",
    mark: <Hunyuan size={15} />,
    body: "Screens every prompt before any provider sees it, and refuses the quote when it should. A provider renting out their own machine shouldn't be the first line of defence.",
  },
  {
    name: "Kimi K3",
    role: "verifier",
    href: "https://platform.kimi.ai/docs/models",
    mark: <Kimi size={15} />,
    body: "Scores every public result against its prompt and writes the score to ERC-8004 reputation from the verifier's own address — on-chain, next to the buyer's rating.",
  },
  {
    name: "Mera",
    role: "privacy",
    href: "https://docs.monad.xyz/guides/mera",
    body: "Private jobs are sealed to a key derived from your passkey. The provider encrypts the result before it leaves the node, so the broker stores only ciphertext — and you can open it on a second device.",
  },
];

export function Stack() {
  return (
    <Section id="stack" className="border-t border-[var(--line)]">
      <Reveal>
        <SectionHeading
          title="Built with"
          sub="Every name here does a job in the loop above — none of them is here as decoration."
        />
      </Reveal>

      <Reveal delay={0.06}>
        <ul className="mx-auto mt-14 grid max-w-5xl gap-px overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-3">
          {ITEMS.map((item) => (
            <li key={item.name} className="flex flex-col bg-black p-6">
              <div className="flex items-baseline justify-between gap-3">
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-fg underline-offset-4 hover:underline"
                >
                  {item.mark ? (
                    <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-2">
                      {item.mark}
                    </span>
                  ) : null}
                  {item.name}
                </a>
                <span className="mono shrink-0 text-[11px] text-fg-4">{item.role}</span>
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-fg-2">{item.body}</p>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal delay={0.1}>
        <p className="measure mx-auto mt-10 text-center text-[13.5px] leading-relaxed text-fg-3">
          The three AI roles are switched on per broker and fail open: a model that is down or slow
          degrades a job to the plain price matcher, and never blocks a quote or a result.
        </p>
      </Reveal>
    </Section>
  );
}

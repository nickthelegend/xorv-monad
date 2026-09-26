"use client";

import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";

/**
 * The objection, answered before it's raised.
 *
 * Anyone who understands what Xorv is asks the same question within about ten
 * seconds: *you want me to run strangers' prompts on my laptop?* A marketing
 * paragraph about "enterprise-grade security" is the worst possible answer —
 * it sounds like every project that has none.
 *
 * So the section is a transcript. These are real denials from a real job on a
 * real machine, and the framing that matters is the last line: the payout key
 * is the thing an attacker actually wants, because it receives every payment
 * the provider will ever earn. Showing it denied is the whole argument.
 *
 * The honesty block at the bottom is not a hedge, it's the reason to believe
 * the rest. A security section with no limits section is a sales page.
 */

/** Real output. Left exactly as the terminal produced it. */
const TRANSCRIPT = [
  { cmd: "cat ~/.xorv/config.json", err: "Operation not permitted", note: "the payout private key" },
  { cmd: "ls ~/.ssh", err: "Operation not permitted" },
  { cmd: "cat ~/.aws/credentials", err: "Operation not permitted" },
  { cmd: "security find-internet-password -w", err: "SecKeychainSearchCopyNext" },
  { cmd: "touch ~/escaped.txt", err: "Operation not permitted" },
];

const DENIED = [
  ["~/.xorv", "your payout private key"],
  ["~/.ssh", "git and server access"],
  ["~/.aws · ~/.kube · ~/.azure", "cloud credentials"],
  ["~/.config/gh · ~/.npmrc", "publish tokens"],
  ["login.keychain", "everything macOS stores"],
  ["browser profiles", "sessions and saved logins"],
];

const TIERS = [
  { name: "seatbelt", where: "macOS", what: "Credentials unreadable · writes confined to the job directory" },
  { name: "bubblewrap", where: "Linux", what: "Read-only root · private home · writes confined to the job directory" },
  { name: "container", where: "any host, opt-in", what: "Full isolation — the job never sees your filesystem" },
];

export function Security() {
  return (
    <Section id="security">
      <Reveal>
        <SectionHeading
          title="Strangers run code on your machine. Your keys never enter the room."
          sub="Every job is spawned inside an OS-level sandbox — not a scratch directory with good intentions. This is a real transcript from a paid job that tried to read them."
        />
      </Reveal>

      <div className="mx-auto mt-16 grid max-w-5xl gap-px overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--line)] lg:grid-cols-[1.35fr_1fr]">
        {/* The transcript. The argument is that these are real. */}
        <Reveal>
          <div className="h-full bg-black p-6 sm:p-8">
            <div className="flex items-center gap-2.5 border-b border-[var(--line)] pb-4">
              <span className="h-2 w-2 rounded-full bg-[var(--fg-4)]" aria-hidden />
              <span className="mono text-[11px] uppercase tracking-[0.14em] text-fg-4">
                job_AyyZcTv6J2ev · hostile prompt
              </span>
            </div>

            <div className="mono mt-5 space-y-3.5 text-[12.5px] leading-relaxed">
              {TRANSCRIPT.map((line) => (
                <div key={line.cmd}>
                  <div className="flex gap-2.5">
                    <span className="shrink-0 text-fg-4">$</span>
                    <span className="min-w-0 break-all text-fg-2">{line.cmd}</span>
                  </div>
                  <div className="mt-1 flex gap-2.5 pl-[1.15rem]">
                    <span className="shrink-0 text-fg-4">✖</span>
                    <span className="min-w-0 break-all text-fg">{line.err}</span>
                    {line.note ? (
                      <span className="hidden shrink-0 text-fg-4 sm:inline">← {line.note}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            <p className="measure mt-6 border-t border-[var(--line)] pt-5 text-[13px] leading-relaxed text-fg-3">
              The first line is the one that matters. That file holds the key that receives every
              payment you earn — so it is the first thing a hostile prompt asks for, and the first
              thing the sandbox refuses.
            </p>
          </div>
        </Reveal>

        {/* What's denied, and how the environment is handled. */}
        <Reveal delay={0.06}>
          <div className="h-full bg-black p-6 sm:p-8">
            <h3 className="text-[11px] uppercase tracking-[0.14em] text-fg-4">Unreadable by a job</h3>
            <ul className="mt-5 space-y-3.5">
              {DENIED.map(([path, why]) => (
                <li key={path} className="flex flex-col gap-0.5">
                  <span className="mono break-all text-[12.5px] text-fg">{path}</span>
                  <span className="text-[12.5px] text-fg-3">{why}</span>
                </li>
              ))}
            </ul>

            <h3 className="mt-8 border-t border-[var(--line)] pt-6 text-[11px] uppercase tracking-[0.14em] text-fg-4">
              And the environment
            </h3>
            <p className="mt-4 text-[13px] leading-relaxed text-fg-2">
              A job inherits an allowlist, not your shell. It never sees{" "}
              <span className="mono text-fg">AWS_SECRET_ACCESS_KEY</span>,{" "}
              <span className="mono text-fg">GITHUB_TOKEN</span>, or whatever variable some vendor
              invents next year — an allowlist excludes it without anyone editing a denylist.
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-fg-3">
              CPU seconds, file size and process count are capped, so a fork bomb hits a wall
              instead of your machine.
            </p>
          </div>
        </Reveal>
      </div>

      {/* Tiers — which mechanism, not the word "sandboxed". */}
      <Reveal delay={0.1}>
        <ul className="mx-auto mt-14 max-w-5xl">
          {TIERS.map((tier) => (
            <li
              key={tier.name}
              className="grid gap-x-6 gap-y-1 border-t border-[var(--line)] py-5 sm:grid-cols-[9rem_9rem_1fr] sm:items-baseline"
            >
              <span className="mono text-[13px] text-fg">{tier.name}</span>
              <span className="text-[12.5px] text-fg-4">{tier.where}</span>
              <span className="text-[13.5px] leading-relaxed text-fg-2">{tier.what}</span>
            </li>
          ))}
          <li className="border-t border-[var(--line)]" aria-hidden />
        </ul>
      </Reveal>

      {/* The limits. This is what makes the rest credible. */}
      <Reveal delay={0.14}>
        <div className="mx-auto mt-14 max-w-3xl rounded-lg border border-[var(--line)] p-6 sm:p-8">
          <h3 className="text-[11px] uppercase tracking-[0.14em] text-fg-4">
            What this does not do
          </h3>
          <p className="mt-4 text-[13.5px] leading-relaxed text-fg-2">
            A job can read the agent session it runs on. The agent&rsquo;s own token has to be in
            its environment for the agent to work — that is the capacity you are renting out, and
            no profile closes it while the product still functions.{" "}
            <span className="mono text-fg">XORV_SANDBOX=container</span> closes it too.
          </p>
          <p className="mt-3 text-[13.5px] leading-relaxed text-fg-2">
            On a host with neither seatbelt nor bubblewrap there is no filesystem boundary at all.{" "}
            <span className="mono text-fg">xorv doctor</span> names the tier you actually have
            rather than printing the word &ldquo;sandboxed&rdquo; and letting you assume the rest.
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

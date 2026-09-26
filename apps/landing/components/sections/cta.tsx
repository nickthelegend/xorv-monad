import { Reveal } from "@/components/ui/reveal";
import { Button, Section } from "@/components/ui/kit";
import { Command } from "@/components/ui/command";
import { APP_URL, REPO_URL } from "@/lib/links";

export function Cta() {
  return (
    <Section className="border-t border-[var(--line)] pb-32">
      <Reveal>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="display-sm text-balance">
            There is a subscription sitting idle on your machine right now
          </h2>
          <p className="measure mx-auto mt-5 text-[15px] leading-relaxed text-fg-2">
            Point it at the network and let it pay for itself. One install, one wizard, and it
            starts taking jobs.
          </p>

          <div className="mx-auto mt-9 max-w-sm text-left">
            <Command>npm i -g @xorv/cli &amp;&amp; xorv init</Command>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
            <Button href={APP_URL}>Post a job</Button>
            <Button href={REPO_URL} variant="secondary" external>
              Read the source
            </Button>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

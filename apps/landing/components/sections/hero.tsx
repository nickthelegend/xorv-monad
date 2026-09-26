"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { EASE, useEntrance } from "@/lib/motion";
import { Button, LiveDot, Pill } from "@/components/ui/kit";
import { NodePanel } from "@/components/ui/node-panel";
import { APP_URL, REPO_URL } from "@/lib/links";

/**
 * The hero, and the page's one authored motion moment.
 *
 * Everything below it uses a single restrained reveal. Giving each section its
 * own entrance is how a page ends up twitching rather than having a rhythm.
 *
 * The headline sets in plain white. Weight and scale carry the emphasis —
 * a gradient fill here would be the loudest thing on a page whose entire
 * argument is restraint.
 */
export function Hero() {
  const animate = useEntrance();

  const rise = (delay: number) =>
    animate
      ? {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.7, ease: EASE, delay },
        }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  return (
    <section className="relative overflow-hidden px-6 pt-32 md:pt-40">
      <div className="relative mx-auto max-w-4xl text-center">
        <motion.div {...rise(0)}>
          <Pill href={REPO_URL} className="mb-7">
            <LiveDot />
            Live on Hedera testnet
            <span aria-hidden className="text-fg-4">
              ·
            </span>
            <span className="text-fg-3">open source</span>
          </Pill>
        </motion.div>

        <motion.h1
          {...rise(0.08)}
          className="display text-balance"
        >
          Your AI subscription
          <br />
          is idle most of the day
        </motion.h1>

        <motion.p
          {...rise(0.16)}
          className="measure mx-auto mt-7 text-[16.5px] leading-relaxed text-fg-2"
        >
          Xorv turns that idle quota into income. One command, and the Claude, Codex or Grok plan
          you already pay for starts taking jobs from the network — settling per job, in USDC,
          straight to your wallet.
        </motion.p>

        <motion.div {...rise(0.24)} className="mt-9 flex flex-wrap items-center justify-center gap-2.5">
          <Button href={APP_URL}>Post a job</Button>
          <Button href={REPO_URL} variant="secondary" external>
            Start earning
          </Button>
        </motion.div>

        <motion.p {...rise(0.32)} className="mono mt-7 text-[12.5px] text-fg-4">
          npm i -g @xorv/cli
        </motion.p>
      </div>

      <HeroPanel animate={animate} />
    </section>
  );
}

/**
 * The product, framed.
 *
 * Ripar puts a browser-chromed dashboard on a warm panel here. Xorv's product
 * is a terminal, so that is what goes in the frame — and it types itself out
 * once, which is the closest thing to a demo a static page can offer.
 */
function HeroPanel({ animate }: { animate: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      ref={ref}
      initial={animate ? { opacity: 0, y: 36 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, ease: EASE, delay: 0.3 }}
      className="relative mx-auto mt-20 max-w-5xl md:mt-24"
    >
      {/* A single hairline frame that opens downward into the page. */}
      <div className="rounded-t-[28px] border border-b-0 border-[var(--line)] bg-surface px-2 pt-2 md:rounded-t-[36px] md:px-3 md:pt-3">
        <NodePanel animate={visible && animate} />
      </div>
    </motion.div>
  );
}

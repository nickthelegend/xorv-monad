"use client";

import { useRef, type ReactNode } from "react";
import { motion, useInView } from "motion/react";
import { cn } from "@/lib/utils";
import { EASE, useEntrance } from "@/lib/motion";

/**
 * The page's single reveal.
 *
 * One shared entrance for everything below the hero, so the page has a rhythm
 * rather than a different trick per section. Short and exponential — it should
 * register as the content settling, not as an animation you were asked to
 * watch.
 *
 * Always renders the same element. Only the `initial` prop varies, so enabling
 * motion never remounts the subtree — swapping between a plain `div` and a
 * `motion.div` is what let already-visible content get re-hidden. When motion
 * is off, `initial={false}` tells the library to start at the settled values
 * and skip the transition entirely.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -12% 0px" });
  const animate = useEntrance();

  const hidden = { opacity: 0, y: 14 };
  const shown = { opacity: 1, y: 0 };

  return (
    <motion.div
      ref={ref}
      className={cn(className)}
      initial={animate ? hidden : false}
      animate={animate && !inView ? hidden : shown}
      transition={{ duration: 0.55, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

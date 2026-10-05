"use client";

import { useEffect, useLayoutEffect, useState } from "react";

/** `useLayoutEffect` warns during SSR; fall back to `useEffect` there. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Should this surface animate its entrance?
 *
 * Two cases say no, and both produce the same failure if you get them wrong —
 * a blank page:
 *
 *  - **Reduced motion.** Respect it.
 *  - **The document is hidden.** Entrance animations are driven by
 *    `requestAnimationFrame`, which browsers do not fire for a backgrounded
 *    tab. An animation started there applies its opening frame (opacity 0) and
 *    then stops, so a link opened in a background tab reads as empty.
 *
 * ## The decision is made once, and never revisited
 *
 * An earlier version watched `visibilitychange` and flipped to `true` when the
 * tab was later focused. That was worse than the bug it fixed: content already
 * rendered in its final state would suddenly be told to start from opacity 0,
 * and anything the viewport had scrolled past stayed invisible. A gate that
 * can turn *on* after paint can hide things the user is already looking at.
 *
 * So: decided in a layout effect, before the first paint, and constant for the
 * component's life. A tab that was hidden at mount simply never animates —
 * which is the correct trade, because visible content always beats a
 * transition nobody was there to see.
 */
export function useEntrance(): boolean {
  const [canAnimate, setCanAnimate] = useState(false);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (document.hidden) return;
    // Runs before the browser paints, so enabling motion here does not flash
    // the final state first.
    setCanAnimate(true);
  }, []);

  return canAnimate;
}

export const EASE = [0.16, 1, 0.3, 1] as const;

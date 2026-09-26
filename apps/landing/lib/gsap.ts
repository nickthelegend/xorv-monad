"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

/**
 * Two motion libraries, on purpose — and only these two jobs.
 *
 * `motion/react` owns component-level enter/exit: it understands React's
 * lifecycle, `AnimatePresence` can animate an element that is being unmounted,
 * and that is the whole problem for a quote panel or a toast.
 *
 * GSAP owns the bento visuals, where the work is scroll-linked, sequenced
 * across many independent SVG nodes, and needs a timeline that can be scrubbed
 * and reversed. Rebuilding ScrollTrigger's cleanup and refresh handling on top
 * of an IntersectionObserver would be strictly worse code.
 *
 * The line is: if it mounts and unmounts, motion/react. If it is a scroll-bound
 * composition inside a single mounted node, GSAP.
 */

/** Matches the site's shared curve, so both libraries decelerate identically. */
export const EASE_OUT = "power3.out";

/**
 * Should a scroll-driven timeline run at all?
 *
 * Same rule the rest of the site follows: rAF does not fire in a backgrounded
 * tab, so a timeline started there applies its first frame and stops. Any
 * caller must be able to render the finished state instead.
 */
export function canAnimate(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return !document.hidden;
}

export { gsap, ScrollTrigger, useGSAP };

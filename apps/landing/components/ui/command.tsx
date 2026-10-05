"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A shell command you can copy.
 *
 * The page tells people to run four commands, and until now none of them could
 * be copied — you had to select the text by hand, and on a line that starts
 * with a decorative `$` you'd usually catch that too. The whole element is the
 * button.
 *
 * Motion earns its place here as **feedback**: the label swap is the only
 * signal that a click did anything, since the clipboard is invisible. It's a
 * rare action, so the 160ms crossfade is inside budget and never in the way.
 */
export function Command({ children, className }: { children: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(children);
    } catch {
      // Insecure origin, or permission refused. Saying nothing would be a lie —
      // fall through and leave the label alone so the click reads as a no-op.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1_600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy: ${children}`}
      className={cn(
        "group mono flex w-full items-center gap-3 rounded-lg border border-[var(--line)] bg-surface px-4 py-3 text-left text-[13px]",
        "transition-colors duration-200 hover:border-[var(--line-2)]",
        className,
      )}
    >
      <span aria-hidden className="select-none text-fg-4">
        $
      </span>
      <code className="min-w-0 flex-1 truncate text-fg">{children}</code>

      {/* Fixed width, so the swap never nudges the command sideways. */}
      <span className="relative ml-2 hidden w-[52px] shrink-0 text-right text-[11px] sm:block">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? "copied" : "copy"}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.16, ease: EASE }}
            className={cn(
              "block",
              copied ? "text-fg-2" : "text-fg-4 opacity-0 group-hover:opacity-100",
            )}
          >
            {copied ? "copied" : "copy"}
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  );
}

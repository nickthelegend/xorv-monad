import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The Xorv mark, monochrome.
 *
 * Two beams crossing but stopping short of centre, so a diamond of negative
 * space opens where they would meet — supply and demand routed through a hub
 * rather than colliding. The four terminals are nodes.
 *
 * Rendered in `currentColor` rather than the brand gradient. On a page built
 * from black, white and one hairline, a two-stop gradient in the top-left
 * corner would be the only decorative colour anywhere, and it would read as
 * decoration. The form carries the identity; the colour was never doing the
 * work.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("h-6 w-6", className)}
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <g strokeLinecap="round" strokeWidth="7">
        <path d="M14 14 L27 27" />
        <path d="M37 37 L50 50" />
        <path d="M50 14 L37 27" />
        <path d="M27 37 L14 50" />
      </g>
      <rect
        x="27.6"
        y="27.6"
        width="8.8"
        height="8.8"
        rx="2.2"
        transform="rotate(45 32 32)"
        fill="currentColor"
        stroke="none"
      />
      <g fill="currentColor" stroke="none">
        <circle cx="14" cy="14" r="3.1" />
        <circle cx="50" cy="50" r="3.1" />
        <circle cx="50" cy="14" r="3.1" />
        <circle cx="14" cy="50" r="3.1" />
      </g>
    </svg>
  );
}

/**
 * The header lockup — wordmark only.
 *
 * The mark is an X, and the wordmark starts with an X. Set side by side they
 * read as a stutter rather than a lockup: two X-shapes competing at the same
 * size, the eye resolving neither. The word alone is unambiguous, and the mark
 * still does its job everywhere it stands on its own — favicon, the closing
 * frame of the film, anywhere there is no text beside it to fight.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn("group flex items-center text-fg", className)}
      aria-label="Xorv, home"
    >
      <span className="text-[15px] font-semibold tracking-[-0.02em]">Xorv</span>
    </Link>
  );
}

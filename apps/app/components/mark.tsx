import { cn } from "@/lib/utils";

/**
 * The Xorv mark, monochrome.
 *
 * Rendered in `currentColor`. On a surface built from black, white and one
 * hairline, a two-stop gradient in the corner would be the only decorative
 * colour anywhere — the form carries the identity, not the fill.
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

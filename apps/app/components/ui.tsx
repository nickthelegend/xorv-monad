import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
   The app's component vocabulary.

   Same two-button set as the marketing site, same hairlines, same monochrome.
   An app that looks like a different product from its landing page is a
   product that has two design teams and no design.
--------------------------------------------------------------------------- */

type Variant = "primary" | "secondary" | "ghost";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg text-[13.5px] font-medium " +
  "transition-[background-color,border-color,color,transform] duration-200 " +
  "active:scale-[0.985] disabled:pointer-events-none disabled:opacity-40";

const variants: Record<Variant, string> = {
  primary: "bg-white text-black px-4 py-2.5 hover:bg-white/90",
  secondary:
    "px-4 py-2.5 text-fg border border-[var(--line-2)] hover:border-[var(--line-3)] hover:bg-white/[0.04]",
  ghost: "px-3 py-2 text-fg-2 hover:text-fg hover:bg-white/[0.05]",
};

export function Button({
  children,
  variant = "primary",
  href,
  external,
  className,
  ...props
}: {
  children: ReactNode;
  variant?: Variant;
  href?: string;
  external?: boolean;
} & Omit<ComponentProps<"button">, "ref">) {
  const cls = cn(base, variants[variant], className);
  if (href) {
    return (
      <Link
        href={href}
        className={cls}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </Link>
    );
  }
  return (
    <button className={cls} {...props}>
      {children}
    </button>
  );
}

/** A bordered region. Never nested — a card inside a card is a layout that gave up. */
export function Panel({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={cn("rounded-xl border border-[var(--line)] bg-surface", className)}>
      {children}
    </Tag>
  );
}

export function PageHeader({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {sub ? <p className="measure mt-1.5 text-[14px] leading-relaxed text-fg-2">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Status.
 *
 * Colour appears here and essentially nowhere else, because here it means
 * something: running, done, failed. A neutral dot for everything in between.
 */
const STATUS: Record<string, { dot: string; text: string; label?: string }> = {
  completed: { dot: "bg-live", text: "text-fg-2" },
  running: { dot: "bg-live", text: "text-fg" },
  assigned: { dot: "bg-fg-3", text: "text-fg-2" },
  paid: { dot: "bg-fg-3", text: "text-fg-2" },
  quoted: { dot: "bg-fg-4", text: "text-fg-3" },
  failed: { dot: "bg-fail", text: "text-fail" },
  expired: { dot: "bg-fg-4", text: "text-fg-3" },
  online: { dot: "bg-live", text: "text-fg-2" },
  busy: { dot: "bg-warn", text: "text-fg-2" },
  offline: { dot: "bg-fg-4", text: "text-fg-3" },
};

export function Status({ status, className }: { status: string; className?: string }) {
  const style = STATUS[status] ?? STATUS.quoted!;
  const pulsing = status === "running" || status === "online";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12.5px]", style.text, className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", style.dot, pulsing && "breathe")} />
      <span className="capitalize">{status}</span>
    </span>
  );
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--line)] px-6 py-16 text-center">
      <p className="text-[14px] font-medium text-fg-2">{title}</p>
      {hint ? <p className="measure text-[13px] leading-relaxed text-fg-4">{hint}</p> : null}
    </div>
  );
}

export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-white/[0.03]" />
      ))}
    </div>
  );
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-4 transition-colors hover:text-fg hover:underline"
    >
      {children}
    </Link>
  );
}

/** A label/value row. The app's densest and most-used primitive. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="shrink-0 text-[12.5px] text-fg-4">{label}</span>
      <span className="min-w-0 truncate text-right text-[12.5px] text-fg-2">{children}</span>
    </div>
  );
}

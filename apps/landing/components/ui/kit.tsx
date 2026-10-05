import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
   Buttons

   Solid white for the primary action, hairline for everything else. Two
   variants is the whole set: a page that needs a third is a page whose
   hierarchy hasn't been decided.
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

/* ---------------------------------------------------------------------------
   Section heading

   No eyebrow. A kicker that appears above every section stops being a signal
   and becomes grammar, so headings here carry themselves on size and weight.
--------------------------------------------------------------------------- */

export function SectionHeading({
  title,
  sub,
  align = "center",
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div className={cn(align === "center" ? "mx-auto max-w-2xl text-center" : "max-w-2xl", className)}>
      <h2 className="display-sm text-balance">
        {title}
      </h2>
      {sub ? (
        <p
          className={cn(
            "measure mt-4 text-[15px] leading-relaxed text-fg-2",
            align === "center" && "mx-auto",
          )}
        >
          {sub}
        </p>
      ) : null}
    </div>
  );
}

export function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("relative px-6 py-24 md:py-32", className)}>
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}

/** A hairline pill. Used once in the hero and once per status — not as chrome. */
export function Pill({
  children,
  href,
  className,
}: {
  children: ReactNode;
  href?: string;
  className?: string;
}) {
  const cls = cn(
    "inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/[0.02] px-3 py-1 text-[12.5px] text-fg-2",
    href && "transition-colors hover:border-[var(--line-2)] hover:text-fg",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={cls} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    );
  }
  return <span className={cls}>{children}</span>;
}

/** A live indicator. The only place green appears on the page. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex h-1.5 w-1.5", className)}>
      <span className="breathe absolute inline-flex h-full w-full rounded-full bg-live" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-live" />
    </span>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/kit";
import { APP_URL, NAV, REPO_URL } from "@/lib/links";
import { cn } from "@/lib/utils";

/**
 * The nav.
 *
 * Transparent over the hero, then a hairline and a backdrop once you leave it.
 * No border at rest — a rule under a nav that is sitting on the page's own
 * background is drawing a line for the sake of drawing a line.
 */
export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A menu that stays open while the page scrolls behind it is a bug.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
        scrolled || open
          ? "border-b border-[var(--line)] bg-black/70 backdrop-blur-xl"
          : "border-b border-transparent",
      )}
    >
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
        <Logo />

        <div className="hidden items-center gap-7 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-[13.5px] text-fg-2 transition-colors hover:text-fg"
            >
              {item.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 text-[13.5px] text-fg-2 transition-colors hover:text-fg"
          >
            GitHub
          </Link>
          <Button href={APP_URL} variant="secondary" className="px-3.5 py-2 text-[13px]">
            Open app
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="-mr-2 p-2 md:hidden"
        >
          <span className="flex h-3.5 w-5 flex-col justify-between">
            <span
              className={cn(
                "block h-px w-full bg-fg transition-transform duration-300",
                open && "translate-y-[6.5px] rotate-45",
              )}
            />
            <span className={cn("block h-px w-full bg-fg transition-opacity", open && "opacity-0")} />
            <span
              className={cn(
                "block h-px w-full bg-fg transition-transform duration-300",
                open && "-translate-y-[6.5px] -rotate-45",
              )}
            />
          </span>
        </button>
      </nav>

      {open ? (
        <div className="border-t border-[var(--line)] px-6 py-6 md:hidden">
          <div className="flex flex-col gap-5">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="text-[15px] text-fg-2"
              >
                {item.label}
              </a>
            ))}
            <Link
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[15px] text-fg-2"
            >
              GitHub
            </Link>
            <Button href={APP_URL} className="mt-2 w-full">
              Open app
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  );
}

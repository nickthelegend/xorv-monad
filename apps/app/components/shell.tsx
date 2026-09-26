"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Connect } from "@/components/connect";
import { api, type NetworkInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The app shell.
 *
 * A fixed rail rather than a top nav: this is an operator surface people leave
 * open, and a sidebar keeps the destination list visible without spending
 * vertical space that the job list wants. The rail also carries the one piece
 * of state that matters everywhere — is the broker reachable, and is anyone
 * online — so it never has to be repeated per page.
 */

const NAV = [
  { href: "/", label: "Jobs" },
  { href: "/providers", label: "Providers" },
  { href: "/network", label: "Network" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // A route change should close the mobile rail; leaving it open over the new
  // page is the classic half-finished drawer.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-dvh">
      {/* Mobile scrim */}
      {open ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[228px] shrink-0 flex-col border-r border-[var(--line)] bg-black transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-[57px] items-center gap-2.5 border-b border-[var(--line)] px-5">
          {/* Wordmark only: the mark is an X and the word starts with one, so
              together they read as two competing X-shapes rather than a lockup. */}
          <Link href="/" className="group flex items-center text-fg">
            <span className="text-[14.5px] font-semibold tracking-[-0.02em]">Xorv</span>
          </Link>
        </div>

        <nav className="flex-1 px-3 py-4">
          <ul className="space-y-0.5">
            {NAV.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" || pathname.startsWith("/jobs") : pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-colors",
                      active
                        ? "bg-white/[0.06] text-fg"
                        : "text-fg-3 hover:bg-white/[0.03] hover:text-fg-2",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <NetworkFoot />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[228px]">
        <header className="sticky top-0 z-20 flex h-[57px] items-center gap-3 border-b border-[var(--line)] bg-black/80 px-5 backdrop-blur-xl lg:px-8">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            className="-ml-2 p-2 text-fg-2 lg:hidden"
          >
            <span className="flex h-3 w-4 flex-col justify-between">
              <span className="block h-px w-full bg-current" />
              <span className="block h-px w-full bg-current" />
              <span className="block h-px w-full bg-current" />
            </span>
          </button>
          <span className="text-[13.5px] text-fg-3">
            {pathname.startsWith("/jobs")
              ? "Job"
              : (NAV.find((n) => n.href === pathname)?.label ?? "Jobs")}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <Link
              href="https://github.com/nickthelegend/xorv"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden text-[13px] text-fg-3 transition-colors hover:text-fg sm:block"
            >
              GitHub
            </Link>
            <Connect />
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8 lg:px-8 lg:py-10">{children}</main>
      </div>
    </div>
  );
}

/** Broker reachability, once, at the bottom of the rail. */
function NetworkFoot() {
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const next = await api.network();
        if (!alive) return;
        setInfo(next);
        setDown(false);
      } catch {
        if (alive) setDown(true);
      }
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="border-t border-[var(--line)] px-5 py-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            down ? "bg-fail" : info ? "breathe bg-live" : "bg-fg-4",
          )}
        />
        <span className="text-[12px] text-fg-3">
          {down ? "broker offline" : info ? `${info.stats.providersLive} provider(s) live` : "connecting…"}
        </span>
      </div>
      <p className="mono mt-1.5 text-[11px] text-fg-4">{info?.network ?? "hedera:testnet"}</p>
    </div>
  );
}

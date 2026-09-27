"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * The last line: an error thrown above the page, in the root layout's
 * providers — which is where wallet SDK modals (Privy's sign screen) render.
 * app/error.tsx cannot catch those, because it sits inside the layout; this
 * replaces the layout instead, so it brings its own <html> and <body>.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased">
        <main className="flex min-h-dvh items-center justify-center px-4">
          <div className="w-full max-w-md rounded-xl border border-[var(--line)] bg-surface p-6 text-center">
            <p className="text-[14px] font-medium text-fg">Xorv hit an error</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
              Something outside the page — often a wallet prompt — failed to render. Nothing was paid or signed
              because of it.
            </p>
            {error.message ? <p className="mono mt-3 break-words text-[11.5px] text-fg-4">{error.message}</p> : null}
            <div className="mt-4 flex justify-center gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-lg bg-white px-4 py-2.5 text-[13.5px] font-medium text-black hover:bg-white/90"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.assign("/")}
                className="rounded-lg border border-[var(--line-2)] px-4 py-2.5 text-[13.5px] font-medium text-fg hover:bg-white/[0.04]"
              >
                Reload
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}

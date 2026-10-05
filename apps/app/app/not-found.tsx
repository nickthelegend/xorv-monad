import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

/**
 * The 404 for URLs that match no page.
 *
 * Deliberately outside the (board) layout, so it loads no wallet providers:
 * nothing on this page can sign in or pay, and the wallet SDK's start-up check
 * would otherwise log an error about this very 404.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="mono text-[12px] text-fg-4">404</p>
      <h1 className="text-[20px] font-medium text-fg">This page doesn&apos;t exist</h1>
      <p className="text-[14px] text-fg-3">Jobs, providers and the network live on the job board.</p>
      <Link
        href="/"
        className="mt-2 rounded-lg border border-[var(--line)] px-3.5 py-2 text-[13px] text-fg transition-opacity hover:opacity-70"
      >
        Back to the job board
      </Link>
    </main>
  );
}

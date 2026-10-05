import { Providers } from "@/components/providers";
import { Shell } from "@/components/shell";

/**
 * Every real page of the job board: wallet providers plus the app shell.
 *
 * Kept out of the root layout on purpose. Privy's bundle includes the Coinbase
 * Wallet SDK, which on start-up sends a HEAD request for the current URL to read
 * its Cross-Origin-Opener-Policy — and on a URL that doesn't exist that request
 * is a 404, which the SDK logs as a console error. The global not-found page
 * renders inside the root layout only, so an unknown URL now gets a plain 404
 * with no wallet SDK behind it.
 */
export default function BoardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}

import Link from "next/link";
import { Mark } from "@/components/ui/logo";
import {
  ARBITRUM_URL,
  CHAIN,
  INSTALL_URL,
  LOOM_URL,
  PRIMARY_TOKEN,
  PRIVY_URL,
  REPO_URL,
  ROBINHOOD_CHAIN_URL,
  USDG_URL,
  X402_URL,
} from "@/lib/links";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#how" },
      { label: "For providers", href: "#earn" },
      { label: "Adapters", href: "#adapters" },
      { label: "Receipts", href: "#ledger" },
    ],
  },
  {
    title: "Build",
    links: [
      { label: "GitHub", href: REPO_URL, external: true },
      { label: "Install the CLI", href: INSTALL_URL, external: true },
      { label: "x402", href: X402_URL, external: true },
      { label: "Arbitrum", href: ARBITRUM_URL, external: true },
      { label: "Robinhood Chain", href: ROBINHOOD_CHAIN_URL, external: true },
      { label: "Paxos USDG", href: USDG_URL, external: true },
      { label: "Privy", href: PRIVY_URL, external: true },
    ],
  },
  {
    title: "On-chain",
    links: [
      ...CHAIN.tokens.map((t) => ({
        label: `${t.label.replace(" (default)", "")} token`,
        href: t.url,
        external: true,
      })),
      ...(CHAIN.escrowUrl ? [{ label: "XorvEscrow", href: CHAIN.escrowUrl, external: true }] : []),
      ...(CHAIN.registryUrl ? [{ label: "XorvRegistry (Stylus)", href: CHAIN.registryUrl, external: true }] : []),
      { label: "Audit log contract", href: CHAIN.logUrl, external: true },
      { label: CHAIN.explorerName, href: CHAIN.explorerUrl, external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-[var(--line)] px-6 py-16">
      <div className="mx-auto w-full max-w-6xl">
        <div className="grid gap-12 md:grid-cols-[1.5fr_repeat(3,1fr)]">
          <div>
            <div className="flex items-center gap-2.5 text-fg">
              <Mark className="h-5 w-5" />
              <span className="text-[15px] font-semibold tracking-[-0.02em]">Xorv</span>
            </div>
            <p className="mt-4 max-w-[26ch] text-[13.5px] leading-relaxed text-fg-3">
              A decentralized AI capacity network. Idle subscriptions in, paid jobs out — settled
              per request in {PRIMARY_TOKEN.symbol} on Arbitrum through an on-chain escrow, with no
              gas for buyers or providers.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h3 className="text-[13px] font-medium text-fg">{column.title}</h3>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      {...("external" in link && link.external
                        ? { target: "_blank", rel: "noopener noreferrer" }
                        : {})}
                      className="text-[13.5px] text-fg-3 transition-colors hover:text-fg"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-[var(--line)] pt-6 sm:flex-row sm:items-center">
          <p className="text-[12.5px] text-fg-4">
            © {new Date().getFullYear()} Xorv · MIT ·{" "}
            <Link
              href={LOOM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-fg-2"
            >
              Loompad
            </Link>
          </p>
          <p className="mono text-[12px] text-fg-4">{CHAIN.network}</p>
        </div>
      </div>
    </footer>
  );
}

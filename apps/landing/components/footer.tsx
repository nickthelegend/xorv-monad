import Link from "next/link";
import { Mark } from "@/components/ui/logo";
import { CHAIN, explorer } from "@/lib/chain";
import { APP_URL, CLI_GUIDE_URL, ERC8004_URL, LOOM_URL, MONAD_URL, REPO_URL, X402_URL } from "@/lib/links";

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

// The on-chain column lists what a reader can open right now. XorvLedger is
// only listed when the build was told its address — a link to an empty
// address would be the kind of proof this column exists to avoid.
const ON_CHAIN: FooterLink[] = [
  { label: "USDC", href: explorer.token(CHAIN.usdc), external: true },
  ...(CHAIN.ledger ? [{ label: "XorvLedger", href: explorer.address(CHAIN.ledger), external: true }] : []),
  { label: "ERC-8004 identity", href: explorer.address(CHAIN.erc8004.identity), external: true },
  { label: "ERC-8004 reputation", href: explorer.address(CHAIN.erc8004.reputation), external: true },
];

const COLUMNS: Array<{ title: string; links: FooterLink[] }> = [
  {
    title: "Product",
    links: [
      { label: "Open the app", href: APP_URL, external: true },
      { label: "How it works", href: "#how" },
      { label: "For providers", href: "#earn" },
      { label: "Receipts", href: "#ledger" },
    ],
  },
  {
    title: "Build",
    links: [
      { label: "GitHub", href: REPO_URL, external: true },
      { label: "Provider guide", href: CLI_GUIDE_URL, external: true },
      { label: "x402", href: X402_URL, external: true },
      { label: "ERC-8004", href: ERC8004_URL, external: true },
      { label: "Monad", href: MONAD_URL, external: true },
    ],
  },
  { title: "On-chain", links: ON_CHAIN },
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
              per job in USDC over x402 on Monad.
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
                      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
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
          <p className="mono text-[12px] text-fg-4">
            {CHAIN.name} · {CHAIN.network}
          </p>
        </div>
      </div>
    </footer>
  );
}

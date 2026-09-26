export const REPO_URL = "https://github.com/nickthelegend/xorv-monad";
/** Public broker the live ledger section reads. Optional: the page works without it. */
export const BROKER_URL = (
  process.env.NEXT_PUBLIC_XORV_BROKER_URL?.trim() || "http://localhost:8402"
).replace(/\/+$/, "");
/** The buyer app (Privy sign-in, pay per job). Falls back to its dev port. */
export const APP_URL = (process.env.NEXT_PUBLIC_XORV_APP_URL?.trim() || "http://localhost:3002").replace(
  /\/+$/,
  "",
);
export const LOOM_URL = "https://loompad.tech";
export const X402_URL = "https://x402.org";
export const MONAD_URL = "https://monad.xyz";
export const ERC8004_URL = "https://eips.ethereum.org/EIPS/eip-8004";
/** Where a provider guide lives until `@xorv/cli@0.2.0` is on npm. */
export const CLI_GUIDE_URL = `${REPO_URL}/tree/main/packages/cli#readme`;

export const NAV = [
  { label: "How it works", href: "#how" },
  { label: "Earn", href: "#earn" },
  { label: "Adapters", href: "#adapters" },
  { label: "Built with", href: "#stack" },
  { label: "Ledger", href: "#ledger" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
];

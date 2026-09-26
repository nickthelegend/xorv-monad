export const REPO_URL = "https://github.com/nickthelegend/xorv";
/** Public broker the live-stats strip reads. Optional: the page works without it. */
export const BROKER_URL = (
  process.env.NEXT_PUBLIC_XORV_BROKER_URL ?? "http://localhost:8402"
).replace(/\/+$/, "");
export const APP_URL = process.env.NEXT_PUBLIC_XORV_APP_URL ?? "http://localhost:3002";
export const LOOM_URL = "https://loompad.tech";
export const X402_URL = "https://x402.org";
export const HEDERA_URL = "https://hedera.com";
export const NPM_URL = "https://www.npmjs.com/package/xorv";

/**
 * The live testnet ids this site links to.
 *
 * Every number quoted on the page resolves to something a reader can open on
 * HashScan. A marketing site for a payments network that can't show you the
 * payments is just a claim.
 */
export const CHAIN = {
  network: "hedera:testnet",
  usdc: "0.0.429274",
  usdcUrl: "https://hashscan.io/testnet/token/0.0.429274",
  topics: {
    registry: "0.0.9848245",
    heartbeat: "0.0.9848246",
    receipts: "0.0.9848247",
  },
  topicUrl: (id: string) => `https://hashscan.io/testnet/topic/${id}`,
};

export const NAV = [
  { label: "How it works", href: "#how" },
  { label: "The network", href: "#bento" },
  { label: "Earn", href: "#earn" },
  { label: "Adapters", href: "#adapters" },
  { label: "Receipts", href: "#ledger" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
];

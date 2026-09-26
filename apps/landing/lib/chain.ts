/**
 * The Monad facts this site links to.
 *
 * Every address quoted on the page resolves to something a reader can open on
 * a Monad block explorer. A marketing site for a payments network that can't
 * show you the payments is just a claim.
 *
 * ## Why this is a local copy and not `@xorv/protocol/web`
 *
 * The protocol package owns these values for the broker, the CLI and the app.
 * The landing deliberately does not depend on it: it is a leaf site that
 * deploys on its own, and pulling in a workspace package means every build
 * (Vercel's included) has to compile the protocol first — for a page that needs
 * five addresses and a string shortener. The values below are the verified
 * ones from the port spec; the live section prefers whatever the broker's
 * `/api/network` reports, so a drifted constant here shows up as a mismatch in
 * one place rather than a wrong link everywhere.
 *
 * Everything is overridable through `NEXT_PUBLIC_*`, which Next inlines at
 * build time — so pointing the site at mainnet or at the deployed ledger is an
 * env change and a redeploy, not an edit.
 */

export interface ChainFacts {
  /** CAIP-2 id, the same string the broker and the x402 `accepts` use. */
  network: string;
  chainId: number;
  name: string;
  explorerUrl: string;
  usdc: string;
  erc8004: { identity: string; reputation: string };
}

const NETWORKS: Record<string, ChainFacts> = {
  "eip155:10143": {
    network: "eip155:10143",
    chainId: 10143,
    name: "Monad testnet",
    explorerUrl: "https://testnet.monadscan.com",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    erc8004: {
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    },
  },
  "eip155:143": {
    network: "eip155:143",
    chainId: 143,
    name: "Monad mainnet",
    explorerUrl: "https://monadscan.com",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    erc8004: {
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    },
  },
};

/** An unset or empty `NEXT_PUBLIC_*` reads as "use the default", not as "". */
function env(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const base = NETWORKS[env(process.env.NEXT_PUBLIC_XORV_NETWORK) ?? ""] ?? NETWORKS["eip155:10143"]!;

export const CHAIN = {
  ...base,
  explorerUrl: (env(process.env.NEXT_PUBLIC_XORV_EXPLORER_URL) ?? base.explorerUrl).replace(/\/+$/, ""),
  /**
   * The XorvLedger contract, when the build knows it. Optional on purpose: the
   * live section reads the address from the broker too, and a site built
   * before the contract existed must not invent one.
   */
  ledger: env(process.env.NEXT_PUBLIC_XORV_LEDGER_ADDRESS),
};

/**
 * Explorer links. Monadscan and MonadVision share these path shapes, so an
 * explorer override needs no rewriting — and an EVM hash goes in verbatim,
 * with no id-format translation to get wrong.
 */
export const explorer = {
  tx: (hash: string) => `${CHAIN.explorerUrl}/tx/${hash}`,
  address: (address: string) => `${CHAIN.explorerUrl}/address/${address}`,
  token: (address: string) => `${CHAIN.explorerUrl}/token/${address}`,
};

/**
 * Shorten a hash or address for tight UI: `0x1234…abcd`.
 *
 * Same contract as the protocol's `shortHex`: `head` counts from the very
 * start (so it includes the `0x`), `tail` from the end, and anything already
 * short enough comes back unchanged — an ellipsis that hides nothing is noise.
 */
export function shortHex(hex: string, head = 6, tail = 4): string {
  const value = hex.trim();
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

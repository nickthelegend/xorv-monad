import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { REPO_URL } from "@/lib/links";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

/**
 * The canonical origin, for metadata and JSON-LD.
 *
 * An explicit NEXT_PUBLIC_XORV_SITE_URL wins; on Vercel the project's
 * production domain is known at build time; anything else is a local build and
 * says so. Hard-coding a domain here is how the site ended up advertising one
 * it wasn't served from.
 */
const SITE = (
  process.env.NEXT_PUBLIC_XORV_SITE_URL?.trim() ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
  "http://localhost:3000"
).replace(/\/+$/, "");
const TITLE = "Xorv — rent out your idle AI capacity, get paid per job in USDC on Monad";
const DESCRIPTION =
  "Xorv is a decentralized AI capacity network on Monad. Rent out the Claude Code, Codex, Qwen 3.8 Max, Kimi K3 or Hunyuan capacity you already pay for and get paid per job in USDC over x402 — sub-second settlement, buyers never need gas, and ERC-8004 identities carry reputation that only paid jobs can build.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s · Xorv" },
  description: DESCRIPTION,
  applicationName: "Xorv",
  keywords: [
    "x402",
    "Monad",
    "USDC",
    "EIP-3009",
    "ERC-8004",
    "agent reputation",
    "Privy",
    "Envio",
    "AI capacity network",
    "agent payments",
    "micropayments",
    "Claude Code",
    "machine-to-machine payments",
    "decentralized compute",
  ],
  authors: [{ name: "Xorv", url: REPO_URL }],
  creator: "Xorv",
  publisher: "Xorv",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "Xorv",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  category: "technology",
  icons: {
    icon: [{ url: "/brand/xorv-mark.svg", type: "image/svg+xml" }],
    apple: [{ url: "/brand/xorv-mark.svg" }],
  },
};

/** Dark only — it matches the one palette the site actually ships. */
export const viewport: Viewport = {
  themeColor: "#07070b",
  colorScheme: "dark",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE}/#organization`,
      name: "Xorv",
      url: SITE,
      logo: `${SITE}/brand/xorv-logo.svg`,
      description: DESCRIPTION,
      sameAs: [REPO_URL],
    },
    {
      "@type": "SoftwareApplication",
      name: "Xorv CLI",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      url: SITE,
      description:
        "Command-line provider node for the Xorv network. Share idle AI capacity and get paid per job in USDC over x402 on Monad, with an optional ERC-8004 agent identity.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${SITE}/#organization` },
    },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased overflow-x-clip bg-background text-foreground">
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}

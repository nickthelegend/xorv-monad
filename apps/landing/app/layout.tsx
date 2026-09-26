import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { REPO_URL } from "@/lib/links";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

const SITE = "https://xorv.network";
const TITLE = "Xorv — rent out your idle AI subscription, get paid in USDC";
const DESCRIPTION =
  "Xorv is a decentralized AI capacity network. Share the Claude, Codex or Grok quota you already pay for, run jobs from anyone on the network, and get paid per job in USDC over x402 on Hedera.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s · Xorv" },
  description: DESCRIPTION,
  applicationName: "Xorv",
  keywords: [
    "x402",
    "Hedera",
    "USDC",
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
        "Command-line provider node for the Xorv network. Share idle AI subscription capacity and get paid per job in USDC over x402 on Hedera.",
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

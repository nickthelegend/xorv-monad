import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { DEFAULT_STABLECOIN } from "@/lib/chains";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: { default: "Xorv", template: "%s · Xorv" },
  description:
    `Post an AI job, pay per job in ${DEFAULT_STABLECOIN.symbol} over x402 on Monad, and watch it run on a live provider node.`,
  icons: { icon: [{ url: "/brand/xorv-mark.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = { themeColor: "#000000", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      {/* Providers and the shell live in app/(board)/layout.tsx — see there for why. */}
      <body className="antialiased">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { AppProviders } from "@/lib/providers";
import { IS_PRODUCTION_MODE, UNLOCK_PRODUCTION } from "@/lib/env-flags";
import { ProductionGate } from "@/shell/production-gate";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Operating Command Center for Agents",
  description:
    "On-chain operating system for autonomous AI agents. Deploy, manage, and monetize AI agent teams on Solana from a unified 3D workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark font-sans ${geist.variable}`}>
      <body suppressHydrationWarning>
        {IS_PRODUCTION_MODE && !UNLOCK_PRODUCTION ? (
          <ProductionGate />
        ) : (
          <AppProviders>{children}</AppProviders>
        )}
        <Script
          type="module"
          src="https://cdn.jsdelivr.net/npm/ionicons@8.0.13/dist/ionicons/ionicons.esm.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}

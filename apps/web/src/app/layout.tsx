import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { AppProviders } from "@/lib/providers";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Onchain Command Center for Agents",
  description: "Web3-native SaaS for managing AI teams in a live 3D office",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark font-sans ${geist.variable}`}>
      <body suppressHydrationWarning>
        <AppProviders>{children}</AppProviders>
        <Script
          type="module"
          src="https://cdn.jsdelivr.net/npm/ionicons@8.0.13/dist/ionicons/ionicons.esm.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}

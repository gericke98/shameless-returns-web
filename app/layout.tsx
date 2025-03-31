import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/providers";
import { siteConfig } from "@/lib/config";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${siteConfig.name} | ${siteConfig.description}`,
  description: `${siteConfig.name} | ${siteConfig.description}`,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <main>{children}</main>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}

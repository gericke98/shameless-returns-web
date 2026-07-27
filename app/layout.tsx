import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/providers";
import { siteConfig } from "@/lib/config";
import { LOCALE_COOKIE, readLocale } from "@/lib/i18n";

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
  // The portal is Spanish by default and switchable to English, so `lang` has
  // to follow the same cookie the pages read rather than being hardcoded.
  // `readLocale` falls back to "es" for an absent or junk cookie.
  //
  // The admin pages are English whatever this says — see components/htmlLang.tsx.
  const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);

  return (
    <html lang={locale}>
      <body className={inter.className}>
        <Providers>
          <main>{children}</main>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}

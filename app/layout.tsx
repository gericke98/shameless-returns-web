import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/providers";
import { siteConfig } from "@/lib/config";
import { LOCALE_COOKIE, readLocale } from "@/lib/i18n";

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
      {/* Type comes from the Tailwind `sans` stack (Helvetica, then Arial),
          not a webfont — see tailwind.config.ts. */}
      <body>
        <Providers>
          <main>{children}</main>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  dictionaries,
  readLocale,
  type Locale,
} from "@/lib/i18n";

/**
 * Route-level error boundary. Without one, an uncaught throw anywhere under
 * app/ renders Next's default error screen — and this branch adds throw sites
 * to the free return path, which is the flow a customer is most likely to be
 * in when something fails.
 *
 * A boundary lower down (e.g. app/[id]/error.tsx) would keep more of the
 * surrounding page alive, but there is none today; this is the minimum that
 * stops a customer hitting a blank framework error page.
 *
 * Note this does not catch errors thrown by app/layout.tsx itself — that
 * requires a global-error.tsx, which is deliberately out of scope here.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // The locale lives in a cookie that is not httpOnly (actions/locale.ts sets
  // it without that flag), so a client component can read it. It is read in an
  // effect rather than during render because this component can be rendered on
  // the server, where `document` does not exist — a lazy initializer reading
  // document.cookie would be a hydration mismatch. The one-frame Spanish
  // default is the correct fallback anyway.
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`)
    );
    setLocale(readLocale(match ? decodeURIComponent(match[1]) : null));
  }, []);

  useEffect(() => {
    console.error("Unhandled error rendered by app/error.tsx:", error);
  }, [error]);

  const t = dictionaries[locale];

  return (
    <main className="min-h-screen grid place-items-center bg-black-pattern">
      <div className="bg-white rounded-3xl py-8 px-5 lg:px-8 w-[85%] lg:w-[30%] flex flex-col items-center gap-5 text-center">
        <h1 className="font-bold text-xl">{t.error.title}</h1>
        <p className="text-sm text-gray-700">{t.error.body}</p>
        <button
          type="button"
          onClick={reset}
          className="bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
        >
          {t.error.retry}
        </button>
      </div>
    </main>
  );
}

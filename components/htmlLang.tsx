"use client";

import { useEffect } from "react";

/**
 * Overrides `<html lang>` for a subtree whose language differs from the root
 * layout's.
 *
 * The root layout sets `lang` from the locale cookie, which is right for the
 * customer-facing portal but wrong for the admin pages — those are English
 * regardless of what the shop owner last picked in the portal switcher. A
 * nested layout cannot render `<html>`, so this reaches for the element
 * directly.
 *
 * Server-rendered HTML still carries the root's value; this corrects it on
 * hydration. Acceptable here because the admin pages sit behind auth and are
 * never indexed — do not use this pattern on a page that needs the right
 * `lang` in its initial HTML.
 */
export function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = lang;
    // Restore on unmount so a client-side navigation back to the portal does
    // not leave the whole document labelled English.
    return () => {
      document.documentElement.lang = previous;
    };
  }, [lang]);

  return null;
}

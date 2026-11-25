"use client";

import { setLocale } from "@/actions/locale";
import { useLocale, useT } from "@/lib/i18n/context";
import { useCallAction } from "@/lib/callAction";
import { useRouter } from "next/navigation";
import { useState } from "react";

// Deliberately NOT `useTransition` with an async callback: that pattern only
// became reliable in React 19's Actions. This app runs React 18.3.1, where
// `isPending` from `useTransition` is not guaranteed to track state updates
// that happen after an `await` inside the transition callback — exactly the
// window this control needs to disable the <select> while the request is in
// flight. Plain `useState`, set before the await and cleared in a `finally`,
// has none of that ambiguity. Same pattern as
// app/dashboard/shipping-fees/FeesTable.tsx, collapsed to a single boolean
// here since this is one control, not a per-row map.
export const LanguageSwitcher = () => {
  const locale = useLocale();
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const callAction = useCallAction();
  const t = useT();

  const select = (
    <select
      aria-label="Language"
      value={locale}
      disabled={isSaving}
      onChange={async (e) => {
        const next = e.target.value === "en" ? "en" : "es";
        setIsSaving(true);
        setNotSaved(false);
        try {
          const outcome = await callAction(setLocale, { locale: next });
          if (outcome.kind === "unknown" || !outcome.result.ok) {
            setNotSaved(true);
            return;
          }
          // setLocale revalidates the root layout server-side, but that only
          // invalidates the cache entry — it does not by itself force this
          // client to re-fetch and re-render with the new locale, especially
          // now that the call is a plain async function rather than being
          // wrapped in a transition. router.refresh() makes that re-fetch
          // explicit instead of relying on it as an implicit side effect.
          router.refresh();
        } finally {
          setIsSaving(false);
        }
      }}
      className="text-xs bg-transparent border border-slate-200 rounded px-2 py-1"
    >
      <option value="es">Español</option>
      <option value="en">English</option>
    </select>
  );
  return notSaved ? (
    <span className="inline-flex items-center gap-2">
      {select}
      <span role="alert" className="text-xs text-red-600">
        {t.action.notSaved}
      </span>
    </span>
  ) : (
    select
  );
};

"use client";

import { setLocale } from "@/actions/locale";
import { useLocale } from "@/lib/i18n/context";
import { useTransition } from "react";

export const LanguageSwitcher = ({ orderId }: { orderId?: string }) => {
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();

  return (
    <select
      aria-label="Language"
      value={locale}
      disabled={isPending}
      onChange={(e) => {
        const next = e.target.value === "en" ? "en" : "es";
        startTransition(async () => {
          await setLocale(next, orderId);
        });
      }}
      className="text-xs bg-transparent border border-slate-200 rounded px-2 py-1"
    >
      <option value="es">Español</option>
      <option value="en">English</option>
    </select>
  );
};

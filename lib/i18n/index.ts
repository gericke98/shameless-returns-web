import { es, type Dictionary } from "./es";
import { en } from "./en";

export type Locale = "es" | "en";
export type { Dictionary };

export const DEFAULT_LOCALE: Locale = "es";
export const LOCALE_COOKIE = "locale";
export const LOCALES: Locale[] = ["es", "en"];

export const dictionaries: Record<Locale, Dictionary> = { es, en };

/** Coerce an untrusted cookie value to a supported locale. */
export function readLocale(value: string | null | undefined): Locale {
  return value === "en" || value === "es" ? value : DEFAULT_LOCALE;
}

/** Locale-correct currency: "4,00 €" in es-ES, "€4.00" in en. */
export function formatEuros(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-IE", {
    style: "currency",
    currency: "EUR",
  }).format(amount);
}

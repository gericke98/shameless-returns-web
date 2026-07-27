"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, dictionaries, type Dictionary, type Locale } from ".";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export const LocaleProvider = ({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) => <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;

export const useLocale = (): Locale => useContext(LocaleContext);

/** The active dictionary. Usage: const t = useT(); ... {t.second.title} */
export const useT = (): Dictionary => dictionaries[useContext(LocaleContext)];

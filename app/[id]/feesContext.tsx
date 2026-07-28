"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { CountryBands } from "@/lib/fees";

const NO_BANDS: CountryBands = [];

const FeesContext = createContext<CountryBands>(NO_BANDS);

/**
 * Carries the order country's weight bands to the components that display the
 * fee. Context rather than props because seven components across four levels
 * need it, and none of the intermediate ones care.
 *
 * Carries the whole band list rather than a resolved pair because the fee
 * depends on the basket, which changes as the customer selects items — a
 * pre-resolved pair would go stale the moment they add a garment.
 *
 * This is for DISPLAY ONLY. The amount actually charged is recomputed
 * server-side in actions/payments.ts.
 */
export const FeesProvider = ({
  fees,
  children,
}: {
  fees: CountryBands;
  children: ReactNode;
}) => <FeesContext.Provider value={fees}>{children}</FeesContext.Provider>;

export const useFees = (): CountryBands => useContext(FeesContext);

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { CountryFees } from "@/lib/fees";

const ZERO: CountryFees = { returnFeeCents: 0, exchangeFeeCents: 0 };

const FeesContext = createContext<CountryFees>(ZERO);

/**
 * Carries the order country's fee pair to the components that display it.
 * Context rather than props because seven components across four levels need
 * it, and none of the intermediate ones care.
 *
 * This is for DISPLAY ONLY. The amount actually charged is recomputed
 * server-side in actions/payments.ts.
 */
export const FeesProvider = ({
  fees,
  children,
}: {
  fees: CountryFees;
  children: ReactNode;
}) => <FeesContext.Provider value={fees}>{children}</FeesContext.Provider>;

export const useFees = (): CountryFees => useContext(FeesContext);

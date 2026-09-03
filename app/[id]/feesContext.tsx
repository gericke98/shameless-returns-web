"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { feesForCountry, type FeeLegs, type FeeTable } from "@/lib/fees";
import { resolveZone } from "@/lib/zones";
import { feeLegsForOrder } from "@/lib/feeLegs";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import type { DeliveryInput } from "@/lib/deliveryAddressInput";

/**
 * Carries the fee table and the customer's in-progress delivery address to the
 * components that display the price.
 *
 * Was one country's bands, resolved on the server at page load. That cannot
 * price a SECOND country the customer picks in the browser, which is the whole
 * of this feature -- so the table travels instead. It is 235 rows.
 *
 * Shipping the whole table to the client is safe for the same reason the old
 * comment gave: this is for DISPLAY ONLY. The amount actually charged is
 * recomputed server-side in actions/payments.ts from the stored order, never
 * from anything the browser says. A customer who edits the table in devtools
 * changes the number on their own screen and nothing else.
 *
 * The delivery DRAFT lives here rather than in the form because the summary,
 * the method screen and the final screen all price from it and none of them
 * owns the form.
 */

type FeesValue = {
  readonly table: FeeTable;
  readonly order: OrderAddressFields;
  readonly draft: DeliveryInput | null;
  readonly setDraft: (draft: DeliveryInput | null) => void;
};

const EMPTY_TABLE: FeeTable = {};

const FeesContext = createContext<FeesValue>({
  table: EMPTY_TABLE,
  order: null as unknown as OrderAddressFields,
  draft: null,
  setDraft: () => {},
});

export const FeesProvider = ({
  table,
  order,
  children,
}: {
  table: FeeTable;
  order: OrderAddressFields;
  children: ReactNode;
}) => {
  const [draft, setDraft] = useState<DeliveryInput | null>(null);
  const value = useMemo(
    () => ({ table, order, draft, setDraft }),
    [table, order, draft]
  );
  return <FeesContext.Provider value={value}>{children}</FeesContext.Provider>;
};

/**
 * The two band lists the current basket is priced from.
 *
 * The collection leg always comes from the stored order. The delivery leg
 * comes from the draft if the customer is filling one in, and otherwise from
 * whatever is stored -- which is the collection address unless a previous
 * submission saved something else.
 *
 * The draft takes precedence over the stored value so the price on screen
 * tracks what the customer is typing, before they submit.
 */
export const useFeeLegs = (): FeeLegs => {
  const { table, order, draft } = useContext(FeesContext);
  return useMemo(() => {
    const stored = feeLegsForOrder(table, order);
    if (!draft) return stored;
    return {
      collection: stored.collection,
      delivery: feesForCountry(table, resolveZone(draft.country, draft.zip)),
    };
  }, [table, order, draft]);
};

export const useDeliveryDraft = (): {
  draft: DeliveryInput | null;
  setDraft: (draft: DeliveryInput | null) => void;
} => {
  const { draft, setDraft } = useContext(FeesContext);
  return { draft, setDraft };
};

"use client";

// The portal wizard, provided to every window: React's "Scaling up with a
// reducer and context" pattern. ClientOrder owns the reducer; each window reads
// the current step, the terms and the actions it needs, instead of position,
// credito and method being threaded through four layers of props (which is
// how five different components each came to move the step on their own).
import { createContext, useCallback, useContext, useMemo, useReducer } from "react";
import type { Tender } from "@/lib/agreement";
import { valueBasket } from "@/lib/basket";
import {
  canContinue,
  canSubmit,
  currentStep,
  initialWizard,
  wizardReducer,
  type Step,
  type WizardContext,
} from "@/lib/portalWizard";
import type { ReturnMethod } from "@/lib/returnMethods";
import { selectionTerms, type SelectionTerms, type ValuedBasket } from "@/lib/selectionTerms";
import type { OrderItem, Product } from "@/types";
import { useFeeLegs } from "./feesContext";

export type PortalWizard = {
  /** The step to render — derived, so it can never be past a missing payout. */
  readonly step: Step;
  readonly payout: Tender | null;
  readonly method: ReturnMethod;
  readonly basket: ValuedBasket;
  /** The same terms the server agrees the submit from (lib/selectionTerms). */
  readonly terms: SelectionTerms;
  readonly canContinue: boolean;
  readonly canSubmit: boolean;
  next(): void;
  back(): void;
  itemChanged(): void;
  addressSaved(): void;
  choosePayout(payout: Tender): void;
  chooseMethod(method: ReturnMethod): void;
  payoutRefused(): void;
};

const WizardCtx = createContext<PortalWizard | null>(null);

export function PortalWizardProvider({
  items,
  allProducts,
  children,
}: {
  items: OrderItem[];
  allProducts: Product[];
  children: React.ReactNode;
}) {
  // "CORREOS" is what the submit sent before self-booking existed; the server
  // re-derives the real lane and honours only an explicit "SELF".
  const [state, dispatch] = useReducer(wizardReducer, "CORREOS", initialWizard);
  const legs = useFeeLegs();

  const basket = useMemo(() => valueBasket(items, allProducts), [items, allProducts]);
  const terms = useMemo(
    () => selectionTerms(basket, legs, state.method, state.payout),
    [basket, legs, state.method, state.payout]
  );
  const hasItems = basket.hasItems;
  const payoutRequired = terms.payoutRequired;
  const ctx: WizardContext = useMemo(
    () => ({ hasItems, payoutRequired }),
    [hasItems, payoutRequired]
  );

  const next = useCallback(() => dispatch({ type: "next", ctx }), [ctx]);
  const back = useCallback(() => dispatch({ type: "back", ctx }), [ctx]);
  const addressSaved = useCallback(() => dispatch({ type: "addressSaved", ctx }), [ctx]);
  const itemChanged = useCallback(() => dispatch({ type: "itemChanged" }), []);
  const choosePayout = useCallback(
    (payout: Tender) => dispatch({ type: "payoutChosen", payout }),
    []
  );
  const chooseMethod = useCallback(
    (method: ReturnMethod) => dispatch({ type: "methodChanged", method }),
    []
  );
  const payoutRefused = useCallback(() => dispatch({ type: "payoutRefused" }), []);

  const value = useMemo<PortalWizard>(
    () => ({
      step: currentStep(state, ctx),
      payout: state.payout,
      method: state.method,
      basket,
      terms,
      canContinue: canContinue(state, ctx),
      canSubmit: canSubmit(state, ctx),
      next,
      back,
      itemChanged,
      addressSaved,
      choosePayout,
      chooseMethod,
      payoutRefused,
    }),
    [state, ctx, basket, terms, next, back, itemChanged, addressSaved, choosePayout, chooseMethod, payoutRefused]
  );

  return <WizardCtx.Provider value={value}>{children}</WizardCtx.Provider>;
}

export function usePortalWizard(): PortalWizard {
  const wizard = useContext(WizardCtx);
  if (!wizard) throw new Error("usePortalWizard must be used inside PortalWizardProvider");
  return wizard;
}

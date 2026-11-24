// The returns portal wizard as data: one reducer, steps by name, and the one
// rule the server enforces — no submit while a required payout is missing —
// enforced here in one place. Pure: no React, so it is unit-tested directly.
//
// Why it exists: the step used to be a number moved from five places
// (`prevState + 1` from a server action, `position - 1`, `position - 2`,
// `Math.min(prev, 3)`, an effect resetting to 1). A double-tap on step 2 queued
// two server actions and the counter skipped the payout step (#312875,
// reproduced 2026-11-24). Here no event can skip it: which steps exist is
// derived from the current terms every time, never counted.
import type { Tender } from "@/lib/agreement";
import type { ReturnMethod } from "@/lib/returnMethods";

export type Step = "items" | "address" | "payout" | "summary";

export type WizardState = {
  /** Where the customer last navigated. Read it through `currentStep`. */
  readonly step: Step;
  /** Null until chosen on the payout step; voided by anything that reprices. */
  readonly payout: Tender | null;
  readonly method: ReturnMethod;
};

/** What the wizard needs to know about the selection right now. */
export type WizardContext = {
  /** Any line selected and not yet submitted. */
  readonly hasItems: boolean;
  /** From selectionTerms: money comes back, so a payout must be chosen. */
  readonly payoutRequired: boolean;
};

export type WizardEvent =
  | { type: "next"; ctx: WizardContext }
  | { type: "back"; ctx: WizardContext }
  /** An item was added, edited or cleared: the terms changed. */
  | { type: "itemChanged" }
  /**
   * The selection went from something to nothing. Navigation starts over: a
   * customer who clears everything and picks again walks every step again
   * (the delivery address, the method), instead of landing back where they
   * left off.
   */
  | { type: "selectionEmptied" }
  /** The address form was saved. Its delivery address can reprice the outbound leg. */
  | { type: "addressSaved"; ctx: WizardContext }
  | { type: "methodChanged"; method: ReturnMethod }
  | { type: "payoutChosen"; payout: Tender }
  /** The server refused the submit because a payout is required (safety net). */
  | { type: "payoutRefused" };

export function initialWizard(method: ReturnMethod): WizardState {
  return { step: "items", payout: null, method };
}

/**
 * The step to render. Derived during render, never stored by an effect:
 * whatever `state.step` says, the customer cannot be on the summary while a
 * required payout is missing, and cannot be on a payout step that no longer
 * exists.
 */
export function currentStep(state: WizardState, ctx: WizardContext): Step {
  if (!ctx.hasItems) return "items";
  if (state.step === "summary" && ctx.payoutRequired && state.payout === null) {
    return "payout";
  }
  if (state.step === "payout" && !ctx.payoutRequired) return "summary";
  return state.step;
}

/** Submit is offered only from the summary, and only with terms someone agreed to. */
export function canSubmit(state: WizardState, ctx: WizardContext): boolean {
  return (
    currentStep(state, ctx) === "summary" &&
    (!ctx.payoutRequired || state.payout !== null)
  );
}

/** Whether the generic Continue button may move on from the current step. */
export function canContinue(state: WizardState, ctx: WizardContext): boolean {
  switch (currentStep(state, ctx)) {
    case "items":
      return ctx.hasItems;
    case "payout":
      return state.payout !== null;
    // The address step submits its own form; the summary submits the return.
    case "address":
    case "summary":
      return false;
  }
}

function stepAfter(step: Step, ctx: WizardContext): Step {
  switch (step) {
    case "items":
      return "address";
    case "address":
      return ctx.payoutRequired ? "payout" : "summary";
    case "payout":
    case "summary":
      return "summary";
  }
}

function stepBefore(step: Step, ctx: WizardContext): Step {
  switch (step) {
    case "summary":
      return ctx.payoutRequired ? "payout" : "address";
    case "payout":
      return "address";
    case "address":
    case "items":
      return "items";
  }
}

/** Anything that changes the price voids the choice made for the old price. */
function repriced(state: WizardState): WizardState {
  return {
    ...state,
    payout: null,
    // Voiding the choice on the summary sends the customer to where it is
    // made (#312973). If nothing comes back any more, `currentStep` skips the
    // payout step and they stay on the summary.
    step: state.step === "summary" ? "payout" : state.step,
  };
}

export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case "next": {
      const from = currentStep(state, event.ctx);
      if (from === "payout" && state.payout === null) return state;
      return { ...state, step: stepAfter(from, event.ctx) };
    }
    case "back":
      return { ...state, step: stepBefore(currentStep(state, event.ctx), event.ctx) };
    case "itemChanged":
      return repriced(state);
    case "selectionEmptied":
      return { ...state, step: "items", payout: null };
    case "addressSaved": {
      // Idempotent by construction: a second save (double-tap, retried POST)
      // lands on the same step as the first, whatever order they resolve in.
      // The old `prevState + 1` counted them.
      const after = repriced(state);
      return { ...after, step: stepAfter("address", event.ctx) };
    }
    case "methodChanged":
      if (event.method === state.method) return state;
      return { ...repriced(state), method: event.method };
    case "payoutChosen":
      return { ...state, payout: event.payout };
    case "payoutRefused":
      return { ...state, payout: null, step: "payout" };
  }
}

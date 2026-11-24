import { describe, expect, it } from "vitest";
import {
  canContinue,
  canSubmit,
  currentStep,
  initialWizard,
  wizardReducer,
  type WizardContext,
  type WizardEvent,
  type WizardState,
} from "@/lib/portalWizard";

const owed: WizardContext = { hasItems: true, payoutRequired: true };
const even: WizardContext = { hasItems: true, payoutRequired: false };
const empty: WizardContext = { hasItems: false, payoutRequired: false };

const run = (events: WizardEvent[], from: WizardState = initialWizard("CORREOS")) =>
  events.reduce(wizardReducer, from);

const atAddress = run([{ type: "next", ctx: owed }]);

describe("portal wizard", () => {
  it("walks items → address → payout → summary when money comes back", () => {
    expect(currentStep(atAddress, owed)).toBe("address");
    const atPayout = run([{ type: "addressSaved", ctx: owed }], atAddress);
    expect(currentStep(atPayout, owed)).toBe("payout");
    expect(canContinue(atPayout, owed)).toBe(false);
    const chosen = run([{ type: "payoutChosen", payout: "refund" }], atPayout);
    expect(canContinue(chosen, owed)).toBe(true);
    const atSummary = run([{ type: "next", ctx: owed }], chosen);
    expect(currentStep(atSummary, owed)).toBe("summary");
    expect(canSubmit(atSummary, owed)).toBe(true);
  });

  // #312875, reproduced 2026-11-24: two queued address saves skipped the payout step.
  it("a double (or triple) address save still lands on the payout step", () => {
    const twice = run(
      [{ type: "addressSaved", ctx: owed }, { type: "addressSaved", ctx: owed }, { type: "addressSaved", ctx: owed }],
      atAddress
    );
    expect(currentStep(twice, owed)).toBe("payout");
    expect(canSubmit(twice, owed)).toBe(false);
  });

  it("skips the payout step when nothing comes back, and back skips it too", () => {
    const s = run([{ type: "addressSaved", ctx: even }], atAddress);
    expect(currentStep(s, even)).toBe("summary");
    expect(canSubmit(s, even)).toBe(true);
    expect(currentStep(run([{ type: "back", ctx: even }], s), even)).toBe("address");
  });

  it("the summary is never current with a required payout missing, however it was reached", () => {
    // A summary reached while nothing was owed, then the terms change so money is.
    const s = run([{ type: "addressSaved", ctx: even }], atAddress);
    expect(currentStep(s, owed)).toBe("payout");
    expect(canSubmit(s, owed)).toBe(false);
  });

  it("can't continue past the payout step without a choice", () => {
    const atPayout = run([{ type: "addressSaved", ctx: owed }], atAddress);
    expect(run([{ type: "next", ctx: owed }], atPayout)).toBe(atPayout);
  });

  it("an item change on the summary voids the payout and returns to the payout step (#312973)", () => {
    const done = run(
      [{ type: "addressSaved", ctx: owed }, { type: "payoutChosen", payout: "credit" }, { type: "next", ctx: owed }],
      atAddress
    );
    const edited = run([{ type: "itemChanged" }], done);
    expect(edited.payout).toBeNull();
    expect(currentStep(edited, owed)).toBe("payout");
    // ...and if the edit means nothing comes back any more, straight to the summary.
    expect(currentStep(edited, even)).toBe("summary");
  });

  it("choosing to self-book voids the payout: it changes the fee", () => {
    const chosen = run([{ type: "payoutChosen", payout: "refund" }], atAddress);
    const self = run([{ type: "methodChanged", method: "SELF" }], chosen);
    expect(self.method).toBe("SELF");
    expect(self.payout).toBeNull();
    // Re-selecting the same method changes nothing.
    expect(run([{ type: "methodChanged", method: "SELF" }], self)).toBe(self);
  });

  it("a server refusal returns the customer to the payout step", () => {
    const done = run(
      [{ type: "addressSaved", ctx: owed }, { type: "payoutChosen", payout: "refund" }, { type: "next", ctx: owed }],
      atAddress
    );
    const refused = run([{ type: "payoutRefused" }], done);
    expect(refused.payout).toBeNull();
    expect(currentStep(refused, owed)).toBe("payout");
  });

  it("with nothing selected, only the items step exists", () => {
    const s = run([{ type: "addressSaved", ctx: owed }], atAddress);
    expect(currentStep(s, empty)).toBe("items");
    expect(canContinue(s, empty)).toBe(false);
    expect(canSubmit(s, empty)).toBe(false);
  });
});

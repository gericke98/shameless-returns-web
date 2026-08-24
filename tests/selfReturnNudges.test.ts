import { describe, expect, it } from "vitest";
import { nudgeDue } from "@/lib/selfReturnNudges";

const NOW = new Date("2026-08-21T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const base = {
  returnMethod: "SELF",
  returnSubmittedAt: daysAgo(0),
  trackingSubmittedAt: null,
  trackingNudgeStage: 0,
};

describe("nudgeDue", () => {
  it("does nothing on the day of submission", () => {
    expect(nudgeDue(base, NOW)).toEqual({ due: "none" });
  });

  it("reminds the customer after three days", () => {
    expect(nudgeDue({ ...base, returnSubmittedAt: daysAgo(3) }, NOW)).toEqual({
      due: "reminder",
      nextStage: 1,
    });
  });

  it("does not remind twice", () => {
    // A cron running every 15 minutes would otherwise send 96 a day.
    const already = { ...base, returnSubmittedAt: daysAgo(5), trackingNudgeStage: 1 };

    expect(nudgeDue(already, NOW)).toEqual({ due: "none" });
  });

  it("alerts a human after ten days", () => {
    const stale = { ...base, returnSubmittedAt: daysAgo(10), trackingNudgeStage: 1 };

    expect(nudgeDue(stale, NOW)).toEqual({ due: "alert", nextStage: 2 });
  });

  it("does not alert twice", () => {
    const done = { ...base, returnSubmittedAt: daysAgo(40), trackingNudgeStage: 2 };

    expect(nudgeDue(done, NOW)).toEqual({ due: "none" });
  });

  it("skips a return whose tracking already arrived", () => {
    const tracked = {
      ...base,
      returnSubmittedAt: daysAgo(30),
      trackingSubmittedAt: daysAgo(29),
    };

    expect(nudgeDue(tracked, NOW)).toEqual({ due: "none" });
  });

  it("skips lanes that are not self-booked", () => {
    const correos = { ...base, returnMethod: "CORREOS", returnSubmittedAt: daysAgo(30) };

    expect(nudgeDue(correos, NOW)).toEqual({ due: "none" });
  });

  it("skips a row with no submission stamp rather than treating it as ancient", () => {
    // Legacy rows have no timestamp at all. Reading null as epoch would alert
    // on every order we have ever stored.
    const legacy = { ...base, returnSubmittedAt: null };

    expect(nudgeDue(legacy, NOW)).toEqual({ due: "none" });
  });

  it("skips straight to the alert if the reminder was never sent", () => {
    // A ten-day-old return that somehow missed its reminder still needs a
    // human, and jumping the stage is better than re-sending a stale nudge.
    const skipped = { ...base, returnSubmittedAt: daysAgo(12), trackingNudgeStage: 0 };

    expect(nudgeDue(skipped, NOW)).toEqual({ due: "alert", nextStage: 2 });
  });
});

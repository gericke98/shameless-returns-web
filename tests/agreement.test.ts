import { describe, expect, it } from "vitest";
import {
  buildAgreement,
  creditTotal,
  shownTotalEuros,
  splitProportionally,
} from "@/lib/agreement";
import type { ValuedLine } from "@/lib/basket";

const ret = (id: number, cents: number, quantity = 1): ValuedLine => ({
  id,
  action: "DEVOLUCIÓN",
  quantity,
  returnedCents: cents,
  replacementCents: 0,
  degraded: false,
});
const swap = (id: number, cents: number, replacement: number): ValuedLine => ({
  id,
  action: "CAMBIO",
  quantity: 1,
  returnedCents: cents,
  replacementCents: replacement,
  degraded: false,
});
const fee = { returnLegCents: 500, outboundLegCents: 0, feeCents: 500, selfBooked: false };

describe("buildAgreement", () => {
  it("owes a cheaper swap its difference, on the exchanged line", () => {
    const a = buildAgreement({ ...fee, lines: [swap(1, 10000, 6000)], tender: "refund" });

    expect(a.netCents).toBe(3500);
    expect(a.owedCents).toBe(3500);
    expect(a.lines[0].payCents).toBe(3500);
    expect(a.stripeChargeCents).toBe(0);
  });

  it("charges one fee per basket, not per line", () => {
    const a = buildAgreement({ ...fee, lines: [ret(1, 5500), ret(2, 5500)], tender: "refund" });

    expect(a.owedCents).toBe(10500);
    expect(a.lines.map((l) => l.payCents)).toEqual([5250, 5250]);
  });

  it("lets a refund line pay for an upgrade instead of being refunded again", () => {
    // Return 30.00, swap 50.00 → 100.00: owes 20.00 + 5.00 fee through Stripe.
    const a = buildAgreement({
      ...fee,
      lines: [ret(1, 3000), swap(2, 5000, 10000)],
      tender: "refund",
    });

    expect(a.stripeChargeCents).toBe(2500);
    expect(a.owedCents).toBe(0);
    expect(a.lines.map((l) => l.payCents)).toEqual([0, 0]);
    expect(a.lines[1].stripeFundedCents).toBe(2500);
  });

  it("pays credit at 115%, rounded half up, and shows that number", () => {
    const a = buildAgreement({ ...fee, lines: [ret(1, 3530)], tender: "credit" });

    // (35.30 − 5.00) × 1.15 = 34.845 → 34.85
    expect(a.owedCents).toBe(3485);
    expect(shownTotalEuros(a)).toBe(34.85);
  });

  it("never inflates a charge with the credit bonus", () => {
    const a = buildAgreement({
      ...fee,
      lines: [swap(1, 4000, 6000)],
      tender: "credit",
    });

    expect(a.stripeChargeCents).toBe(2500);
    expect(shownTotalEuros(a)).toBe(-25);
  });

  it("waives a shortfall under Stripe's minimum", () => {
    const a = buildAgreement({ ...fee, lines: [swap(1, 4000, 4030)], tender: "refund" });

    expect(a.netCents).toBe(-530);
    expect(a.stripeChargeCents).toBe(530);
    const small = buildAgreement({
      returnLegCents: 0,
      outboundLegCents: 0,
      feeCents: 0,
      selfBooked: false,
      lines: [swap(1, 4000, 4030)],
      tender: "refund",
    });
    expect(small.stripeChargeCents).toBe(0);
    expect(small.waivedCents).toBe(30);
  });

  it("charges a self-booked return only the outbound leg", () => {
    const a = buildAgreement({
      returnLegCents: 500,
      outboundLegCents: 300,
      feeCents: 800,
      selfBooked: true,
      lines: [ret(1, 5000)],
      tender: "refund",
    });

    expect(a.chargedFeeCents).toBe(300);
    expect(a.owedCents).toBe(4700);
  });

  it("keeps indivisible cents on the submission, never on a line by position", () => {
    const a = buildAgreement({
      ...fee,
      lines: [ret(1, 1000), ret(2, 1000), ret(3, 1001)],
      tender: "refund",
    });

    // owed 2501 over weights 1000/1000/1001
    expect(a.lines.map((l) => l.payCents)).toEqual([833, 833, 834]);
    expect(a.residualCents).toBe(1);
  });

  it("conserves money on random baskets", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 10000; run++) {
      const lines = Array.from({ length: 1 + rand(4) }, (_, i) =>
        rand(2) ? ret(i, 100 + rand(20000), 1 + rand(2)) : swap(i, 100 + rand(20000), rand(20000))
      );
      const legs = { returnLegCents: rand(1500), outboundLegCents: rand(1500) };
      const a = buildAgreement({
        ...legs,
        feeCents: legs.returnLegCents + legs.outboundLegCents,
        selfBooked: rand(4) === 0,
        lines,
        tender: rand(2) ? "credit" : "refund",
      });

      expect(a.returnedValueCents - a.replacementValueCents - a.chargedFeeCents).toBe(a.netCents);
      expect(a.lines.reduce((s, l) => s + l.payCents, 0) + a.residualCents).toBe(a.owedCents);
      expect(a.residualCents).toBeLessThan(a.lines.length);
      expect(a.lines.reduce((s, l) => s + l.stripeFundedCents, 0)).toBeLessThanOrEqual(
        a.stripeChargeCents
      );
      expect(a.stripeChargeCents + a.waivedCents).toBe(Math.max(0, -a.netCents));
      if (a.netCents <= 0) expect(a.owedCents).toBe(0);
    }
  });
});

describe("creditTotal", () => {
  it("rounds half up in integer arithmetic", () => {
    expect(creditTotal(30)).toBe(35); // 34.5 → 35
    expect(creditTotal(3030)).toBe(3485); // 3484.5 → 3485
    expect(creditTotal(100)).toBe(115);
  });
});

describe("splitProportionally", () => {
  it("returns everything as residual when there is nothing to weigh", () => {
    expect(splitProportionally(10, [0, 0])).toEqual({ shares: [0, 0], residual: 10 });
  });
});

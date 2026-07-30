import { describe, expect, it } from "vitest";
import {
  countProducts,
  filterGroups,
  groupReturns,
  pendingExchanges,
} from "@/lib/dashboardGrouping";
import { ACTIONS } from "@/placeholder";

// The table rendered one row per garment, repeating the order number, customer
// and status once per garment — so a two-garment return read as two unrelated
// returns. Real example from production:
//
//   #310927  OLYMPUS CREWNECK      X-Small  DEVOLUCIÓN
//   #310927  COPENHAGEN CREWNECK   X-Small  DEVOLUCIÓN
//
// Two different garments, one parcel, one customer.

const order = (id: string, number: string, over: Record<string, string> = {}) => ({
  id,
  orderNumber: number,
  email: "ana@example.com",
  shippingName: "Ana Ruiz",
  ...over,
});

const product = (id: number, title: string, refunded = false) => ({
  id,
  title,
  refunded,
});

const DELIVERED = { label: "Entregado", phase: "entregado" };
const UNKNOWN = { label: "Sin información", phase: "sin_informacion" };

const ROWS = [
  { order: order("1", "#310927"), product: product(1, "OLYMPUS"), status: DELIVERED },
  { order: order("1", "#310927"), product: product(2, "COPENHAGEN"), status: DELIVERED },
  { order: order("2", "#310897", { shippingName: "Luis Paz", email: "luis@example.com" }), product: product(3, "ARCHIVE JADE"), status: UNKNOWN },
];

const all = () => ({ searchTerm: "", keepProduct: () => true, keepStatus: () => true });

describe("groupReturns", () => {
  it("puts every garment of an order in ONE group", () => {
    const groups = groupReturns(ROWS);

    expect(groups).toHaveLength(2);
    expect(groups[0].order.orderNumber).toBe("#310927");
    expect(groups[0].products.map((p) => p.title)).toEqual(["OLYMPUS", "COPENHAGEN"]);
  });

  it("keeps the order the rows arrived in", () => {
    expect(groupReturns(ROWS).map((g) => g.order.orderNumber)).toEqual([
      "#310927",
      "#310897",
    ]);
  });

  it("groups by order id, not by the displayed order number", () => {
    // The number is display data. Grouping on it would merge two customers'
    // returns into one card if it were ever duplicated.
    const rows = [
      { order: order("1", "#310927"), product: product(1, "A"), status: DELIVERED },
      { order: order("2", "#310927", { shippingName: "Someone Else" }), product: product(2, "B"), status: DELIVERED },
    ];

    expect(groupReturns(rows)).toHaveLength(2);
  });

  it("survives an empty list", () => {
    expect(groupReturns([])).toEqual([]);
  });
});

describe("filterGroups", () => {
  const groups = groupReturns(ROWS);

  it("matches the search against order number, email and name", () => {
    expect(filterGroups(groups, { ...all(), searchTerm: "310897" })).toHaveLength(1);
    expect(filterGroups(groups, { ...all(), searchTerm: "luis@" })).toHaveLength(1);
    expect(filterGroups(groups, { ...all(), searchTerm: "ana ruiz" })).toHaveLength(1);
  });

  it("ignores case and surrounding whitespace in the search", () => {
    expect(filterGroups(groups, { ...all(), searchTerm: "  ANA RUIZ  " })).toHaveLength(1);
  });

  it("keeps whole groups by shipping status", () => {
    const delivered = filterGroups(groups, {
      ...all(),
      keepStatus: (s: any) => s.phase === "entregado",
    });
    expect(delivered.map((g) => g.order.orderNumber)).toEqual(["#310927"]);
  });

  it("filters garments INSIDE a group", () => {
    const rows = [
      { order: order("1", "#310927"), product: product(1, "OLYMPUS", true), status: DELIVERED },
      { order: order("1", "#310927"), product: product(2, "COPENHAGEN", false), status: DELIVERED },
    ];
    const result = filterGroups(groupReturns(rows), {
      ...all(),
      keepProduct: (p: any) => !p.refunded,
    });

    expect(result).toHaveLength(1);
    expect(result[0].products.map((p) => p.title)).toEqual(["COPENHAGEN"]);
  });

  it("drops a group whose garments were all filtered out", () => {
    // An order header with nothing under it reads as a data fault.
    const result = filterGroups(groups, { ...all(), keepProduct: () => false });
    expect(result).toEqual([]);
  });

  it("returns everything when nothing is filtered", () => {
    expect(filterGroups(groups, all())).toHaveLength(2);
  });
});

describe("countProducts", () => {
  it("counts garments across groups, not groups", () => {
    // Pagination counts ORDERS; without this the page size looks like it
    // silently dropped rows.
    expect(countProducts(groupReturns(ROWS))).toBe(3);
  });

  it("is zero for no groups", () => {
    expect(countProducts([])).toBe(0);
  });
});

describe("pendingExchanges", () => {
  const line = (action: string, refunded = false) => ({ action, refunded });

  it("collects the exchange lines a single action would settle", () => {
    // validateReturn creates ONE Shopify order for all of them, so they are one
    // action, not two.
    const products = [line(ACTIONS.CHANGE), line(ACTIONS.CHANGE)];
    expect(pendingExchanges(products, ACTIONS.CHANGE)).toHaveLength(2);
  });

  it("excludes returns — each is refunded for its own amount", () => {
    const products = [line(ACTIONS.CHANGE), line(ACTIONS.RETURN)];
    expect(pendingExchanges(products, ACTIONS.CHANGE)).toHaveLength(1);
  });

  it("excludes exchanges that are already settled", () => {
    // Their replacement has shipped; offering to process them again would mint
    // a second parcel.
    const products = [line(ACTIONS.CHANGE, true), line(ACTIONS.CHANGE, false)];
    expect(pendingExchanges(products, ACTIONS.CHANGE)).toHaveLength(1);
  });

  it("matches the accented DEVOLUCION constant, not a lookalike string", () => {
    // productsOrder.action stores the accented code. Comparing against an
    // unaccented "DEVOLUCION" is a mistake this table has made before.
    expect(ACTIONS.RETURN).toBe("DEVOLUCI\u00d3N");
    expect(pendingExchanges([line("DEVOLUCION")], ACTIONS.CHANGE)).toHaveLength(0);
  });

  it("returns nothing for an order with no exchanges", () => {
    expect(pendingExchanges([line(ACTIONS.RETURN)], ACTIONS.CHANGE)).toEqual([]);
  });
});

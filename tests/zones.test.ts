import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { isInternationalOrder } from "@/lib/countries";
import { SUB_ZONES, ZONE_KEY_PATTERN, resolveZone } from "@/lib/zones";

// Spain is one country and five carrier zones. A return from Ceuta costs
// EUR 44.59 against EUR 4.01 from Madrid, and every one of them used to be
// billed the peninsular rate.

describe("resolveZone", () => {
  it("leaves non-Spanish destinations as their country code", () => {
    expect(resolveZone("IT", "00184")).toBe("IT");
    expect(resolveZone("Italia", "00184")).toBe("IT");
    // A Spanish-looking postcode must not create a Spanish sub-zone for a
    // country that happens to use the same numbering.
    expect(resolveZone("FR", "07000")).toBe("FR");
  });

  it("resolves peninsular Spain to plain ES", () => {
    expect(resolveZone("ES", "28001")).toBe("ES"); // Madrid
    expect(resolveZone("España", "08001")).toBe("ES"); // Barcelona
    expect(resolveZone("ES", "46001")).toBe("ES"); // Valencia
  });

  it("resolves the Balearics from the 07 prefix", () => {
    expect(resolveZone("ES", "07001")).toBe("ES-IB"); // Palma
    expect(resolveZone("ES", "07800")).toBe("ES-IB"); // Ibiza
  });

  it("resolves both Canarian provinces to one zone", () => {
    expect(resolveZone("ES", "35001")).toBe("ES-CN"); // Las Palmas
    expect(resolveZone("ES", "38001")).toBe("ES-CN"); // Santa Cruz de Tenerife
  });

  it("resolves Ceuta and Melilla to one zone", () => {
    expect(resolveZone("ES", "51001")).toBe("ES-CM");
    expect(resolveZone("ES", "52001")).toBe("ES-CM");
  });

  it("pads a four-digit Balearic code rather than misreading it", () => {
    // The leading zero is significant and systems that store postcodes as
    // numbers drop it. Read as-is, "7001" would take the "70" prefix, match
    // nothing, and bill Mallorca at the peninsular rate.
    expect(resolveZone("ES", "7001")).toBe("ES-IB");
    expect(resolveZone("ES", 7001 as unknown as string)).toBe("ES-IB");
  });

  it("ignores separators and whitespace in the postcode", () => {
    expect(resolveZone("ES", " 35 001 ")).toBe("ES-CN");
    expect(resolveZone("ES", "38-001")).toBe("ES-CN");
  });

  it("falls back to peninsular for a missing or unusable postcode", () => {
    // Cheapest Spanish zone, so this can undercharge — but the alternative is
    // inventing an island from nothing, and a customer must not be billed an
    // island rate because their postcode failed to parse.
    expect(resolveZone("ES", null)).toBe("ES");
    expect(resolveZone("ES", "")).toBe("ES");
    expect(resolveZone("ES", "not a postcode")).toBe("ES");
    expect(resolveZone("ES", "123")).toBe("ES");
  });

  it("returns null for a country it cannot name", () => {
    // Same contract as normalizeCountry — callers already read null as
    // "use the '*' row".
    expect(resolveZone("Wakanda", "12345")).toBeNull();
    expect(resolveZone(null, "28001")).toBeNull();
  });

  it("produces only keys the fee table can hold", () => {
    const samples = ["28001", "07001", "35001", "38001", "51001", "52001", ""];
    for (const zip of samples) {
      expect(resolveZone("ES", zip)).toMatch(ZONE_KEY_PATTERN);
    }
    for (const zone of SUB_ZONES) {
      expect(zone).toMatch(ZONE_KEY_PATTERN);
    }
  });

  it("can reach every declared sub-zone", () => {
    // Guards the gap where a zone is priced and exported but no postal prefix
    // actually maps to it, so it silently never applies.
    const reachable = new Set(
      ["07001", "35001", "38001", "51001", "52001"].map((z) => resolveZone("ES", z))
    );
    for (const zone of SUB_ZONES) {
      expect(reachable.has(zone), `${zone} is unreachable`).toBe(true);
    }
  });
});

describe("lib/countries stays client-safe", () => {
  // isInternationalOrder moved here from actions/amphoraReturn.ts so the
  // return-method screen — a client component — can decide between "we collect
  // it" and "drop it off" without pulling the Neon client and the Amphora API
  // into the browser bundle. Moving it back would compile fine and break the
  // build only at bundling time, so guard the property directly.
  const source = readFileSync(resolve(process.cwd(), "lib/countries.ts"), "utf8");

  it("imports nothing server-only", () => {
    // Only the module specifiers, not the whole file: the header comment says
    // "must not import from db/ or any server-only code", and scanning raw
    // text flags that sentence as a violation of itself.
    const specifiers = Array.from(
      source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s+["']([^"']+)["']/g)
    ).map((m) => m[1]);

    const forbidden = ["db/", "drizzle", "next/headers", "next/cache", "server-only", "axios"];
    const found = specifiers.filter((mod) => forbidden.some((f) => mod.includes(f)));

    expect(found, `server-only imports in lib/countries.ts: ${found.join(", ")}`).toEqual([]);
  });

  it("still exports the predicate the international flow routes on", () => {
    expect(isInternationalOrder("ES")).toBe(false);
    expect(isInternationalOrder("España")).toBe(false);
    // Spanish islands and enclaves stay on the domestic flow, which is why
    // this is not the same question resolveZone answers.
    expect(isInternationalOrder("ES")).toBe(false);
    expect(isInternationalOrder("IT")).toBe(true);
    expect(isInternationalOrder("Wakanda")).toBe(true);
    // Empty is NOT international — an order with no country must not be
    // routed abroad on the strength of a missing field.
    expect(isInternationalOrder("")).toBe(false);
    expect(isInternationalOrder(null)).toBe(false);
  });
});

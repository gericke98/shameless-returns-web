import { describe, expect, it } from "vitest";
import { parseFeeCents } from "../scripts/parseFeeCents";

// This suite must be importable and runnable without a DATABASE_URL: it
// imports only the pure `parseFeeCents` helper from `scripts/parseFeeCents.ts`,
// which has no `db`/`dotenv` import, so it never touches
// `scripts/seed-shipping-fees.ts`'s DB-touching `main()` path.
describe("parseFeeCents", () => {
  it("throws when the env var is unset", () => {
    expect(() => parseFeeCents(undefined, "TEST_VAR")).toThrow("TEST_VAR");
  });

  it("throws when the env var is non-numeric", () => {
    expect(() => parseFeeCents("abc", "TEST_VAR")).toThrow("TEST_VAR");
  });

  it("throws when the env var is an empty string", () => {
    expect(() => parseFeeCents("", "TEST_VAR")).toThrow("TEST_VAR");
  });

  it("throws when the env var is whitespace-only", () => {
    expect(() => parseFeeCents("   ", "TEST_VAR")).toThrow("TEST_VAR");
  });

  it("throws when the env var is negative", () => {
    expect(() => parseFeeCents("-5", "TEST_VAR")).toThrow("TEST_VAR");
  });

  it("throws when the env var is zero", () => {
    expect(() => parseFeeCents("0", "TEST_VAR")).toThrow("TEST_VAR");
  });

  it("returns integer cents for a valid positive amount", () => {
    expect(parseFeeCents("4.99", "TEST_VAR")).toBe(499);
  });
});

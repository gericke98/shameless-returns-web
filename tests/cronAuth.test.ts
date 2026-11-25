import { afterEach, describe, expect, it } from "vitest";
import { verifyCronRequest } from "@/lib/server/cron";

// The one cron credential check (F1 spec §6), shared by all six cron routes.
const req = (authorization?: string) =>
  new Request("https://x.test/api/cron/job", authorization ? { headers: { authorization } } : {});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("verifyCronRequest", () => {
  it("accepts exactly Bearer $CRON_SECRET", () => {
    process.env.CRON_SECRET = "s3cret";
    expect(verifyCronRequest(req("Bearer s3cret"))).toBe(true);
  });

  it.each([[undefined], [""], ["s3cret"], ["Bearer s3cre"], ["bearer s3cret"]])(
    "refuses %j",
    (header) => {
      process.env.CRON_SECRET = "s3cret";
      expect(verifyCronRequest(req(header))).toBe(false);
    }
  );

  it("refuses everything when CRON_SECRET is unset, even 'Bearer undefined'", () => {
    expect(verifyCronRequest(req("Bearer undefined"))).toBe(false);
    expect(verifyCronRequest(req("Bearer "))).toBe(false);
  });
});

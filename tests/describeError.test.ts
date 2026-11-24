import { describe, expect, it } from "vitest";
import { describeError } from "@/lib/describeError";

describe("describeError", () => {
  it("shows an API's JSON body with its status, never [object Object]", () => {
    const e = Object.assign(new Error("Request failed with status code 422"), {
      response: { status: 422, data: { errors: [{ field: "carrier_url" }] } },
    });
    expect(describeError(e)).toBe('HTTP 422: {"errors":[{"field":"carrier_url"}]}');
  });

  it("shows a text body as is", () => {
    const e = Object.assign(new Error("x"), { response: { status: 502, data: "Bad Gateway" } });
    expect(describeError(e)).toBe("HTTP 502: Bad Gateway");
  });

  it("falls back to the client's message when the body is empty", () => {
    const e = Object.assign(new Error("Request failed with status code 500"), {
      response: { status: 500, data: "" },
    });
    expect(describeError(e)).toBe("HTTP 500: Request failed with status code 500");
  });

  it("uses the message of a plain error, and serialises anything else", () => {
    expect(describeError(new Error("timeout"))).toBe("timeout");
    expect(describeError({ code: 1 })).toBe('{"code":1}');
    expect(describeError("plain")).toBe("plain");
  });

  it("bounds a huge body", () => {
    const e = Object.assign(new Error("x"), { response: { status: 400, data: "y".repeat(5000) } });
    expect(describeError(e).length).toBeLessThan(2100);
    expect(describeError(e)).toContain("(truncated)");
  });
});

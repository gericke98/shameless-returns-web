import { describe, expect, it } from "vitest";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";

const COMPLETE = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: "Apt 4",
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

describe("parseDeliveryInput", () => {
  it("returns null when the block is absent entirely", () => {
    expect(parseDeliveryInput({})).toEqual({ ok: true, value: null });
  });

  it("returns null when every field is blank", () => {
    expect(
      parseDeliveryInput({ deliveryName: "", deliveryAddress1: "  ", deliveryCountry: "" })
    ).toEqual({ ok: true, value: null });
  });

  it("accepts a complete block", () => {
    expect(parseDeliveryInput(COMPLETE)).toEqual({
      ok: true,
      value: {
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: "Apt 4",
        zip: "10271",
        city: "New York",
        province: "NY",
        country: "US",
      },
    });
  });

  it("treats address2 and province as genuinely optional", () => {
    const { deliveryAddress2, deliveryProvince, ...rest } = COMPLETE;
    expect(parseDeliveryInput(rest)).toEqual({
      ok: true,
      value: {
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: null,
        zip: "10271",
        city: "New York",
        province: null,
        country: "US",
      },
    });
  });

  // All-or-nothing. Half an address must not be written, because
  // deliveryAddressOf would then silently fall back to the collection address
  // and the customer would be told their replacement is going somewhere it is
  // not.
  it("rejects a partial block", () => {
    const { deliveryCity, ...partial } = COMPLETE;
    expect(parseDeliveryInput(partial)).toEqual({ ok: false, reason: "partial" });
  });

  it("rejects a blank required field as partial", () => {
    expect(parseDeliveryInput({ ...COMPLETE, deliveryZip: "   " })).toEqual({
      ok: false,
      reason: "partial",
    });
  });

  // The country is the one field that sets the price, so it is the one field
  // that cannot be free text. Anything outside SUPPORTED_COUNTRIES is refused
  // rather than silently priced from the '*' row.
  it("rejects a country outside SUPPORTED_COUNTRIES", () => {
    expect(parseDeliveryInput({ ...COMPLETE, deliveryCountry: "Freedonia" })).toEqual({
      ok: false,
      reason: "unsupported-country",
    });
  });

  it("normalises a country name to its ISO-2 code", () => {
    const parsed = parseDeliveryInput({ ...COMPLETE, deliveryCountry: "Estados Unidos" });
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.value?.country).toBe("US");
  });

  it("trims surrounding whitespace", () => {
    const parsed = parseDeliveryInput({ ...COMPLETE, deliveryCity: "  New York  " });
    expect(parsed.ok && parsed.value?.city).toBe("New York");
  });
});

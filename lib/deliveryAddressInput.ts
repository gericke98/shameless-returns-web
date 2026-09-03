// Validate the delivery-address block a customer submits.
//
// Separate from lib/deliveryAddress.ts, which READS what is already stored.
// This is the write side, and it is stricter: the stored form has to tolerate
// whatever is in the database, while nothing partial may ever be written.
//
// Pure, so the form can run exactly the same validation before submitting.
import { normalizeCountry, SUPPORTED_COUNTRIES } from "./countries";

export type DeliveryInput = {
  readonly name: string;
  readonly address1: string;
  readonly address2: string | null;
  readonly zip: string;
  readonly city: string;
  readonly province: string | null;
  readonly country: string;
};

export type DeliveryParse =
  | { ok: true; value: DeliveryInput | null }
  | { ok: false; reason: "partial" | "unsupported-country" };

const SUPPORTED = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));

const trim = (value: string | undefined): string => (value ?? "").trim();

/** The fields that make an address deliverable and priceable. `address2` and
 *  `province` are excluded: plenty of real addresses have neither, and
 *  `province` is only ever sent to Shopify for Spain. */
const REQUIRED = [
  "deliveryName",
  "deliveryAddress1",
  "deliveryZip",
  "deliveryCity",
  "deliveryCountry",
] as const;

/**
 * Parse the delivery block out of a submitted form.
 *
 * Three outcomes, and the caller must distinguish them:
 *  - `{ ok: true, value: null }` — the customer did not ask for a separate
 *    delivery address. Clear any stored one.
 *  - `{ ok: true, value }` — a complete, priceable address.
 *  - `{ ok: false }` — reject the whole submission. Never write half.
 *
 * All-or-nothing is the point. A partial write would leave
 * `hasSeparateDelivery` false, so the replacement would quietly ship to the
 * collection address while the customer believed otherwise — and the fee they
 * were quoted would not match the fee they were charged.
 */
export function parseDeliveryInput(
  fields: Record<string, string | undefined>
): DeliveryParse {
  const present = REQUIRED.map((key) => trim(fields[key]));
  const filledCount = present.filter((v) => v.length > 0).length;

  // Nothing asked for. Not an error — this is the common case.
  if (filledCount === 0) return { ok: true, value: null };
  if (filledCount < REQUIRED.length) return { ok: false, reason: "partial" };

  // The country sets the price, so it is the one field that cannot be free
  // text. `normalizeCountry` accepts either a display name or an ISO-2 code
  // and returns the code.
  const country = normalizeCountry(trim(fields.deliveryCountry));
  if (!country || !SUPPORTED.has(country)) {
    return { ok: false, reason: "unsupported-country" };
  }

  const address2 = trim(fields.deliveryAddress2);
  const province = trim(fields.deliveryProvince);

  return {
    ok: true,
    value: {
      name: trim(fields.deliveryName),
      address1: trim(fields.deliveryAddress1),
      address2: address2.length > 0 ? address2 : null,
      zip: trim(fields.deliveryZip),
      city: trim(fields.deliveryCity),
      province: province.length > 0 ? province : null,
      country,
    },
  };
}

// The orderCreate variables for an exchange's replacement order, built ONCE at
// admission and frozen into the operation (S2 plan L3, L6). Pure.
//
// Moved here from `createOrder` (db/queries.ts), whose address rules it keeps:
// the customer's own ISO-2 country (never the shop's — #311370, #311687), no
// province code abroad, billing at the collection address and shipping at the
// delivery address. What changes: the quantity is the submission's (it was a
// hardcoded 1), each line names the returned garment it replaces through a
// line-item property, `sourceIdentifier` is the op id, and the inventory
// behaviour depends on whether a stock hold existed at admission.
import { normalizeCountry } from "@/lib/countries";
import { deliveryAddressOf } from "@/lib/deliveryAddress";
import { variantGid } from "@/lib/shopifyIds";
import { SOURCE_LINE_PROPERTY } from "./types";

const SPANISH_PROVINCE_CODES: { [key: string]: string } = {
  Álava: "VI",
  Albacete: "AB",
  Alicante: "A",
  Almería: "AL",
  Asturias: "O",
  Ávila: "AV",
  Badajoz: "BA",
  Barcelona: "B",
  Burgos: "BU",
  Cáceres: "CC",
  Cádiz: "CA",
  Cantabria: "S",
  Castellón: "CS",
  "Ciudad Real": "CR",
  Córdoba: "CO",
  "La Coruña": "C",
  Cuenca: "CU",
  Gerona: "GI",
  Granada: "GR",
  Guadalajara: "GU",
  Guipúzcoa: "SS",
  Huelva: "H",
  Huesca: "HU",
  "Islas Baleares": "PM",
  Jaén: "J",
  León: "LE",
  Lérida: "L",
  Lugo: "LU",
  Madrid: "M",
  Málaga: "MA",
  Murcia: "MU",
  Navarra: "NA",
  Orense: "OR",
  Palencia: "P",
  "Las Palmas": "GC",
  Pontevedra: "PO",
  "La Rioja": "LO",
  Salamanca: "SA",
  "Santa Cruz de Tenerife": "TF",
  Segovia: "SG",
  Sevilla: "SE",
  Soria: "SO",
  Tarragona: "T",
  Teruel: "TE",
  Toledo: "TO",
  Valencia: "V",
  Valladolid: "VA",
  Vizcaya: "BI",
  Zamora: "ZA",
  Zaragoza: "Z",
};

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/** A Spanish province name to its code; the input unchanged when unknown. */
export function getProvinceCode(provinceName: string): string {
  const target = fold(provinceName);
  for (const [name, code] of Object.entries(SPANISH_PROVINCE_CODES)) {
    if (fold(name) === target) return code;
  }
  return provinceName;
}

export type ExchangeOrderSource = {
  orderNumber: string;
  email: string;
  shippingName: string | null;
  shippingAddress1: string;
  shippingAddress2: string | null;
  shippingZip: string;
  shippingCity: string;
  shippingProvince: string | null;
  shippingCountry: string;
  shippingPhone: string | null;
  deliveryName?: string | null;
  deliveryAddress1?: string | null;
  deliveryAddress2?: string | null;
  deliveryZip?: string | null;
  deliveryCity?: string | null;
  deliveryProvince?: string | null;
  deliveryCountry?: string | null;
};

export type ExchangeLineInput = {
  productsorderId: number;
  newVariantId: string | null;
  quantity: number;
};

export type ExchangeOrderBuild =
  | { ok: true; variables: { order: Record<string, unknown>; options: Record<string, unknown> } }
  | { ok: false; reason: string };

export function buildExchangeOrderVariables(input: {
  opId: string;
  order: ExchangeOrderSource;
  customerGid: string | null;
  lines: readonly ExchangeLineInput[];
  /** A stock hold for exactly these garments existed at admission. */
  holdExisted: boolean;
}): ExchangeOrderBuild {
  const { order } = input;
  const delivery = deliveryAddressOf(order as any);
  const countryCode = normalizeCountry(delivery.country);
  const billingCountryCode = normalizeCountry(order.shippingCountry);
  if (!countryCode || !billingCountryCode) {
    return { ok: false, reason: "unresolvable-country" };
  }

  const lineItems = [];
  for (const line of input.lines) {
    const variantId = variantGid(line.newVariantId);
    if (!variantId) return { ok: false, reason: `bad-replacement-variant:${line.productsorderId}` };
    lineItems.push({
      variantId,
      quantity: line.quantity,
      requiresShipping: true,
      properties: [{ name: SOURCE_LINE_PROPERTY, value: String(line.productsorderId) }],
    });
  }

  const provinceCode =
    countryCode === "ES"
      ? delivery.province
        ? getProvinceCode(delivery.province)
        : getProvinceCode(delivery.city)
      : undefined;
  const billingProvinceCode =
    billingCountryCode === "ES"
      ? order.shippingProvince
        ? getProvinceCode(order.shippingProvince)
        : getProvinceCode(order.shippingCity)
      : undefined;

  return {
    ok: true,
    variables: {
      options: {
        // The unit is already held for this customer by the draft order, which
        // is released only AFTER this order exists (L6): no window in which
        // the garment is free. Without a hold, the shop's policy applies.
        inventoryBehaviour: input.holdExisted ? "DECREMENT_IGNORING_POLICY" : "DECREMENT_OBEYING_POLICY",
        sendFulfillmentReceipt: true,
        sendReceipt: true,
      },
      order: {
        billingAddress: {
          address1: order.shippingAddress1,
          address2: order.shippingAddress2 || "",
          city: order.shippingCity,
          countryCode: billingCountryCode,
          firstName: order.shippingName || "Return",
          lastName: "Return",
          phone: order.shippingPhone || "+34608667749",
          provinceCode: billingProvinceCode,
          zip: order.shippingZip,
        },
        buyerAcceptsMarketing: true,
        currency: "EUR",
        email: order.email,
        ...(input.customerGid ? { customer: { toAssociate: { id: input.customerGid } } } : {}),
        financialStatus: "PAID",
        lineItems,
        note: `Exchange order for ${order.orderNumber}`,
        shippingAddress: {
          address1: delivery.address1,
          address2: delivery.address2 || "",
          city: delivery.city,
          countryCode,
          firstName: delivery.name || "Return",
          lastName: "Return",
          phone: order.shippingPhone || "+34608667749",
          provinceCode,
          zip: delivery.zip,
        },
        shippingLines: [
          {
            priceSet: { shopMoney: { amount: "4.00", currencyCode: "EUR" } },
            title: "Estándar",
          },
        ],
        sourceIdentifier: input.opId,
        tags: ["Change", `Order ${order.orderNumber}`],
        taxesIncluded: true,
        test: false,
        transactions: [
          {
            amountSet: { shopMoney: { amount: "0.01", currencyCode: "EUR" } },
            kind: "SALE",
            gateway: "manual",
            status: "SUCCESS",
          },
        ],
      },
    },
  };
}

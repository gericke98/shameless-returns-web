import { describe, expect, it } from "vitest";
import { buildCreateReturnBody } from "@/actions/amphora";

// Regression cover for the defect that stranded every international return.
//
// Amphora's `POST /{company_id}/returns` body is
//   { return_order: {...}, auto_approve: bool }
// with `auto_approve` a SIBLING of `return_order` (Company API v1.3.0,
// api-docs.amphoralogistics.com/specs/company-api.yaml). We nested it INSIDE
// `return_order`, so Amphora answered 422 "Invalid properties: {'auto_approve'}".
// That 422 was then read as "Amphora does not support auto-approval", the field
// was dropped, and `autoApprove: true` silently became a no-op — every return
// sat at PENDING with no carrier and no collection ever scheduled.

const INPUT = {
  orderId: "SHP 13194624794950",
  items: [{ sku: "20250502", quantity: 1 }],
  externalId: "13194624794950",
  time: "2026-07-29T11:48:35.000Z",
  name: "#310972",
  customerEmail: "marinholourenco2000@gmail.com",
};

const SHOP = "shameless-collective-madrid.myshopify.com";

describe("buildCreateReturnBody", () => {
  it("puts auto_approve at the top level, beside return_order", () => {
    const body = buildCreateReturnBody({ ...INPUT, autoApprove: true }, SHOP);

    expect(body.auto_approve).toBe(true);
    // The exact shape that produced the 422 in production.
    expect(body.return_order).not.toHaveProperty("auto_approve");
  });

  it("omits auto_approve entirely when not requested", () => {
    const body = buildCreateReturnBody(INPUT, SHOP);

    expect(body).not.toHaveProperty("auto_approve");
    expect(body.return_order).not.toHaveProperty("auto_approve");
  });

  it("sends only properties the documented schema accepts", () => {
    const body = buildCreateReturnBody({ ...INPUT, autoApprove: true }, SHOP);

    // Anything outside this set makes Amphora reject the whole request with a
    // 422 listing the offenders — which is exactly how this broke.
    const ALLOWED = new Set([
      "order_id",
      "items",
      "name",
      "shop_name",
      "external_id",
      "time",
      "customer_email",
      "customer_phone",
      "shipping_address",
      "shipping_address2",
      "shipping_address_city",
      "shipping_address_country_code",
      "shipping_address_zip",
      "shipping_address_name",
    ]);
    for (const key of Object.keys(body.return_order)) {
      expect(ALLOWED, `unexpected return_order property "${key}"`).toContain(
        key
      );
    }
    expect(Object.keys(body).sort()).toEqual(["auto_approve", "return_order"]);
  });

  it("carries the required fields through", () => {
    const { return_order } = buildCreateReturnBody(INPUT, SHOP);

    expect(return_order.order_id).toBe("SHP 13194624794950");
    expect(return_order.external_id).toBe("13194624794950");
    expect(return_order.shop_name).toBe(SHOP);
    expect(return_order.time).toBe("2026-07-29T11:48:35.000Z");
    expect(return_order.items).toEqual([{ sku: "20250502", quantity: 1 }]);
  });
});

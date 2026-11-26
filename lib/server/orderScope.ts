import "server-only";
// The order-scoped data access layer (F1 spec §3).
//
// A customer handler never touches `orders`/`productsorder` with an id it was
// sent. It is handed `orderScope(verifiedId)`, and every statement here carries
// that id in its OWN WHERE clause: `orders.id = id`, `productsorder.order_id =
// id`. A row id from the browser is only ever an additional filter, so a row of
// another order matches nothing — `not-editable`, a value, never a silent
// success.
import { and, eq, sql } from "drizzle-orm";
import db, { writeDb } from "@/db/drizzle";
import { orders, productsOrder } from "@/db/schema";
import { getVariantsByIds } from "@/db/queries";
import type { ReasonKey } from "@/placeholder";
import { isOfferedProduct } from "@/lib/replacementCatalogue";
import { lineCoverage } from "@/lib/settlement/stockGate";
import { variantGid } from "@/lib/shopifyIds";
import { rowNotHeldBySettlement } from "./submissionScope";
import type { DeliveryInput } from "@/lib/deliveryAddressInput";
import { refuse, type HandlerResult } from "@/lib/actionResult";
import type { VerifiedOrderId } from "./identity";

/** What the customer chose for one line. An exchange names the replacement variant. */
export type LineSelection =
  | { action: "DEVOLUCIÓN"; reason: ReasonKey; notes: string }
  | { action: "CAMBIO"; reason: ReasonKey; notes: string; newVariantId: string };

/** The collection address, plus the replacement's delivery block when it was offered. */
export type AddressFields = {
  name: string;
  address1: string;
  address2?: string;
  zip?: string;
  city: string;
  province?: string;
  phone?: string;
  /**
   * Only when the delivery block was OFFERED (the basket has an exchange):
   * `null` clears a stored delivery address, a value sets it. Absent leaves a
   * stored one untouched — a later pure-return pass never rendered the block,
   * and must not wipe a delivery address the customer already paid for.
   */
  delivery?: DeliveryInput | null;
};

const ok = { ok: true as const, value: {} };

export function orderScope(id: VerifiedOrderId) {
  /** This order's line `rowId`, while the customer may still change it. */
  const editableLine = (rowId: number) =>
    and(
      eq(productsOrder.id, rowId),
      eq(productsOrder.orderId, id),
      sql`${productsOrder.confirmed} IS NOT TRUE`,
      // A row inside an accepted submission is settlement's (S2 plan L2).
      rowNotHeldBySettlement(sql`productsorder`)
    );

  return {
    id,

    /** The order with its lines, read fresh: never React's request cache. */
    read() {
      return db.query.orders.findFirst({
        where: eq(orders.id, id),
        with: { products: true },
      });
    },

    /**
     * Save the customer's choice for one line. For an exchange the variant is
     * read back from Shopify and must be one the dialog offers
     * (`isOfferedProduct`); its title is Shopify's, never the client's. Then
     * Amphora must cover it (FX §#1): this row's quantity plus the order's
     * other unconfirmed exchange rows on the same SKU, net of every promise
     * already accepted — `replacement-unavailable` when it cannot,
     * `stock-unreadable` when Amphora cannot be read (never "enough").
     * The line's own identity (`variant_id`, `line_item`) is never written.
     */
    async setLineSelection(
      rowId: number,
      selection: LineSelection
    ): Promise<
      HandlerResult<{}, "not-editable" | "variant-not-offered" | "replacement-unavailable" | "stock-unreadable">
    > {
      let replacement: { new_variant_id: string | null; new_variant_title: string | null } = {
        new_variant_id: null,
        new_variant_title: null,
      };
      if (selection.action === "CAMBIO") {
        const gid = variantGid(selection.newVariantId);
        if (!gid) return refuse("variant-not-offered");
        const variant = (await getVariantsByIds([gid]))[gid];
        if (!variant || !isOfferedProduct(variant)) return refuse("variant-not-offered");

        const rows = await db
          .select({ id: productsOrder.id, quantity: productsOrder.quantity, newVariantId: productsOrder.new_variant_id })
          .from(productsOrder)
          .where(
            and(
              eq(productsOrder.orderId, id),
              sql`${productsOrder.confirmed} IS NOT TRUE`,
              eq(productsOrder.action, "CAMBIO"),
              sql`${productsOrder.new_variant_id} IS NOT NULL`
            )
          );
        const self = await db
          .select({ quantity: productsOrder.quantity })
          .from(productsOrder)
          .where(editableLine(rowId));
        if (self.length !== 1) return refuse("not-editable");
        const others = rows
          .filter((r) => r.id !== rowId)
          .map((r) => ({ variantGid: String(r.newVariantId), quantity: Number(r.quantity) }));
        const coverage = await lineCoverage({ variantGid: gid, quantity: Number(self[0].quantity) }, others);
        if (coverage.kind === "unreadable") return refuse("stock-unreadable");
        if (coverage.kind === "short") return refuse("replacement-unavailable");
        replacement = { new_variant_id: gid, new_variant_title: variant.variantTitle };
      }

      const written = await writeDb(id)
        .update(productsOrder)
        .set({
          changed: selection.action === "CAMBIO",
          action: selection.action,
          reason: selection.reason,
          notes: selection.notes,
          ...replacement,
        })
        .where(editableLine(rowId))
        .returning({ id: productsOrder.id });
      return written.length === 1 ? ok : refuse("not-editable");
    },

    /** Clear the choice on one line. */
    async clearLineSelection(rowId: number): Promise<HandlerResult<{}, "not-editable">> {
      const written = await writeDb(id)
        .update(productsOrder)
        .set({
          changed: false,
          action: null,
          reason: null,
          notes: null,
          new_variant_title: null,
          new_variant_id: null,
        })
        .where(editableLine(rowId))
        .returning({ id: productsOrder.id });
      return written.length === 1 ? ok : refuse("not-editable");
    },

    /**
     * The collection address the carrier books against, and the replacement's
     * delivery address. Never the country: it decides the carrier lane and
     * the fee, so it is not the customer's to set.
     */
    async saveAddress(fields: AddressFields): Promise<HandlerResult<{}, "not-editable">> {
      const deliveryColumns =
        fields.delivery === undefined
          ? {}
          : {
              deliveryName: fields.delivery?.name ?? null,
              deliveryAddress1: fields.delivery?.address1 ?? null,
              deliveryAddress2: fields.delivery?.address2 ?? null,
              deliveryZip: fields.delivery?.zip ?? null,
              deliveryCity: fields.delivery?.city ?? null,
              deliveryProvince: fields.delivery?.province ?? null,
              deliveryCountry: fields.delivery?.country ?? null,
            };
      const written = await writeDb(id)
        .update(orders)
        .set({
          shippingName: fields.name,
          shippingAddress1: fields.address1,
          shippingAddress2: fields.address2,
          shippingZip: fields.zip,
          shippingCity: fields.city,
          shippingProvince: fields.province,
          shippingPhone: fields.phone,
          ...deliveryColumns,
        })
        .where(eq(orders.id, id))
        .returning({ id: orders.id });
      return written.length === 1 ? ok : refuse("not-editable");
    },
  };
}

export type OrderScope = ReturnType<typeof orderScope>;

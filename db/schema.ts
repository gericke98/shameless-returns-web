import { relations } from "drizzle-orm";
import {
  integer,
  text,
  pgTable,
  serial,
  smallint,
  boolean,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// Creo una tabla que contenga las orders que han sido editadas
export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  orderNumber: text("order_number").notNull(),
  subtotal: integer("subtotal").notNull(),
  email: text("email").notNull(),
  shippingName: text("shipping_name").notNull(),
  shippingAddress1: text("shipping_address1").notNull(),
  shippingAddress2: text("shipping_address2"),
  shippingZip: text("shipping_zip").notNull(),
  shippingCity: text("shipping_city").notNull(),
  shippingProvince: text("shipping_province").notNull(),
  shippingCountry: text("shipping_country").notNull(),
  shippingPhone: text("shipping_phone").notNull(),
  // Tracking number (Correos CodEnvio for ES, or Amphora carrier_number for intl).
  locator: text("locator"),
  // Set for international (Amphora) returns: the carrier code + customer tracking URL.
  carrier: text("carrier"),
  carrierUrl: text("carrier_url"),
  // Latest Amphora lifecycle status seen for this return (PENDING / APROVED —
  // one P, that is the wire spelling / TRAVELLING / PROCESSING_WAREHOUSE /
  // RECEIVED / FINISHED / EXCEPTION ...). Written only by the Amphora status
  // webhook. Null means no webhook has been seen for this order yet.
  returnStatus: text("return_status"),
  /** The tracking notification we have already sent for this parcel:
   *  "accepted" | "in_transit" | "received" | "problem". Null means we have
   *  told the customer nothing yet. */
  lastTrackingKey: text("last_tracking_key"),
  /** WHICH parcel `lastTrackingKey` refers to. A re-registration produces a new
   *  Correos code whose journey legitimately starts over — without this, the
   *  new parcel's "accepted" notice would be suppressed because the old one had
   *  already passed that milestone. */
  lastTrackingLocator: text("last_tracking_locator"),
  // Draft order holding the replacement stock from the moment the customer
  // paid for their exchange until an admin validates it. NEVER completed — it
  // is deleted at validation and the real exchange order created as before.
  // Null when there is no exchange, or when the hold could not be placed.
  exchangeReservationId: text("exchange_reservation_id"),
  // Language the customer chose in the portal; drives the transactional email.
  locale: text("locale"),
  // The PaymentIntent behind the customer's portal charge, so a cancellation
  // can refund it without a human searching Stripe. Written by the Stripe
  // webhook. Null for free returns, and for anything booked before 2026-08-12
  // — those are recovered by listing sessions for the customer's email.
  stripePaymentIntent: text("stripe_payment_intent"),
  // Which lane shipped this return: 'CORREOS' | 'AMPHORA' | 'SELF'. Null on
  // rows created before self-booking existed, which are inferred by country
  // exactly as they were.
  returnMethod: text("return_method"),
  // When the return was confirmed. `orders` has no other timestamp column, so
  // without this there is nothing to measure the abandonment window against.
  returnSubmittedAt: timestamp("return_submitted_at", { withTimezone: true }),
  // Null while a SELF return is still waiting for the customer's tracking.
  trackingSubmittedAt: timestamp("tracking_submitted_at", { withTimezone: true }),
  // 0 none, 1 reminder sent, 2 ops alerted. A stored fact, so a cron running
  // every 15 minutes cannot re-send by recomputing from age.
  trackingNudgeStage: smallint("tracking_nudge_stage").notNull().default(0),
});

export const ordersRelations = relations(orders, ({ many }) => ({
  products: many(productsOrder),
}));

export const productsOrder = pgTable("productsorder", {
  id: serial("id").primaryKey(),
  lineItemId: text("line_item").notNull(),
  orderId: text("order_id").references(() => orders.id, {
    onDelete: "cascade",
  }),
  productId: text("product_id").notNull(),
  title: text("title").notNull(),
  variant_title: text("variant_title").notNull(),
  variant_id: text("variant_id").notNull(),
  price: text("price").notNull(),
  quantity: integer("quantity").notNull(),
  changed: boolean("changed").notNull(),
  action: text("action"),
  reason: text("reason"),
  notes: text("notes"),
  new_variant_title: text("new_variant_title"),
  new_variant_id: text("new_variant_id"),
  confirmed: boolean("confirmed"),
  return_id: text("return_id"),
  refunded: boolean("refunded"),
  credit: boolean("credit"),
  gift_card_id: text("gift_card_id"),
  return_line_item_id: text("return_line_item_id"),
  transaction_id: text("transaction_id"),
  transaction_amount: text("transaction_amount"),
});

export const productsOrderRelations = relations(productsOrder, ({ one }) => ({
  order: one(orders, {
    fields: [productsOrder.orderId],
    references: [orders.id],
  }),
}));

/**
 * The Correos label PDF, kept so it can be sent again.
 *
 * Correos returns the PDF exactly once, in the `<Fichero>` of the PreRegistro
 * response, and we used to throw it away and keep only the tracking string.
 * That made a lost confirmation email unrecoverable: the only way to put a
 * label back in a customer's hands was to register a WHOLE NEW PARCEL. During
 * the August 2026 email outage that cost five real registrations for two
 * customers, and it permanently desynced the warehouse — an Amphora EXTERNAL
 * return pins its `carrier_number` at approval and will not accept a new one
 * (see docs + the amphora-pins-carrier-number note), so the new label the
 * customer holds no longer matches the parcel Algete is expecting.
 *
 * DELIBERATELY ITS OWN TABLE, NOT A COLUMN ON `orders`. Drizzle's
 * `db.query.orders.findFirst()` builds an explicit column list from this file
 * and selects EVERY declared column, so a ~139KB base64 PDF on `orders` would
 * be read on every order lookup in the portal. It is also intentionally not
 * wired into `ordersRelations`: nothing should be able to pull it in with a
 * casual `with:`.
 *
 * History is kept (one row per registration, newest wins) so a re-registered
 * parcel does not erase the label the customer may already be holding.
 */
export const returnLabels = pgTable(
  "return_labels",
  {
    id: serial("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // The Correos CodEnvio this PDF is the label for. Not unique: a
    // re-registration is a different parcel and gets its own row.
    trackingNumber: text("tracking_number").notNull(),
    // Base64 as Correos hands it over, ready to attach to a Postmark message.
    pdfBase64: text("pdf_base64").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    orderIdx: index("return_labels_order_id_idx").on(table.orderId),
  })
);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  hashedPassword: text("hashed_password").notNull(),
});

/**
 * Return/exchange shipping fee per destination country and parcel weight.
 *
 * One row per (ISO-2 country, weight band), plus the same bands under
 * country_code = '*' that every unlisted or unrecognised country falls back
 * to. Amounts are integer cents — never floats, which is how you end up
 * charging 4.199999999.
 *
 * `max_grams` is the INCLUSIVE upper bound of the band. Bands for a country
 * must be contiguous from zero, and the heaviest one carries
 * UNBOUNDED_MAX_GRAMS so that no parcel can ever fall through unpriced —
 * a parcel with no matching band would otherwise resolve to a zero fee.
 *
 * Weight matters because the carrier prices by it, steeply: a 2.5kg return
 * from the US costs 86.97 EUR against 21.53 EUR for the same parcel under
 * 1kg. Before this column the whole table charged the sub-1kg price at every
 * weight, which was accurate for the ~86% of parcels under a kilo and badly
 * wrong for multi-garment baskets.
 */
export const shippingFees = pgTable(
  "shipping_fees",
  {
    countryCode: text("country_code").notNull(),
    maxGrams: integer("max_grams").notNull(),
    returnFeeCents: integer("return_fee_cents").notNull(),
    exchangeFeeCents: integer("exchange_fee_cents").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.countryCode, table.maxGrams] }),
  })
);

/**
 * Failed order-lookup attempts, for rate limiting.
 *
 * Only FAILURES are recorded — a wrong order number or a non-matching email.
 * A successful lookup writes nothing, so a customer who finds their order is
 * never penalised, and the count measures exactly the guessing behaviour we
 * care about.
 *
 * Rows are pruned opportunistically once they fall outside the window (see
 * db/lookupAttempts.ts), so the table stays bounded without a cron job.
 */
export const lookupAttempts = pgTable(
  "lookup_attempts",
  {
    id: serial("id").primaryKey(),
    ip: text("ip").notNull(),
    attemptedAt: timestamp("attempted_at").defaultNow().notNull(),
  },
  (table) => ({
    // The only query is "count rows for this ip since T", so index both.
    ipAttemptedAtIdx: index("lookup_attempts_ip_attempted_at_idx").on(
      table.ip,
      table.attemptedAt
    ),
  })
);

// APPLYING SCHEMA CHANGES — do NOT run `npx drizzle-kit push:pg`.
//
// There is no `drizzle/` directory and no committed migration history, so
// `push` has nothing to diff against except whatever production happens to be
// right now. This database also holds tables that are not modelled in this
// file, so `push` reads them as drift and proposes DROPs on live data.
//
// Write the DDL by hand instead. See the migration section of README.md for
// the statements applied so far and the pattern to follow.

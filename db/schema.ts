import { relations } from "drizzle-orm";
import { integer, text, pgTable, serial, boolean, timestamp } from "drizzle-orm/pg-core";

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

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  hashedPassword: text("hashed_password").notNull(),
});

/**
 * Return/exchange shipping fee per destination country.
 *
 * One row per ISO-2 country, plus a single row with country_code = '*' that
 * every unlisted or unrecognised country falls back to. Amounts are integer
 * cents — never floats, which is how you end up charging 4.199999999.
 */
export const shippingFees = pgTable("shipping_fees", {
  countryCode: text("country_code").primaryKey(),
  returnFeeCents: integer("return_fee_cents").notNull(),
  exchangeFeeCents: integer("exchange_fee_cents").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// CODE TO UPDATE TABLA SCHEMA  npx drizzle-kit push:pg

"use server";

import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { LOCALE_COOKIE, readLocale, type Locale } from "@/lib/i18n";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

/**
 * Persist the customer's language choice. The cookie drives what the portal
 * renders; the orders row drives which language the transactional email is
 * sent in, which is why it is written on every switch rather than only at
 * checkout — the customer may abandon and have the return created later.
 */
export async function setLocale(locale: Locale, orderId?: string) {
  const safe = readLocale(locale);

  cookies().set(LOCALE_COOKIE, safe, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  if (orderId) {
    await db.update(orders).set({ locale: safe }).where(eq(orders.id, orderId));
  }

  revalidatePath("/", "layout");
}

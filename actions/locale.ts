"use server";

import { LOCALE_COOKIE, readLocale, type Locale } from "@/lib/i18n";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

/**
 * Persist the customer's language choice as a cookie — the sole render
 * source for the portal. This does not touch `orders.locale`: that column
 * still exists and still drives which language the transactional email is
 * sent in, but it is written later, server-side, from the return-creation
 * path where the order id is already trusted and an email is about to be
 * sent — not from here, where the order id would be client-supplied and
 * unauthenticated.
 */
export async function setLocale(locale: Locale) {
  const safe = readLocale(locale);

  cookies().set(LOCALE_COOKIE, safe, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}

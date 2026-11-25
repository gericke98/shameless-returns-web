import "server-only";
// The language switch (F1 spec §4 `setLocale`), wrapped by `publicAction`.
//
// Persists the customer's choice as a cookie — the sole render source for the
// portal. It does not touch `orders.locale`: that column drives which
// language the transactional email is sent in, and is written by the submit
// path, where the order id is verified — not from here, where there is none.
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { LOCALE_COOKIE, LOCALES } from "@/lib/i18n";
import { ok, type HandlerResult } from "@/lib/actionResult";
import type { PublicContext } from "@/lib/server/actions";

export const setLocaleInput = z.object({ locale: z.enum(LOCALES as ["es", "en"]) }).strict();

export async function setLocaleHandler(
  _ctx: PublicContext,
  input: z.infer<typeof setLocaleInput>
): Promise<HandlerResult<{}, never>> {
  cookies().set(LOCALE_COOKIE, input.locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
  return ok({});
}

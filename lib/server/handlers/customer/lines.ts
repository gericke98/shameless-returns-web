import "server-only";
// The portal's per-line choice (F1 spec §3, §4 `setLineSelection` /
// `clearLineSelection`). Every write goes through `ctx.order`, whose WHERE
// carries the session's order id: a row id of another order matches nothing.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { REASON_KEYS } from "@/placeholder";
import type { HandlerResult } from "@/lib/actionResult";
import type { CustomerContext } from "@/lib/server/actions";

const rowId = z.number().int().positive();

export const setLineSelectionInput = z
  .object({
    expectedOrderId: z.string(),
    rowId,
    action: z.enum(["CAMBIO", "DEVOLUCIÓN"]),
    reason: z.enum(REASON_KEYS),
    notes: z.string().max(1000),
    newVariantId: z.string().min(1).max(200).optional(),
  })
  .strict()
  // An exchange names its replacement; a plain return names none.
  .refine((v) => (v.action === "CAMBIO") === (v.newVariantId !== undefined));

export const clearLineSelectionInput = z.object({ expectedOrderId: z.string(), rowId }).strict();

export async function setLineSelectionHandler(
  ctx: CustomerContext,
  input: Omit<z.infer<typeof setLineSelectionInput>, "expectedOrderId">
): Promise<
  HandlerResult<{}, "not-editable" | "variant-not-offered" | "replacement-unavailable" | "stock-unreadable">
> {
  const result = await ctx.order.setLineSelection(
    input.rowId,
    input.action === "CAMBIO"
      ? { action: "CAMBIO", reason: input.reason, notes: input.notes, newVariantId: input.newVariantId! }
      : { action: "DEVOLUCIÓN", reason: input.reason, notes: input.notes }
  );
  if (result.ok) revalidatePath("/", "layout");
  return result;
}

export async function clearLineSelectionHandler(
  ctx: CustomerContext,
  input: Omit<z.infer<typeof clearLineSelectionInput>, "expectedOrderId">
): Promise<HandlerResult<{}, "not-editable">> {
  const result = await ctx.order.clearLineSelection(input.rowId);
  if (result.ok) revalidatePath("/", "layout");
  return result;
}

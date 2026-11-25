import "server-only";
// The dashboard's settle button (F1 spec §4 `settleRow`). Wrapped by
// `adminAction`, IN ADDITION to the settlement ledger's own ownership, never
// instead of it (S2 plan L7). Only the clicked row's id is read; what is paid
// is the submission that row belongs to, executed by lib/settlement/. One
// click admits that row, plus the whole exchange when it is one (one parcel,
// one replacement order).
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import db from "@/db/drizzle";
import { productsOrder } from "@/db/schema";
import { adminTarget } from "@/lib/server/identity";
import { submissionForRow } from "@/lib/settlement/legacy";
import { settleSubmission } from "@/lib/settlement/settle";
import { ok, refuse, type HandlerResult } from "@/lib/actionResult";
import type { AdminContext } from "@/lib/server/actions";

/** Leave the request room to answer; recovery finishes anything admitted. */
const BUDGET_MS = 45_000;

export const settleRowInput = z.object({ rowId: z.number().int().positive() }).strict();

export async function settleRowHandler(
  ctx: AdminContext,
  input: z.infer<typeof settleRowInput>
): Promise<HandlerResult<{ lines: { rowId: number; status: string }[] }, "not-settleable">> {
  // The admin's credential covers any order; the target is the order the
  // clicked row belongs to, read from our own database.
  const [row] = await db
    .select({ orderId: productsOrder.orderId })
    .from(productsOrder)
    .where(eq(productsOrder.id, input.rowId));
  if (!row?.orderId) {
    console.error(`settleRow: row ${input.rowId} not settled — no such line`);
    return refuse("not-settleable");
  }
  const found = await submissionForRow(adminTarget(String(row.orderId), ctx), input.rowId);
  if (!found.ok) {
    console.error(`settleRow: row ${input.rowId} not settled — held:${found.held}`);
    return refuse("not-settleable");
  }
  const report = await settleSubmission(found.submissionId, [input.rowId], {
    deadline: Date.now() + BUDGET_MS,
  });
  console.log(
    `settleRow: submission ${found.submissionId}: ` +
      report.lines.map((l) => `row ${l.productsorderId} ${l.status}`).join(", ")
  );
  revalidatePath("/", "layout");
  return ok({ lines: report.lines.map((l) => ({ rowId: l.productsorderId, status: String(l.status) })) });
}

"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/requireAdmin";
import { submissionForRow } from "@/lib/settlement/legacy";
import { settleSubmission } from "@/lib/settlement/settle";

/** Leave the request room to answer; recovery finishes anything admitted. */
const BUDGET_MS = 45_000;

/**
 * The dashboard's settle button.
 *
 * A server action is a public endpoint whatever renders it, so the admin check
 * stays — IN ADDITION to the settlement ledger's own ownership, never instead
 * of it (S2 plan L7). The caller's objects decide nothing: only the clicked
 * row's id is read, and what is paid is the submission that row belongs to,
 * executed by lib/settlement/. One click admits that row, plus the whole
 * exchange when it is one (one parcel, one replacement order).
 *
 * `status` and `order` are unused and kept only because ReturnsTable passes them.
 */
export async function validateReturn(product: any, status: string, order: any) {
  "use server";

  if (!(await isAdmin())) {
    console.error("validateReturn: rejected a call without an admin session");
    return;
  }

  const rowId = Number(product?.id);
  if (!Number.isInteger(rowId) || rowId <= 0) return;

  const found = await submissionForRow(rowId);
  if (!found.ok) {
    console.error(`validateReturn: row ${rowId} not settled — held:${found.held}`);
    return;
  }
  const report = await settleSubmission(found.submissionId, [rowId], {
    deadline: Date.now() + BUDGET_MS,
  });
  console.log(
    `validateReturn: submission ${found.submissionId}: ` +
      report.lines.map((l) => `row ${l.productsorderId} ${l.status}`).join(", ")
  );
  revalidatePath("/", "layout");
}

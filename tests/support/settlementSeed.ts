// Seeds an accepted submission, its lines and their productsorder rows into a
// settlement test database, and builds an admission plan for it with uuid op
// ids — the same rows production would hold after S1 confirmation.
import { randomUUID } from "node:crypto";
import { planAdmission, type PlanInput } from "@/lib/settlement/plan";
import type { SubmissionLineRow } from "@/lib/settlement/ledger";
import { line, planInput, submission as submissionFixture } from "./planFixtures";

type Exec = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params?: any[]) => Promise<any> };

export async function seedSubmission(
  pg: Exec,
  opts: {
    orderId?: string;
    lines?: SubmissionLineRow[];
    tender?: "refund" | "credit";
    residualCents?: number;
  } = {}
) {
  const orderId = opts.orderId ?? "100";
  const lines = opts.lines ?? [line(1)];
  const id = randomUUID();
  await pg.query(`INSERT INTO orders (id, order_number) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
    orderId,
    `#${orderId}`,
  ]);
  for (const l of lines) {
    await pg.query(
      `INSERT INTO productsorder (id, order_id, line_item, product_id, title, variant_title, variant_id,
         price, quantity, changed, action, confirmed, return_id, return_line_item_id, transaction_id,
         new_variant_id)
       VALUES ($1, $2, 'li', 'p', 't', 'M', 'v', '50.00', $3, false, $4, true, 'gid://shopify/Return/1', $5,
               'gid://shopify/OrderTransaction/7', $6)
       ON CONFLICT (id) DO NOTHING`,
      [l.productsorderId, orderId, l.quantity, l.action, l.returnLineItemId, l.newVariantId]
    );
  }
  const owed = lines.reduce((s, l) => s + l.payCents, 0) + (opts.residualCents ?? 0);
  await pg.query(
    `INSERT INTO return_submissions (id, order_id, state, tender, return_method, return_leg_cents,
       outbound_leg_cents, charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
       stripe_charge_cents, waived_cents, owed_cents, residual_cents, accepted_at)
     VALUES ($1, $2, 'accepted', $3, 'CORREOS', 0, 0, 0, $4, 0, $4, 0, 0, $4, $5, now())`,
    [id, orderId, opts.tender ?? "refund", owed, opts.residualCents ?? 0]
  );
  for (const l of lines) {
    await pg.query(
      `INSERT INTO submission_lines (submission_id, productsorder_id, shopify_line_item_id, quantity,
         action, new_variant_id, returned_cents, replacement_cents, pay_cents, stripe_funded_cents,
         fulfillment_line_item_id, return_line_item_id)
       VALUES ($1, $2, $11, $3, $4, $5, $6, 0, $7, $8, $9, $10)`,
      [id, l.productsorderId, l.quantity, l.action, l.newVariantId, l.returnedCents, l.payCents,
       l.stripeFundedCents, l.fulfillmentLineItemId, l.returnLineItemId, l.shopifyLineItemId]
    );
  }
  return { id, orderId, lines, tender: opts.tender ?? "refund", residualCents: opts.residualCents ?? 0 };
}

/** The plan production would admit for a seeded submission, with uuid op ids. */
export function planFor(
  seeded: {
    id: string;
    orderId: string;
    lines: SubmissionLineRow[];
    tender: "refund" | "credit";
    residualCents: number;
  },
  over: Partial<PlanInput> = {}
) {
  const { submission, ...rest } = over;
  const plan = planAdmission(
    planInput(seeded.lines, {
      submission: submissionFixture({
        id: seeded.id,
        orderId: seeded.orderId,
        tender: seeded.tender,
        residualCents: seeded.residualCents,
        ...(submission ?? {}),
      }),
      order: { ...planInput([]).order, id: seeded.orderId },
      newId: () => randomUUID(),
      ...rest,
    })
  );
  if (!plan.ok) throw new Error(plan.held);
  return plan;
}

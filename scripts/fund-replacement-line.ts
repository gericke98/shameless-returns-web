/**
 * S3, Santi 30 Oct (A) — record ONE legacy exchange line's Stripe funding,
 * when the portal refused a return on its replacement order for lack of it
 * (the alert names this script and the order/line). Reads the Stripe session
 * and the Shopify order — read-only — and refuses unless the session is paid,
 * pre-S1, names the source order, and has that many cents left; then writes
 * the decision (who, why) and the replacement_lines row in one statement
 * (lib/settlement/replacementFunding.ts). Dry-run by default.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/fund-replacement-line.ts \
 *     --order <replacement order id> --line <source productsorder id> \
 *     --session <cs_…> --cents <funded cents> --evidence "<why>" [--by <name>] [--write]
 */
import "dotenv/config";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      order: { type: "string" },
      line: { type: "string" },
      session: { type: "string" },
      cents: { type: "string" },
      evidence: { type: "string" },
      by: { type: "string" },
      write: { type: "boolean", default: false },
    },
  });
  const { fundReplacementLine } = await import("@/lib/settlement/replacementFunding");
  const { stripe } = await import("@/lib/stripe");
  const readSession = async (id: string) => {
    try {
      const s = await stripe.checkout.sessions.retrieve(id);
      return {
        ok: true as const,
        session: { id: s.id, payment_status: s.payment_status ?? null, amount_total: s.amount_total ?? null, metadata: (s.metadata ?? null) as any },
      };
    } catch (e: any) {
      return e?.statusCode === 404 ? { ok: true as const, session: null } : { ok: false as const, error: String(e?.message ?? e) };
    }
  };
  const out = await fundReplacementLine(
    {
      orderId: String(values.order ?? ""),
      productsorderId: Number(values.line),
      stripeSessionId: String(values.session ?? ""),
      fundedCents: Number(values.cents),
      by: values.by ?? userInfo().username,
      evidence: values.evidence ?? "",
    },
    readSession,
    { write: !!values.write }
  );
  if (!out.ok) {
    console.log(`NOT recorded: ${out.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(out.summary);
  if (!out.written) console.log("DRY: nothing recorded. Pass --write.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

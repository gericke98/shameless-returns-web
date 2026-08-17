/**
 * Send a customer their existing return label again, from the terminal.
 *
 *   npx tsx scripts/resend-return-label.ts '#311199'
 *   npx tsx scripts/resend-return-label.ts '#311199' --dry-run
 *
 * Uses the PDF we stored when the parcel was registered, so it costs nothing:
 * no new Correos shipment, no second charge, and the customer keeps the
 * tracking number the warehouse is already expecting.
 *
 * Before label storage existed (anything registered before 2026-08-17) there is
 * no PDF to send and this reports so rather than quietly registering a new
 * parcel. Correos cannot re-issue one — see docs/. Registering a replacement is
 * a real, uncancellable shipment and has to be a deliberate decision, which is
 * why this script will not make it for you.
 *
 * Reads production credentials from .env. It emails a real customer.
 */
import { config } from "dotenv";
config({ path: ".env" });

import { neon } from "@neondatabase/serverless";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const orderNumbers = args.filter((a) => !a.startsWith("--"));

  if (orderNumbers.length === 0) {
    console.error(
      "Usage: npx tsx scripts/resend-return-label.ts '#311199' [more…] [--dry-run]"
    );
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL!, {
    fetchOptions: { cache: "no-store" },
  });

  for (const orderNumber of orderNumbers) {
    const rows: any = await sql`
      select id, order_number, email, locator from orders where order_number = ${orderNumber}`;
    if (rows.length === 0) {
      console.error(`${orderNumber}: no such order`);
      continue;
    }
    const order = rows[0];

    const labels: any = await sql`
      select tracking_number, created_at, length(pdf_base64) as bytes
      from return_labels where order_id = ${order.id}
      order by created_at desc, id desc`;

    if (labels.length === 0) {
      console.error(
        `${orderNumber}: no stored label — registered before label storage, or Correos sent no PDF. ` +
          `Re-sending would mean registering a NEW parcel; do that deliberately, not from here.`
      );
      continue;
    }

    const latest = labels[0];
    console.log(
      `${orderNumber} -> ${order.email}\n` +
        `  label ${latest.tracking_number} (${latest.bytes} b64 chars, stored ${latest.created_at})` +
        (labels.length > 1 ? `\n  ${labels.length - 1} older label(s) on file; newest is sent` : "") +
        (latest.tracking_number !== order.locator
          ? `\n  ⚠️  order.locator is ${order.locator} — the stored label is a DIFFERENT parcel`
          : "")
    );

    if (dryRun) {
      console.log("  --dry-run: nothing sent\n");
      continue;
    }

    const { resendReturnLabel } = await import("../actions/shipping");
    const status = await resendReturnLabel(order.id);
    console.log(status === 200 ? "  ✅ sent\n" : `  ❌ failed (${status})\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Record where every live parcel currently is, WITHOUT emailing anyone.
 *
 * Run once, before the tracking-sync cron is enabled. Without it the first run
 * sees ~82 parcels with no recorded state and treats each one's current
 * position as fresh news — telling customers their parcel was accepted by the
 * carrier three weeks ago.
 *
 * Dry by default; pass APPLY=1 to write.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders as ordersTable } from "@/db/schema";
import { getParcelsAwaitingTracking } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import { keyForPhase } from "@/lib/trackingUpdate";
import { isInternationalOrder } from "@/lib/countries";

const APPLY = process.env.APPLY === "1";

(async () => {
  const parcels = await getParcelsAwaitingTracking();
  let seeded = 0;
  let noNews = 0;

  for (const order of parcels as any[]) {
    if (isInternationalOrder(order.shippingCountry)) continue;
    if (order.lastTrackingKey) continue;

    const status = await obtainLastStatus(order.locator);
    const key = keyForPhase(status.phase);
    if (!key) {
      // Correos has nothing on it. Leave the state null so the first real
      // movement is treated as news, which it will be.
      noNews += 1;
      continue;
    }

    console.log(`${order.orderNumber}  ${order.locator}  ${status.label} -> ${key}`);
    seeded += 1;
    if (!APPLY) continue;

    await db
      .update(ordersTable)
      .set({ lastTrackingKey: key, lastTrackingLocator: order.locator })
      .where(eq(ordersTable.id, order.id));
  }

  console.log(`\nwould seed: ${seeded}   no news from Correos: ${noNews}`);
  if (!APPLY) console.log("DRY RUN — nothing written. APPLY=1 to write.");
})().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exit(1);
});

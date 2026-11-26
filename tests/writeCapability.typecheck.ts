// Rule 6 is a TYPE (F1 spec §11). Each line marked @ts-expect-error must stay
// a compile error: if a change lets it compile, `tsc` reports the directive as
// unused, and so does tests/actionBoundary.test.ts (rule 6), which reads this
// file's diagnostics. Never imported or run; only type-checked.
import { sql } from "drizzle-orm";
import db, { lookupAttemptsWriter, opsAlertsWriter, writeDb } from "@/db/drizzle";
// @ts-expect-error `transact` is no longer exported: it comes with a capability.
import { transact as noTransact } from "@/db/drizzle";
import { orders } from "@/db/schema";
import type { AdminContext } from "@/lib/server/actions";
import { saveShippingFeeHandler } from "@/lib/server/handlers/admin/saveShippingFee";
import type { AdminTarget, SystemTarget, VerifiedOrderId, VerifiedSubmission } from "@/lib/server/identity";

declare const order: VerifiedOrderId;
declare const submission: VerifiedSubmission;
declare const admin: AdminTarget;
declare const job: SystemTarget;
declare const raw: string;

export function readHandleCannotWrite() {
  // @ts-expect-error the read handle has no insert
  db.insert(orders);
  // @ts-expect-error the read handle has no update
  db.update(orders);
  // @ts-expect-error the read handle has no delete
  db.delete(orders);
  // @ts-expect-error the read handle has no execute (raw reads use readQuery)
  db.execute(sql`SELECT 1`);
  // @ts-expect-error the read handle has no transaction
  db.transaction(async () => undefined);
  // @ts-expect-error the read handle has no with(...): its builder can write
  db.with();
  void noTransact;
}

export function writeHandleNeedsACapability() {
  // @ts-expect-error a client string is not a capability
  writeDb(raw);
  // @ts-expect-error a literal id is not a capability
  writeDb("13217168851270");
  // @ts-expect-error a number is not a capability
  writeDb(123);
  // @ts-expect-error an object shaped like a capability is not one (the brand is nominal)
  writeDb({ job: "forged" });
  // @ts-expect-error nothing at all
  writeDb();
}

export function capabilitiesDoWrite() {
  writeDb(order).update(orders);
  writeDb(submission).transact([]);
  writeDb(admin).insert(orders);
  writeDb(job).execute(sql`SELECT 1`);
  opsAlertsWriter.insert();
  opsAlertsWriter.update().set({ lastError: null });
  lookupAttemptsWriter.insert();
  lookupAttemptsWriter.delete();
  db.select().from(orders);
}

// Codex #2: each table-bound writer reaches its own table and nothing else.
export function tableBoundWritersCannotReachOrders() {
  // @ts-expect-error ops_alerts' writer cannot insert into orders
  opsAlertsWriter.insert(orders);
  // @ts-expect-error ops_alerts' writer cannot update orders
  opsAlertsWriter.update(orders);
  // @ts-expect-error ops_alerts' writer cannot delete from orders
  opsAlertsWriter.delete(orders);
  // @ts-expect-error not an orders column
  opsAlertsWriter.update().set({ locator: "X" });
  // @ts-expect-error no raw execute
  opsAlertsWriter.execute(sql`DELETE FROM orders`);
  // @ts-expect-error no transaction or session
  opsAlertsWriter.transaction(async () => undefined);
  // @ts-expect-error lookup_attempts' writer cannot insert into orders
  lookupAttemptsWriter.insert(orders);
  // @ts-expect-error lookup_attempts' writer cannot update orders
  lookupAttemptsWriter.update(orders);
  // @ts-expect-error lookup_attempts' writer cannot delete from orders
  lookupAttemptsWriter.delete(orders);
  // @ts-expect-error no raw execute
  lookupAttemptsWriter.execute(sql`DELETE FROM orders`);
}

// Codex #4: an admin handler holds the capability adminAction minted; a
// context a caller builds itself is not one.
declare const adminCtx: AdminContext;
const feeInput = { country: "ES", band: 1000, returnFee: "0", exchangeFee: "0" };
export function adminHandlersNeedTheFactorysCapability() {
  // @ts-expect-error a fabricated { admin } object is not an admin context
  saveShippingFeeHandler({ admin: "x" }, feeInput);
  // @ts-expect-error nor is one shaped like the capability (the brand is nominal)
  saveShippingFeeHandler({ target: { admin: "x" }, order: (id: string) => adminCtx.order(id) }, feeInput);
  saveShippingFeeHandler(adminCtx, feeInput);
}

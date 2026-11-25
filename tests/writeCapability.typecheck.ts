// Rule 6 is a TYPE (F1 spec §11). Each line marked @ts-expect-error must stay
// a compile error: if a change lets it compile, `tsc` reports the directive as
// unused, and so does tests/actionBoundary.test.ts (rule 6), which reads this
// file's diagnostics. Never imported or run; only type-checked.
import { sql } from "drizzle-orm";
import db, { tableWriter, writeDb } from "@/db/drizzle";
// @ts-expect-error `transact` is no longer exported: it comes with a capability.
import { transact as noTransact } from "@/db/drizzle";
import { orders } from "@/db/schema";
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
  // @ts-expect-error tableWriter serves only the two non-customer tables
  tableWriter("orders");
}

export function capabilitiesDoWrite() {
  writeDb(order).update(orders);
  writeDb(submission).transact([]);
  writeDb(admin).insert(orders);
  writeDb(job).execute(sql`SELECT 1`);
  tableWriter("ops_alerts");
  tableWriter("lookup_attempts");
  db.select().from(orders);
}

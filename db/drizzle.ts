import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { SQL } from "drizzle-orm";
import { transactionsOver, type RunTransaction } from "./transactions";
import type { WriteCapability } from "@/lib/server/identity";

import * as schema from "./schema";

// Connect drizzle to the neon db.
//
// `cache: "no-store"` is load-bearing. The Neon serverless driver speaks HTTP
// over `fetch`, and Next.js replaces global fetch with one that caches. Every
// query this app runs is the same POST to the same URL, so identical SELECTs
// were served from the Data Cache and the app read a frozen snapshot of the
// database.
//
// It surfaced in `/api/cron/amphora-sync`, which is the only caller that reads
// repeatedly over a long life and acts on what it reads:
//
//   [amphora-sync][diag] #310905: read returnStatus=null
//     locator="1Z3EF3229113605089" vs amphora="TRAVELLING"
//
// `locator` was written when the return was created, before that query was
// first cached; `returnStatus` was written afterwards and never appeared. The
// same query from a local process returned TRAVELLING throughout. So the poller
// decided the status had changed on every single run, and `returnReceived` —
// guarded by nothing but that comparison — would have emailed the customer
// every fifteen minutes once a return reached RECEIVED.
const sql = neon(process.env.DATABASE_URL!, {
  fetchOptions: { cache: "no-store" },
});
const full = drizzle(sql, { schema });

/**
 * What a handle may do without a capability: read. An ALLOW-list of the
 * drizzle members that cannot write (F1 spec §11). Not `with(...)` (its
 * builder has update/insert/delete), not `execute`, `transaction`, `batch`,
 * `$client` or `_` (the session): each can run arbitrary SQL.
 */
export type ReadDb = Pick<typeof full, "select" | "selectDistinct" | "selectDistinctOn" | "query" | "$with">;

/**
 * The default export: a read handle, at runtime as well as in its type (only
 * the allowed members exist on it, so a cast cannot reach a writer). Raw reads
 * go through `readQuery`. Writes go through `writeDb(capability)`.
 */
const db: ReadDb = {
  select: full.select.bind(full),
  selectDistinct: full.selectDistinct.bind(full),
  selectDistinctOn: full.selectDistinctOn.bind(full),
  $with: full.$with.bind(full),
  query: full.query,
} as ReadDb;

export default db;

/**
 * Neon's driver-level transaction: its non-interactive `sql.transaction`,
 * which Neon's HTTP endpoint runs server-side as BEGIN (in `mode`) … COMMIT.
 * The only piece of `transact` / `readQuery` that tests substitute.
 */
const neonTransaction: RunTransaction = async (statements, mode) => {
  const results: any[] = await sql.transaction(
    statements.map((s) => sql(s.sql, s.params)),
    { fullResults: true, isolationLevel: mode.isolationLevel, readOnly: mode.readOnly }
  );
  return results.map((result) => result?.rows ?? []);
};

const transactions = transactionsOver(neonTransaction);

/**
 * A handle that can write: the full drizzle handle, plus `transact`, which
 * runs `statements` as ONE non-interactive Postgres transaction and returns
 * each statement's rows.
 *
 * neon-http cannot hold a transaction open across round trips, so there is no
 * interactive `db.transaction(async tx => …)` here, ever. What it can do is
 * send a fixed list of statements that commit or roll back together, under
 * READ COMMITTED: every statement takes a FRESH snapshot when it starts. That
 * is what the settlement ledger relies on — a first `SELECT … FOR UPDATE`
 * serialises callers on one row, and every later statement then sees whatever
 * the previous lock holder committed (docs/superpowers/specs/
 * 2026-10-30-settlement-S2-ledger-plan.md, L4).
 */
export type WriteDb = typeof full & { transact(statements: SQL[]): Promise<any[][]> };

const writable: WriteDb = Object.assign(full, {
  transact: (statements: SQL[]) => transactions.transact(statements),
});

/**
 * The write handle, for the holder of a capability (F1 spec §11): a verified
 * order or submission, an admin session, a system job, or a lookup. Without
 * one there is no way to name a writer: that is a type error, not a review
 * finding.
 */
export function writeDb(capability: WriteCapability): WriteDb {
  void capability;
  return writable;
}

/**
 * Writes bound to ONE table, for the two tables that hold no customer data
 * (F1 spec §11 threat model, Codex #2). Each operation takes no table: it is
 * fixed here, so `update().set(...)` only accepts that table's columns, and
 * there is no execute, transaction or session to reach anything else.
 * (Deliberately hostile code in the process is F2's: Postgres roles.)
 */
function boundTo<T extends typeof schema.opsAlerts | typeof schema.lookupAttempts>(table: T) {
  return Object.freeze({
    insert: () => full.insert(table),
    update: () => full.update(table),
    delete: () => full.delete(table),
  });
}

/** ops_alerts' writer. Referenced only from db/opsAlerts.ts (tests/actionBoundary.test.ts). */
export const opsAlertsWriter = boundTo(schema.opsAlerts);

/** lookup_attempts' writer. Referenced only from db/lookupAttempts.ts (tests/actionBoundary.test.ts). */
export const lookupAttemptsWriter = boundTo(schema.lookupAttempts);

/**
 * Run ONE raw statement inside a Postgres `READ ONLY` transaction (the Neon
 * driver's own `transaction([...], { readOnly: true })`) and return
 * `{ rows }`, the shape `db.execute` callers read with `rowsOf`.
 *
 * For raw SQL that only reads but is shared with paths that cannot take an
 * order capability (settlement admission, admin approvals). The database, not
 * the caller, guarantees it reads: any write inside is refused by Postgres
 * ("cannot execute … in a read-only transaction"). The boundary test (rule 6,
 * F1 spec §10) therefore counts a call through `readQuery` as a read.
 * Built by db/transactions.ts, the same code the Postgres tests run.
 */
export async function readQuery(statement: SQL): Promise<{ rows: any[] }> {
  return transactions.readQuery(statement);
}

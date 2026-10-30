import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

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
const db = drizzle(sql, { schema });

export default db;

const dialect = new PgDialect();

/**
 * Run `statements` as ONE non-interactive Postgres transaction and return each
 * statement's rows.
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
export async function transact(statements: SQL[]): Promise<any[][]> {
  const queries = statements.map((statement) => {
    const query = dialect.sqlToQuery(statement);
    return sql(query.sql, query.params);
  });
  const results: any[] = await sql.transaction(queries, {
    fullResults: true,
    isolationLevel: "ReadCommitted",
  });
  return results.map((result) => result?.rows ?? []);
}

// An in-process Postgres (PGlite) carrying the REAL settlement migrations, for
// tests that must run the ledger's SQL rather than a mock of it.
//
// `orders` and `productsorder` predate the hand-written migrations, so their
// columns are generated from db/schema.ts (names and types only — no FKs, no
// defaults beyond the primary key). Everything settlement owns comes from the
// migration files themselves: 0004 (ops_alerts), 0006, 0007, 0008.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { transactionsOver, type RunTransaction } from "@/db/transactions";
import * as schema from "@/db/schema";

function createTableFromSchema(table: PgTable): string {
  const config = getTableConfig(table);
  const columns = config.columns.map((c) => {
    const type = c.getSQLType() === "serial" ? "serial" : c.getSQLType();
    return `"${c.name}" ${type}${c.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE IF NOT EXISTS "${config.name}" (${columns.join(", ")})`;
}

export const MIGRATIONS = [
  "drizzle/0004_ops_alerts.sql",
  "drizzle/0006_return_submissions.sql",
  "drizzle/0007_settlement_operations.sql",
  "drizzle/0008_settlement_lease_generation.sql",
  "drizzle/0009_settlement_reconciliation.sql",
  "drizzle/0010_settlement_approvals.sql",
  "drizzle/0011_reconciliation_identity.sql",
  "drizzle/0012_reconciliation_void.sql",
];

/**
 * Synchronous so a `vi.mock` factory can close over it; await `ready` (in a
 * `beforeAll`) before the first query.
 */
export function settlementDatabase() {
  const pg = new PGlite();
  const ready = (async () => {
    await pg.exec(createTableFromSchema(schema.orders));
    await pg.exec(createTableFromSchema(schema.productsOrder));
    // Production keeps `gift_card_id` for history; db/schema.ts no longer
    // models it (S3 R4), and only the reconciliation reads it, by name.
    await pg.exec(`ALTER TABLE "productsorder" ADD COLUMN IF NOT EXISTS "gift_card_id" text`);
    for (const file of MIGRATIONS) await pg.exec(readFileSync(file, "utf8"));
  })();
  const db = drizzle(pg, { schema });

  /**
   * The driver-level transaction on PGlite: one transaction in the mode asked
   * for. Everything above the driver is production's own (db/transactions.ts).
   */
  const pgliteTransaction: RunTransaction = async (statements, mode) => {
    if (mode.isolationLevel !== "ReadCommitted") throw new Error(`unsupported isolation ${mode.isolationLevel}`);
    const result = await pg.transaction(async (tx) => {
      await tx.exec(`SET TRANSACTION ISOLATION LEVEL READ COMMITTED${mode.readOnly ? " READ ONLY" : ""}`);
      const out: any[][] = [];
      for (const s of statements) out.push((await tx.query<any>(s.sql, s.params as any[])).rows);
      return out;
    });
    return result ?? [];
  };
  const { transact, readQuery } = transactionsOver(pgliteTransaction);

  async function reset() {
    await pg.exec(`
      DELETE FROM line_action_decisions; DELETE FROM settlement_approvals;
      DELETE FROM reconciliation_effect_decisions; DELETE FROM legacy_replacement_orders;
      DELETE FROM legacy_replacement_census; DELETE FROM replacement_funding_decisions; DELETE FROM reconciliation_voids;
      DELETE FROM replacement_lines; DELETE FROM settlement_operations;
      DELETE FROM submission_lines; DELETE FROM return_submissions;
      DELETE FROM ops_alerts; DELETE FROM productsorder; DELETE FROM orders;`);
  }

  return { pg, db, transact, readQuery, reset, ready };
}

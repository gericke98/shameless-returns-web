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
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as schema from "@/db/schema";

const dialect = new PgDialect();

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
    for (const file of MIGRATIONS) await pg.exec(readFileSync(file, "utf8"));
  })();
  const db = drizzle(pg, { schema });

  /** db/drizzle.ts `transact`, on PGlite: one transaction, rows per statement. */
  async function transact(statements: SQL[]): Promise<any[][]> {
    const result = await pg.transaction(async (tx) => {
      const out: any[][] = [];
      for (const statement of statements) {
        const q = dialect.sqlToQuery(statement);
        out.push((await tx.query<any>(q.sql, q.params as any[])).rows);
      }
      return out;
    });
    return result ?? [];
  }

  async function reset() {
    await pg.exec(`
      DELETE FROM replacement_lines; DELETE FROM settlement_operations;
      DELETE FROM submission_lines; DELETE FROM return_submissions;
      DELETE FROM ops_alerts; DELETE FROM productsorder; DELETE FROM orders;`);
  }

  return { pg, db, transact, reset, ready };
}

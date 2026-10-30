// A throwaway, local, real PostgreSQL 16 for the settlement concurrency tests:
// a fresh cluster in a temp dir, TCP on 127.0.0.1 only, destroyed afterwards.
// PGlite is a single connection, so races between two connections can only be
// tested here. Skips (and says so) when no PostgreSQL 16 is installed.
//
// It NEVER reads DATABASE_URL: it only ever connects to the cluster it made.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as schema from "@/db/schema";
import { MIGRATIONS } from "./settlementDb";

const BIN = process.env.PG16_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
export const pg16Available = existsSync(join(BIN, "pg_ctl")) && existsSync(join(BIN, "initdb"));

function createTableFromSchema(table: PgTable): string {
  const config = getTableConfig(table);
  const columns = config.columns.map((c) => `"${c.name}" ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}`);
  return `CREATE TABLE IF NOT EXISTS "${config.name}" (${columns.join(", ")})`;
}

export async function startPg16() {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const dir = mkdtempSync(join(tmpdir(), "s2pg-"));
  const port = 56000 + Math.floor(Math.random() * 3000);
  execFileSync(join(BIN, "initdb"), ["-D", dir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
  execFileSync(
    join(BIN, "pg_ctl"),
    ["-D", dir, "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "-l", join(dir, "log"), "-w", "start"],
    { stdio: "ignore" }
  );
  const pool = new Pool({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 20 });
  await pool.query(createTableFromSchema(schema.orders));
  await pool.query(createTableFromSchema(schema.productsOrder));
  for (const file of MIGRATIONS) await pool.query(readFileSync(file, "utf8"));
  const db = drizzle(pool, { schema });
  const dialect = new PgDialect();

  /** db/drizzle.ts `transact` on a real connection: BEGIN READ COMMITTED … COMMIT. */
  async function transact(statements: SQL[]): Promise<any[][]> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const out: any[][] = [];
      for (const statement of statements) {
        const q = dialect.sqlToQuery(statement);
        out.push((await client.query(q.sql, q.params as any[])).rows);
      }
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function stop() {
    await pool.end();
    try {
      execFileSync(join(BIN, "pg_ctl"), ["-D", dir, "-m", "immediate", "stop"], { stdio: "ignore" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function reset() {
    await pool.query(`
      DELETE FROM replacement_lines; DELETE FROM settlement_operations;
      DELETE FROM submission_lines; DELETE FROM return_submissions;
      DELETE FROM ops_alerts; DELETE FROM productsorder; DELETE FROM orders;`);
  }

  return { pool, db, transact, stop, reset };
}

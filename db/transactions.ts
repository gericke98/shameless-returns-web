import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/** One compiled statement, as every Postgres driver takes it. */
export type Statement = { sql: string; params: unknown[] };

/**
 * How a transaction runs. Isolation is always READ COMMITTED: every statement
 * takes a fresh snapshot, which the ledger's lock-then-read pattern relies on
 * (settlement S2 plan, L4). `readOnly` makes Postgres itself refuse any write.
 */
export type TransactionMode = { isolationLevel: "ReadCommitted"; readOnly: boolean };

/**
 * The ONE thing a driver supplies: run `statements` as a single
 * non-interactive transaction in `mode`, commit or roll back together, and
 * return each statement's rows. Production is Neon's `sql.transaction`
 * (db/drizzle.ts); tests supply a real Postgres connection's BEGIN … COMMIT.
 */
export type RunTransaction = (statements: Statement[], mode: TransactionMode) => Promise<any[][]>;

/**
 * `transact` and `readQuery` over a driver. Everything but the driver call is
 * here, so the code a test runs against a real Postgres is the code
 * production runs against Neon: compilation, the mode each asks for, and the
 * shape each returns.
 */
export function transactionsOver(run: RunTransaction) {
  const dialect = new PgDialect();
  const compile = (statement: SQL): Statement => {
    const query = dialect.sqlToQuery(statement);
    return { sql: query.sql, params: query.params };
  };
  return {
    /** Statements as ONE READ COMMITTED transaction; each statement's rows. */
    transact: (statements: SQL[]): Promise<any[][]> =>
      run(statements.map(compile), { isolationLevel: "ReadCommitted", readOnly: false }),
    /** ONE statement in a READ ONLY transaction; `{ rows }`, as `db.execute` callers read it. */
    readQuery: async (statement: SQL): Promise<{ rows: any[] }> => {
      const [rows] = await run([compile(statement)], { isolationLevel: "ReadCommitted", readOnly: true });
      return { rows: rows ?? [] };
    },
  };
}

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { pg16Available, startPg16 } from "./support/pg16";

// db/drizzle.ts `readQuery` (F1 spec §10): raw read-only SQL runs in a
// Postgres READ ONLY transaction, so the DATABASE refuses a write in it.
//
// Everything below runs production's own `readQuery` from @/db/drizzle:
// db/transactions.ts and db/drizzle.ts's `neonTransaction` included. The one
// thing substituted is the Neon driver module: `sql.transaction(queries,
// opts)` is answered by a real PostgreSQL 16 connection that opens the
// transaction `opts` asks for (BEGIN ISOLATION LEVEL READ COMMITTED
// [READ ONLY]), as Neon's HTTP endpoint does server-side. Not exercised: the
// HTTP transport and Neon's own translation of `readOnly` into BEGIN.

let env: Awaited<ReturnType<typeof startPg16>> | undefined;
const seen: Array<{ queries: Array<{ text: string; params: unknown[] }>; opts: any }> = [];

vi.mock("@neondatabase/serverless", () => {
  const sqlFn: any = (text: string, params: unknown[]) => ({ text, params });
  sqlFn.transaction = async (queries: Array<{ text: string; params: unknown[] }>, opts: any) => {
    seen.push({ queries, opts });
    if (!env) return queries.map(() => ({ rows: [{ submission_id: "s1" }] }));
    if (opts?.isolationLevel !== "ReadCommitted" || opts?.fullResults !== true) {
      throw new Error(`the stand-in only speaks what production asks for, got ${JSON.stringify(opts)}`);
    }
    const client = await env.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL READ COMMITTED${opts.readOnly === true ? " READ ONLY" : ""}`);
      const out = [];
      for (const q of queries) out.push(await client.query(q.text, q.params as any[]));
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  return { neon: () => sqlFn };
});
process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@db.invalid/none";

beforeEach(() => {
  seen.length = 0;
});

describe("readQuery asks the Neon driver for a READ ONLY transaction", () => {
  it("passes readOnly to sql.transaction and returns { rows } as db.execute callers read it", async () => {
    const { readQuery } = await import("@/db/drizzle");
    const saved = env;
    env = undefined;
    try {
      expect(await readQuery(sql`SELECT ${1}::int AS one`)).toEqual({ rows: [{ submission_id: "s1" }] });
    } finally {
      env = saved;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].opts).toEqual({ fullResults: true, isolationLevel: "ReadCommitted", readOnly: true });
    expect(seen[0].queries).toEqual([{ text: "SELECT $1::int AS one", params: [1] }]);
  });

  it("transact asks for a writable READ COMMITTED transaction", async () => {
    const { transact } = await import("@/db/drizzle");
    const saved = env;
    env = undefined;
    try {
      await transact([sql`SELECT 1`]);
    } finally {
      env = saved;
    }
    expect(seen[0].opts).toEqual({ fullResults: true, isolationLevel: "ReadCommitted", readOnly: false });
  });
});

describe.skipIf(!pg16Available)("production readQuery on PostgreSQL 16", () => {
  beforeAll(async () => {
    env = await startPg16();
  }, 60_000);
  afterAll(async () => {
    await env?.stop();
    env = undefined;
  });

  it("reads", async () => {
    const { readQuery } = await import("@/db/drizzle");
    await env!.pool.query(`INSERT INTO orders (id, order_number) VALUES ('100', '#100')`);
    expect((await readQuery(sql`SELECT order_number FROM orders WHERE id = ${"100"}`)).rows).toEqual([
      { order_number: "#100" },
    ]);
  });

  it.each([
    ["an UPDATE", sql`UPDATE orders SET locator = 'X' WHERE id = '100'`],
    ["an INSERT", sql`INSERT INTO orders (id, order_number) VALUES ('200', '#200')`],
    ["a DELETE", sql`DELETE FROM orders`],
  ])("refuses %s, and nothing changes", async (_label, statement) => {
    const { readQuery } = await import("@/db/drizzle");
    await expect(readQuery(statement)).rejects.toThrow(/read-only transaction/);
    expect((await env!.pool.query(`SELECT id, locator FROM orders ORDER BY id`)).rows).toEqual([
      { id: "100", locator: null },
    ]);
  });

  it("production transact, the same way, does write (the control)", async () => {
    const { transact } = await import("@/db/drizzle");
    await transact([sql`UPDATE orders SET locator = 'X' WHERE id = '100'`]);
    expect((await env!.pool.query(`SELECT locator FROM orders WHERE id = '100'`)).rows).toEqual([{ locator: "X" }]);
  });
});

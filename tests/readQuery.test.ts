import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { pg16Available, startPg16 } from "./support/pg16";

// db/drizzle.ts `readQuery` (F1 spec §10): raw read-only SQL runs in a
// Postgres READ ONLY transaction, so the DATABASE refuses a write in it.

describe("readQuery asks the Neon driver for a READ ONLY transaction", () => {
  it("passes readOnly to sql.transaction and returns { rows } as db.execute callers read it", async () => {
    vi.resetModules();
    const seen: any[] = [];
    vi.doMock("@neondatabase/serverless", () => {
      const fn: any = (text: string, params: unknown[]) => ({ text, params });
      fn.transaction = async (queries: any[], opts: any) => {
        seen.push({ queries, opts });
        return [{ rows: [{ submission_id: "s1" }] }];
      };
      return { neon: () => fn };
    });
    process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@db.invalid/none";
    const { readQuery } = await import("@/db/drizzle");

    const result = await readQuery(sql`SELECT ${1}::int AS one`);

    expect(result).toEqual({ rows: [{ submission_id: "s1" }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].opts).toMatchObject({ readOnly: true, fullResults: true });
    expect(seen[0].queries).toEqual([{ text: "SELECT $1::int AS one", params: [1] }]);
    vi.doUnmock("@neondatabase/serverless");
  });
});

describe.skipIf(!pg16Available)("a READ ONLY transaction on PostgreSQL 16", () => {
  let env: Awaited<ReturnType<typeof startPg16>>;
  beforeAll(async () => {
    env = await startPg16();
  }, 60_000);
  afterAll(async () => {
    await env?.stop();
  });

  it("reads", async () => {
    await env.pool.query(`INSERT INTO orders (id, order_number) VALUES ('100', '#100')`);
    expect((await env.readQuery(sql`SELECT order_number FROM orders WHERE id = ${"100"}`)).rows).toEqual([
      { order_number: "#100" },
    ]);
  });

  it.each([
    ["an UPDATE", sql`UPDATE orders SET locator = 'X' WHERE id = '100'`],
    ["an INSERT", sql`INSERT INTO orders (id, order_number) VALUES ('200', '#200')`],
    ["a DELETE", sql`DELETE FROM orders`],
  ])("refuses %s, and nothing changes", async (_label, statement) => {
    await expect(env.readQuery(statement)).rejects.toThrow(/read-only transaction/);
    expect((await env.pool.query(`SELECT id, locator FROM orders ORDER BY id`)).rows).toEqual([
      { id: "100", locator: null },
    ]);
  });
});

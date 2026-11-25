import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";
import { pg16Available, startPg16 } from "./support/pg16";
import { seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";
import { vid } from "./support/verified";

// The self-booked tracking claim (F1 spec §4) against Postgres: tracking binds
// to an IDENTIFIED accepted SELF submission, and the write races a
// cancellation on the submission row's lock, so exactly one of them wins.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const target: { db: any; transact: (s: any) => Promise<any> } = { db: null, transact: async () => [] };
vi.mock("@/db/drizzle", () => ({
  get default() {
    return target.db;
  },
  transact: (s: any) => target.transact(s),
}));

const scope = () => import("@/lib/server/submissionScope");
const WRITE = { locator: "JD0123456789", carrier: "DHL", carrierUrl: "", verifiedBy: null };

/** An accepted SELF submission, booked, every line confirmed into Shopify. */
async function seedSelf(pg: any, orderId = "100") {
  const seeded = await seedSubmission(pg, { orderId, lines: [line(1)] });
  await pg.query(`UPDATE return_submissions SET return_method = 'SELF' WHERE id = $1`, [seeded.id]);
  await pg.query(`UPDATE orders SET return_method = 'SELF', return_submitted_at = now() WHERE id = $1`, [orderId]);
  return seeded;
}

describe("activeSelfSubmission (PGlite)", () => {
  const env = settlementDatabase();
  beforeAll(async () => {
    await env.ready;
    target.db = env.db;
    target.transact = (s) => env.transact(s);
  });
  beforeEach(() => env.reset());
  const active = async (id = "100") => (await scope()).activeSelfSubmission(vid(id));

  it("finds the order's accepted, booked, confirmed SELF submission", async () => {
    const seeded = await seedSelf(env.pg);
    expect((await active())?.id).toBe(seeded.id);
  });

  it("finds none when the order has no SELF submission", async () => {
    await seedSubmission(env.pg, { lines: [line(1)] }); // CORREOS
    expect(await active()).toBeNull();
  });

  it("finds none while a line is not yet confirmed into Shopify", async () => {
    const seeded = await seedSelf(env.pg);
    await env.pg.query(`UPDATE submission_lines SET return_line_item_id = NULL WHERE submission_id = $1`, [seeded.id]);
    expect(await active()).toBeNull();
  });

  it("finds none while a cancellation holds it", async () => {
    const seeded = await seedSelf(env.pg);
    await env.pg.query(`UPDATE return_submissions SET holder = 'cancellation' WHERE id = $1`, [seeded.id]);
    expect(await active()).toBeNull();
  });

  it("finds none for another order's session", async () => {
    await seedSelf(env.pg, "100");
    await env.pg.query(`INSERT INTO orders (id, order_number) VALUES ('200', '#200')`);
    expect(await active("200")).toBeNull();
  });

  it("claims the empty slot once; a second claim writes nothing", async () => {
    await seedSelf(env.pg);
    const { claimTracking } = await scope();
    const sub = (await active())!;
    expect(await claimTracking(sub, WRITE)).toBe(true);
    expect(await claimTracking(sub, { ...WRITE, locator: "OTHER" })).toBe(false);
    const [order] = (await env.pg.query<any>(`SELECT locator, carrier FROM orders WHERE id = '100'`)).rows;
    expect(order).toEqual({ locator: "JD0123456789", carrier: "DHL" });
  });
});

describe.skipIf(!pg16Available)("tracking claim against cancellation (PostgreSQL 16)", () => {
  let env: Awaited<ReturnType<typeof startPg16>>;
  beforeAll(async () => {
    env = await startPg16();
    target.db = env.db;
    target.transact = (s) => env.transact(s);
  }, 60_000);
  afterAll(async () => {
    await env?.stop();
  });

  // What the decided mechanism (spec §4, decision 9 = A) guarantees: a
  // cancellation that took the submission first refuses the claim. NOT
  // asserted: "exactly one wins" under true concurrency. The claim's
  // `FOR UPDATE` does not modify the row, so a cancellation UPDATE that queued
  // behind it proceeds on its own earlier snapshot after the claim commits —
  // measured 5 of 20 rounds with BOTH winning. Reported to the coordinator as a
  // spec contradiction; not patched here.
  it("a cancellation that holds the submission first makes the claim write nothing", async () => {
    const { activeSelfSubmission, claimTracking, claimForCancellation } = await scope();
    await env.reset();
    await seedSelf(env.pool);
    const sub = (await activeSelfSubmission(vid("100")))!;

    expect(await claimForCancellation(sub)).toBe(true);
    expect(await claimTracking(sub, WRITE)).toBe(false);
    const { rows } = await env.pool.query(`SELECT locator FROM orders WHERE id = '100'`);
    expect(rows[0].locator).toBeNull();
  });

  it("a claim holding the row lock makes a concurrent cancellation wait for its commit", async () => {
    const { activeSelfSubmission } = await scope();
    await env.reset();
    const seeded = await seedSelf(env.pool);
    await activeSelfSubmission(vid("100"));
    const locker = await env.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT id FROM return_submissions WHERE id = $1 FOR UPDATE`, [seeded.id]);
      let done = false;
      const cancel = env.pool
        .query(`UPDATE return_submissions SET holder = 'cancellation' WHERE id = $1 AND holder IS NULL`, [seeded.id])
        .then(() => (done = true));
      await new Promise((r) => setTimeout(r, 150));
      expect(done).toBe(false);
      await locker.query("COMMIT");
      await cancel;
      expect(done).toBe(true);
    } finally {
      locker.release();
    }
  });
});

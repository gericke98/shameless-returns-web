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

const target: { db: any; transact: (s: any) => Promise<any>; readQuery: (s: any) => Promise<any> } = {
  db: null,
  transact: async () => [],
  readQuery: async () => ({ rows: [] }),
};
vi.mock("@/db/drizzle", () => ({
  get default() {
    return target.db;
  },
  transact: (s: any) => target.transact(s),
  readQuery: (s: any) => target.readQuery(s),
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
    target.readQuery = (s) => env.readQuery(s);
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
    target.readQuery = (s) => env.readQuery(s);
  }, 60_000);
  afterAll(async () => {
    await env?.stop();
  });

  // Spec §10: tracking and cancellation serialize on the submission's row
  // lock, and the cancellation's claim re-checks the order on a snapshot taken
  // after it. Exactly one wins, in every round, whichever starts first.
  it.each([
    ["tracking first", true],
    ["cancellation first", false],
  ])("exactly one of tracking and cancellation wins, every round (%s)", async (_label, trackingFirst) => {
    const { activeSelfSubmission, claimTracking, claimForCancellation } = await scope();
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < 50; i += 1) {
      await env.reset();
      await seedSelf(env.pool);
      const sub = (await activeSelfSubmission(vid("100")))!;
      const track = () => claimTracking(sub, WRITE);
      const cancel = () => claimForCancellation(sub);
      const [tracked, cancelled] = trackingFirst
        ? await Promise.all([track(), cancel()])
        : await Promise.all([cancel(), track()]).then(([c, t]) => [t, c]);
      const key = tracked && cancelled ? "both" : tracked ? "tracking" : cancelled ? "cancellation" : "neither";
      outcomes[key] = (outcomes[key] ?? 0) + 1;

      const { rows } = await env.pool.query(
        `SELECT o.locator, s.holder FROM orders o JOIN return_submissions s ON s.order_id = o.id WHERE o.id = '100'`
      );
      expect(rows[0].locator !== null).toBe(tracked);
      expect(rows[0].holder === "cancellation").toBe(cancelled);
    }
    console.log(`tracking vs cancellation (${_label}):`, outcomes);
    expect(Object.keys(outcomes).filter((k) => k === "both" || k === "neither")).toEqual([]);
  }, 120_000);

  it("a committed tracking claim makes a later cancellation refuse", async () => {
    const { activeSelfSubmission, claimTracking, claimForCancellation } = await scope();
    await env.reset();
    await seedSelf(env.pool);
    const sub = (await activeSelfSubmission(vid("100")))!;
    expect(await claimTracking(sub, WRITE)).toBe(true);
    expect(await claimForCancellation(sub)).toBe(false);
  });

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

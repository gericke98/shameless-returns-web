import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { settlementDatabase } from "./support/settlementDb";

// FX migrations (drizzle/0014, drizzle/0015): the invariants the ledger relies
// on are the database's, not only the code's.

const env = settlementDatabase();
const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;

const SUB = "11111111-1111-4111-8111-111111111111";
const OP = "22222222-2222-4222-8222-222222222222";

async function submission(state = "accepted", acceptedAt: string | null = "now()") {
  await q(`INSERT INTO return_submissions (id, order_id, state, tender, return_method, return_leg_cents,
     outbound_leg_cents, charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
     stripe_charge_cents, waived_cents, owed_cents, residual_cents, accepted_at)
     VALUES ('${SUB}', '100', '${state}', 'refund', 'CORREOS', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ${acceptedAt ?? "NULL"})`);
}

/** The constraint a statement violated, by name (PGlite's message omits it). */
async function violated(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error: any) {
    return String(error?.constraint ?? error?.message);
  }
  return "(no violation)";
}

const hold = (over: Record<string, string> = {}) => {
  const cols = { id: "gen_random_uuid()", submission_id: `'${SUB}'`, cause: "'stock-short'", detail: "'{}'::jsonb", ...over };
  return q(`INSERT INTO settlement_holds (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
};

describe("drizzle/0014 settlement_holds", () => {
  beforeAll(async () => {
    await env.ready;
  });
  beforeEach(async () => {
    await env.reset();
  });

  it("an accepted submission always has accepted_at (D2 orders by it)", async () => {
    expect(await violated(submission("accepted", null))).toMatch(/accepted_at_check/);
    await submission("awaiting_payment", null);
    expect(await violated(q(`UPDATE return_submissions SET state = 'accepted'`))).toMatch(/accepted_at_check/);
  });

  it("holder may be 'manual' (A2), and nothing else new", async () => {
    await submission();
    await q(`UPDATE return_submissions SET holder = 'manual'`);
    expect(await violated(q(`UPDATE return_submissions SET holder = 'someone'`))).toMatch(/holder_check/);
  });

  it("one open hold per submission; a resolved one does not count", async () => {
    await submission();
    await hold();
    expect(await violated(hold())).toMatch(/settlement_holds_one_open/);
    await q(`UPDATE settlement_holds SET resolution = 'release', resolved_by = 'santi', evidence = 'restocked', resolved_at = now()`);
    await hold({ cause: "'legacy-plan'" });
  });

  it("an exchange-rejected hold names its operation, and only that cause does", async () => {
    await submission();
    await q(`INSERT INTO settlement_operations (id, submission_id, kind, scope_key, request)
             VALUES ('${OP}', '${SUB}', 'exchange_order', 'exchange:${SUB}', '{}'::jsonb)`);
    expect(await violated(hold({ cause: "'exchange-rejected'" }))).toMatch(/exchange_operation_check/);
    expect(await violated(hold({ exchange_operation_id: `'${OP}'` }))).toMatch(/exchange_operation_check/);
    await hold({ cause: "'exchange-rejected'", exchange_operation_id: `'${OP}'` });
    expect(await violated(hold({ cause: "'unknown'" }))).toMatch(/cause_check/);
  });

  it("a resolution carries who, evidence and when, or nothing", async () => {
    await submission();
    await hold();
    expect(await violated(q(`UPDATE settlement_holds SET resolution = 'release'`))).toMatch(/resolution_fields_check/);
    expect(await violated(
      q(`UPDATE settlement_holds SET resolution = 'release', resolved_by = ' ', evidence = 'x', resolved_at = now()`)
    )).toMatch(/resolution_fields_check/);
  });

  it("manual only after it was taken; a taken hold is never released", async () => {
    await submission();
    await hold();
    expect(await violated(
      q(`UPDATE settlement_holds SET resolution = 'manual', resolved_by = 'santi', evidence = 'x', resolved_at = now()`)
    )).toMatch(/manual_taken_check/);
    expect(await violated(q(`UPDATE settlement_holds SET taken_by = 'santi'`))).toMatch(/taken_check/);
    await q(`UPDATE settlement_holds SET taken_by = 'santi', taken_at = now()`);
    expect(await violated(
      q(`UPDATE settlement_holds SET resolution = 'release', resolved_by = 'santi', evidence = 'x', resolved_at = now()`)
    )).toMatch(/release_untaken_check/);
    await q(`UPDATE settlement_holds SET resolution = 'manual', resolved_by = 'santi', evidence = 'x', resolved_at = now()`);
  });

  it("hold_draft_releases: a pointer is cleared only for a draft that is gone", async () => {
    const row = (outcome: string, cleared: boolean) =>
      q(`INSERT INTO hold_draft_releases (id, order_id, draft_order_id, outcome, detail, released_by, pointer_cleared)
         VALUES (gen_random_uuid(), '100', 'gid://shopify/DraftOrder/1', '${outcome}', '{}'::jsonb, 'santi', ${cleared})`);
    await row("deleted", true);
    await row("already-gone", true);
    await row("completed", false);
    expect(await violated(row("still-exists", true))).toMatch(/pointer_check/);
    expect(await violated(row("unreadable", true))).toMatch(/pointer_check/);
    expect(await violated(row("gone", false))).toMatch(/outcome_check/);
  });
});

describe("drizzle/0015 orders_no_exchange_reservation", () => {
  beforeAll(async () => {
    await env.ready;
  });
  beforeEach(async () => {
    await env.reset();
    await q(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_no_exchange_reservation`);
  });

  it("fails while any pointer remains, and then forbids setting one", async () => {
    const sql = readFileSync("drizzle/0015_no_exchange_reservation.sql", "utf8");
    await q(`INSERT INTO orders (id, order_number, exchange_reservation_id) VALUES ('100', '#100', 'gid://shopify/DraftOrder/1')`);
    expect(await violated(env.pg.exec(sql))).toMatch(/orders_no_exchange_reservation/);

    await q(`UPDATE orders SET exchange_reservation_id = NULL`);
    await env.pg.exec(sql);
    await env.pg.exec(sql); // re-running it is harmless
    expect(await violated(q(`UPDATE orders SET exchange_reservation_id = 'gid://shopify/DraftOrder/2'`))).toMatch(/orders_no_exchange_reservation/);
    await q(`ALTER TABLE orders DROP CONSTRAINT orders_no_exchange_reservation`);
  });
});

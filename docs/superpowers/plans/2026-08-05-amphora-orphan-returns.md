# Amphora Orphan Returns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the last two stranded international returns a carrier, and make the
Amphora sync see returns that Amphora re-created on their side instead of
silently ignoring them.

**Architecture:** Two independent parts. **Part 1 is operational** — a message to
Amphora through the existing ticket script, no application code, no tests.
**Part 2 is a code change** — replace the cron's `external_id`-only ownership
test with a two-rule match: keep today's `external_id` path, and additionally
recover the order id from Amphora's own `SHP <order id>` return id (the same
recovery `orderIdFromWebhook` already performs for the webhook payload, which
has never carried an `external_id` either). Orphans are only accepted when the
recovered order is in our database **and** international, because Spain never
routes through Amphora — that is what keeps Amphora's own Shopify-channel
returns out.

**Tech Stack:** Next.js App Router (route handlers), Drizzle + Neon Postgres,
vitest, tsx for the ops scripts, Amphora Company API.

## Global Constraints

- Amphora spells approved `APROVED`, with one P. That is the wire value.
- Ticket writes (`tickets/add_message`, `tickets/create`) are **one-way and
  cannot be unsent**. Always `--dry-run` first and read the output.
- ⚠️ Any ticket the Company API touches **disappears from the merchant UI
  permanently**. Never open a ticket casually to "see what happens".
- The only `company_user` Amphora accepts is `hello@shamelesscollective.com`;
  a personal address 422s.
- Preview and production share one database. Anything that writes is writing to
  live customer orders.
- The cron route is public — `middleware.ts` matches only `/dashboard` and
  `/login`. `CRON_SECRET` is the only thing in front of it and must stay
  fail-closed: unset secret ⇒ 401, never open.
- Run tests with `npm test` (vitest). Every task ends on a green run and a commit.

## Out of scope (tracked, deliberately not built here)

- **The double-notification.** Amphora emails the customer the label directly,
  and since auto-assign was switched on our creation-time email
  (`actions/amphoraReturn.ts:45`) also carries the tracking number. Every new
  international return now sends two notices. That is a merchant decision — keep
  ours, drop ours, or ask Amphora to stop — not a bug to fix unilaterally.
- **`CRON_SECRET` verification in production.** `vercel whoami` must read
  `gericke98` first; from `sgericke98` the production environment silently reads
  as empty. Part 2 changes nothing about whether the cron runs — if the secret is
  unset, this fix is inert until it is set.

---

# Part 1 — Get #310847 and #310664 a carrier (operational)

**Context an implementer needs.** On 2026-08-05 Amphora enabled an auto-assign
profile setting and re-created seven stranded returns with UPS carriers. These
two were created by our API on 04/08 (15:58Z and 21:02Z) — after their list of
seven was compiled, before the setting was flipped — so they were left out and
nobody is chasing them. Both are `APROVED` with `carrier: null`.

`scripts/amphora-request-pickup.ts` already does the ticket plumbing, but its
three message builders (`opener`, `reply`, `chase`) all argue the *old* case:
they ask for a pickup date and re-litigate the three-days-notice rule. That
argument is now settled and sending it would confuse the thread. This task adds a
fourth mode with the correct ask: *you fixed seven this way, these two need the
same treatment.*

### Task 1: Add a `--reassign` mode and send it

**Files:**
- Modify: `scripts/amphora-request-pickup.ts` (add `reassign()` beside
  `chase()` at line 161; extend flag parsing at lines 176-186; extend the
  message selection at lines 223-227)

**Interfaces:**
- Consumes: the existing `AmphoraReturn` type and `collectionAddress(r)` helper
  in the same file.
- Produces: nothing other modules import — this is a standalone script.

- [ ] **Step 1: Add the message builder**

Insert after `chase()` (currently ends line 172):

```ts
/**
 * Ask them to apply the fix they already applied. On 2026-08-05 Amphora
 * enabled an auto-assign profile setting and re-created seven stranded returns
 * with UPS carriers; these were created before the flip and were not on that
 * list. The three-days-notice argument is settled, so this deliberately does
 * NOT re-open it — the only ask is parity with the seven.
 */
function reassign(r: AmphoraReturn, waiting: number) {
  return (
    `Hola,\n\n` +
    `Gracias por habilitar la asignación automática de transportista y por volver ` +
    `a crear las siete devoluciones con carrier — lo hemos verificado y todas ` +
    `tienen ya su número de UPS.\n\n` +
    `Nos quedan dos que no estaban en esa lista porque se crearon justo antes de ` +
    `que lo habilitarais, y siguen APROVED sin transportista:\n\n` +
    `  · ${r.id} (pedido ${r.name}, ${r.shipping_address_country_code}), creada el ` +
    `${String(r.time).slice(0, 10)}, ${waiting} días esperando.\n\n` +
    `Recogida en: ${collectionAddress(r)}\n\n` +
    `¿Podéis darles el mismo tratamiento que a las otras siete? No hace falta que ` +
    `nos confirméis fecha: en cuanto tengan carrier y número lo vemos por API.\n\n` +
    `Gracias.`
  );
}
```

- [ ] **Step 2: Accept the flag**

At line 177, beside `const chasing = argv.includes("--chase");`, add:

```ts
  const reassigning = argv.includes("--reassign");
```

`--date` is required by line 188 but a reassign carries no date. Change that
guard to:

```ts
  if (!date && !reassigning) throw new Error(`--date is required, e.g. --date "jueves 6 de agosto"`);
```

- [ ] **Step 3: Select the new message**

Replace the `const message = ...` expression (lines 223-227) with:

```ts
    const message = reassigning
      ? reassign(r, waiting)
      : chasing
        ? chase(r, date, slot)
        : open
          ? reply(r, date, slot, waiting, stranded)
          : opener(r, date, slot, waiting, stranded);
```

Note the `--chase` early-skip at lines 216-219 only applies to `chasing`; a
reassign must be able to open a new thread, since neither order has a ticket.

- [ ] **Step 4: Dry-run and read every word**

```bash
npx tsx scripts/amphora-request-pickup.ts --reassign --dry-run '#310847' '#310664'
```

Expected: two blocks, each `→ tickets/create (new thread)`, each quoting the
right country, creation date, and collection address. **Stop and fix the copy if
anything reads wrong — this cannot be unsent.**

- [ ] **Step 5: Send**

```bash
npx tsx scripts/amphora-request-pickup.ts --reassign '#310847' '#310664'
```

Expected: `✔ opened ticket …` twice.

- [ ] **Step 6: Commit**

```bash
git add scripts/amphora-request-pickup.ts
git commit -m "feat: --reassign mode for returns stranded before auto-assign"
```

- [ ] **Step 7: Verify a carrier lands**

```bash
npx tsx scripts/watch-amphora-carriers.ts
```

Expected once Amphora acts: both orders move out of the stranded list and into
`CARRIER ASSIGNED`. Until then they keep printing with `<-- STALE`. If nothing
has changed by the next working morning, the escalation is Mariana's email
thread, not another ticket.

**Success criteria:** #310847 and #310664 both report a carrier and a
`carrier_number` from the Amphora API. Their `orders` rows will still hold no
carrier — Part 2 is what closes that gap, or a repeat of today's manual backfill.

---

# Part 2 — Stop orphaned returns from being invisible

**Context an implementer needs.** `app/api/cron/amphora-sync/route.ts:50` decides
what belongs to us with one line:

```ts
const ours = returns.filter((r) => r.external_id);
```

`external_id` is our Shopify order id, set by `POST /returns` when *we* create
the return. When Amphora re-creates a return in their own UI — which is exactly
what they did to all seven on 2026-08-05 — the new record has
`external_id: null`. It is a live return for one of our orders, and our sync
skips it forever: no carrier stored, no status, no customer email.

The recovery already exists. `lib/amphoraWebhook.ts:38 orderIdFromWebhook` was
written because the *webhook* payload never carries an `external_id` either, and
it recovers our order id from the return id, which is literally
`SHP <shopify order id>` (verified: `SHP 13182814978374` ⇄ order `#310905`,
`orders.id = 13182814978374`). The cron simply never used it.

**Why the international check is the safety rail.** Amphora's own
Shopify-channel returns also have `external_id: null` and also have `SHP `-
prefixed ids, so the id alone does not prove ownership. Two things narrow it:
our `orders` table holds only orders that went through our returns portal (532
rows, not the whole shop), and **Spain never routes through Amphora** — domestic
returns are Correos. So an orphan whose recovered order is in our table *and*
international is ours; anything else is theirs.

## File Structure

| File | Responsibility |
|---|---|
| `lib/amphoraReturnMatch.ts` (create) | Pure. Given the raw `/returns` list, decide which order id each return claims and collapse duplicates to one return per order. No DB, no env, no network — same house rule as `lib/amphoraWebhook.ts`. |
| `tests/amphoraReturnMatch.test.ts` (create) | Unit tests for the above. |
| `app/api/cron/amphora-sync/route.ts` (modify) | Uses the matcher, then does the DB lookup and applies the international ownership rule. |
| `tests/amphoraSyncRoute.test.ts` (modify) | Its `getOrderById` mock currently returns an order for *any* id, which would make every orphan resolve. Needs a fixture map. |
| `scripts/watch-amphora-carriers.ts` (modify) | Same ownership rule, so ops visibility matches what the cron acts on. |

### Task 2: The pure matcher

**Files:**
- Create: `lib/amphoraReturnMatch.ts`
- Test: `tests/amphoraReturnMatch.test.ts`

**Interfaces:**
- Consumes: `orderIdFromWebhook` from `lib/amphoraWebhook.ts` —
  `(payload: { id?: string | null }) => string | null`, strips the `SHP ` prefix
  and returns null when absent.
- Produces:
  - `type MatchableReturn = { id?: string | null; name?: string | null; external_id?: string | null; time?: string | null }`
  - `type ReturnMatch<T> = { orderId: string; ret: T; viaExternalId: boolean }`
  - `matchReturnsToOrderIds<T extends MatchableReturn>(returns: T[]): ReturnMatch<T>[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/amphoraReturnMatch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";

// Amphora's return id is `SHP <shopify order id>`, which is also our
// `orders.id`. That is the only link back when they create the return
// themselves, because then `external_id` is null.

const withExternal = {
  id: "SHP 13192219558214",
  name: "#310957",
  external_id: "13192219558214",
  time: "2026-08-01T10:00:00",
};

const orphan = {
  id: "SHP 13161916465478",
  name: "#310761",
  external_id: null,
  time: "2026-08-05T06:25:20",
};

describe("matchReturnsToOrderIds", () => {
  it("keys a return we created by its external_id", () => {
    const [match] = matchReturnsToOrderIds([withExternal]);

    expect(match.orderId).toBe("13192219558214");
    expect(match.viaExternalId).toBe(true);
  });

  it("recovers the order id of an Amphora-created return from the SHP prefix", () => {
    const [match] = matchReturnsToOrderIds([orphan]);

    expect(match.orderId).toBe("13161916465478");
    expect(match.viaExternalId).toBe(false);
  });

  it("drops a return with no external_id and no SHP prefix", () => {
    const matches = matchReturnsToOrderIds([
      { id: "MNL 999", name: "#310000", external_id: null, time: null },
    ]);

    expect(matches).toEqual([]);
  });

  it("prefers the return we created when both exist for one order", () => {
    const ours = { ...withExternal, id: "SHP 13192219558214" };
    const theirs = { ...orphan, id: "SHP 13192219558214", name: "#310957" };

    const matches = matchReturnsToOrderIds([theirs, ours]);

    expect(matches).toHaveLength(1);
    expect(matches[0].viaExternalId).toBe(true);
  });

  it("keeps the newest when an order has two Amphora-created returns", () => {
    const older = { ...orphan, time: "2026-08-04T06:00:00" };
    const newer = { ...orphan, time: "2026-08-05T06:25:20" };

    const matches = matchReturnsToOrderIds([older, newer]);

    expect(matches).toHaveLength(1);
    expect(matches[0].ret.time).toBe("2026-08-05T06:25:20");
  });

  it("treats a missing timestamp as oldest rather than throwing", () => {
    const undated = { ...orphan, time: null };
    const dated = { ...orphan, time: "2026-08-05T06:25:20" };

    const matches = matchReturnsToOrderIds([dated, undated]);

    expect(matches[0].ret.time).toBe("2026-08-05T06:25:20");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/amphoraReturnMatch.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/amphoraReturnMatch"`.

- [ ] **Step 3: Write the implementation**

Create `lib/amphoraReturnMatch.ts`:

```ts
// Pure — no db, no env, no network. Works out which of our orders each Amphora
// return belongs to, so the cron and the ops scripts cannot drift on the answer.
//
// Two links exist, and we need both:
//   · `external_id` — our Shopify order id, set by POST /returns. Present only
//     on returns WE created.
//   · the `SHP <shopify order id>` return id — present on every return,
//     including the ones Amphora creates in their own UI, which is what they
//     did to all seven stranded returns on 2026-08-05. Those carry
//     `external_id: null` and were invisible to the sync until this existed.
//
// Deciding ownership is NOT this module's job: an id match only says which
// order a return refers to. The caller still has to check the order is ours and
// international — Amphora's Shopify-channel returns match by id too.
import { orderIdFromWebhook } from "@/lib/amphoraWebhook";

export type MatchableReturn = {
  id?: string | null;
  name?: string | null;
  external_id?: string | null;
  time?: string | null;
};

export type ReturnMatch<T> = {
  orderId: string;
  ret: T;
  /** True when we created it. The caller relaxes its checks for these. */
  viaExternalId: boolean;
};

/** Sortable creation time. A missing stamp sorts oldest so a dated return
 *  always beats an undated one. */
function createdAt(ret: MatchableReturn): number {
  const stamp = ret.time;
  if (!stamp) return -Infinity;
  // Amphora sends both bare local stamps and offset-aware ones; read a bare one
  // as UTC so this behaves the same on a laptop and in a Vercel function.
  const iso = /[Z+]|-\d{2}:\d{2}$/.test(stamp) ? stamp : `${stamp}Z`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * One match per order, so a re-created return and the record it replaced can
 * never both be applied in the same sweep.
 *
 * A return we created wins outright — its `external_id` is a direct statement of
 * ownership, where a recovered id is an inference. Between two inferred ones,
 * the newest wins, because that is the one Amphora is actually working.
 */
export function matchReturnsToOrderIds<T extends MatchableReturn>(
  returns: T[]
): ReturnMatch<T>[] {
  const best = new Map<string, ReturnMatch<T>>();

  for (const ret of returns) {
    const external = ret.external_id?.trim();
    const orderId = external || orderIdFromWebhook(ret);
    if (!orderId) continue;

    const candidate: ReturnMatch<T> = {
      orderId,
      ret,
      viaExternalId: Boolean(external),
    };
    const held = best.get(orderId);

    if (!held) {
      best.set(orderId, candidate);
      continue;
    }
    if (held.viaExternalId) continue;
    if (candidate.viaExternalId || createdAt(ret) > createdAt(held.ret)) {
      best.set(orderId, candidate);
    }
  }

  return [...best.values()];
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/amphoraReturnMatch.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/amphoraReturnMatch.ts tests/amphoraReturnMatch.test.ts
git commit -m "feat: match Amphora returns to orders via the SHP return id"
```

### Task 3: Teach the cron to use it

**Files:**
- Modify: `app/api/cron/amphora-sync/route.ts:48-95`
- Test: `tests/amphoraSyncRoute.test.ts` (modify)

**Interfaces:**
- Consumes: `matchReturnsToOrderIds` and `ReturnMatch` from Task 2;
  `isInternationalOrder(shippingCountry: string | null | undefined): boolean`
  from `lib/countries.ts`; `getOrderById`, `getOrderByNumber` from `@/db/queries`.
- Produces: the route's JSON body gains one field —
  `{ scanned, changed, stranded, skipped }`, where `skipped` counts id matches
  rejected by the ownership rule. It exists so a wrong rule shows up in the
  Vercel logs as a number instead of as silence.

- [ ] **Step 1: Write the failing tests**

In `tests/amphoraSyncRoute.test.ts`, replace the `THEIRS` fixture and the
`@/db/queries` mock, and add a third fixture. The existing mock returns an order
for *every* id, which would make every orphan resolve and prove nothing:

```ts
// An orphan for one of OUR international orders: this is what Amphora leaves
// behind when they re-create a return in their own UI (2026-08-05, all seven).
const RECREATED = {
  id: "SHP 13161916465478",
  name: "#310761",
  external_id: null,
  internal_status: "APROVED",
  carrier: "UPS",
  carrier_number: "1Z3EF3229111791266",
  carrier_url: "https://www.ups.com/track?tracknum=1Z3EF3229111791266",
  time: "2026-08-05T06:25:20",
};

// A domestic return as Amphora records it on ARRIVAL at their warehouse. Same
// shape, but the order is Spanish, so we booked it on Correos and already hold
// a Correos locator. Applying this would overwrite that tracking with the
// carrier that delivered the box (real case: order #310273, ours says Correos
// PQAZXT9800004100128221Y, theirs says CEX).
const THEIRS = {
  id: "SHP 13181092561222",
  name: "#310889",
  external_id: null,
  internal_status: "RECEIVED",
  carrier: "GLS",
  carrier_number: "410012086538530013",
  carrier_url: null,
  time: "2026-08-02T09:00:00",
};

// An orphan for an order that never went through our portal at all.
const UNKNOWN = {
  id: "SHP 99999999999999",
  name: "#309000",
  external_id: null,
  internal_status: "APROVED",
  carrier: "UPS",
  carrier_number: "1Z000",
  carrier_url: null,
  time: "2026-08-02T09:00:00",
};

const ORDERS: Record<string, any> = {
  "13192219558214": {
    id: "13192219558214",
    orderNumber: "#310957",
    shippingCountry: "Germany",
  },
  "13161916465478": {
    id: "13161916465478",
    orderNumber: "#310761",
    shippingCountry: "Italia",
  },
  "13181092561222": {
    id: "13181092561222",
    orderNumber: "#310889",
    shippingCountry: "Spain",
  },
};

vi.mock("@/db/queries", () => ({
  getOrderById: async (id: string) => ORDERS[id],
  getOrderByNumber: async (name: string) =>
    Object.values(ORDERS).find((o: any) => o.orderNumber === name),
}));
```

Update `beforeEach` to `state.returns = [OURS, RECREATED, THEIRS, UNKNOWN];`,
then change the scope test and add three:

```ts
  it("acts on returns we created AND on the ones Amphora re-created for us", async () => {
    const res = await call({ authorization: "Bearer s3cret" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(applied.map((a) => a.order).sort()).toEqual(["#310761", "#310957"]);
    expect(body.scanned).toBe(2);
  });

  it("never touches an orphan whose order is Spanish — Spain is Correos, so it is theirs", async () => {
    await call({ authorization: "Bearer s3cret" });

    expect(applied.map((a) => a.order)).not.toContain("#310889");
  });

  it("never touches an orphan for an order that is not in our database", async () => {
    await call({ authorization: "Bearer s3cret" });

    expect(applied.map((a) => a.order)).not.toContain("#309000");
  });

  it("counts the id matches it rejected, so a wrong rule is visible in the logs", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.skipped).toBe(2);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/amphoraSyncRoute.test.ts`
Expected: FAIL — the scope test reports only `["#310957"]`, and `body.skipped` is
`undefined`.

- [ ] **Step 3: Rewrite the selection block**

In `app/api/cron/amphora-sync/route.ts`, replace lines 48-51 (the
`// Only ours.` comment and the `ours` filter) with:

```ts
  // Which order does each return refer to, at most one return per order?
  const matches = matchReturnsToOrderIds(returns);

  const changed: Array<Record<string, unknown>> = [];
  const acted: typeof matches = [];
  let scanned = 0;
  let skipped = 0;
```

Delete the now-duplicated `const changed`/`let scanned` declarations that
followed, then replace the loop header (`for (const ret of ours) {` through the
`if (!order) continue;` line) with:

```ts
  for (const match of matches) {
    const ret = match.ret;
    try {
      const order =
        (await getOrderById(match.orderId)) ??
        (match.viaExternalId && ret.name ? await getOrderByNumber(ret.name) : null);

      // An id match is not ownership. A return Amphora created carries no
      // external_id, and neither does the record Amphora opens when a parcel
      // simply ARRIVES at their warehouse — which happens for domestic returns
      // too, since they are the 3PL receiving every box. Measured 2026-08-05:
      // 47 of the 87 returns we did not create are Spanish, carrying CEX/CAI/
      // GLS/CTT. Order #310273 is the case that matters: we booked it on
      // Correos and hold locator PQAZXT9800004100128221Y, while Amphora's
      // record for the same parcel says carrier CEX. Syncing a domestic orphan
      // would overwrite the Correos tracking we show the customer with the
      // carrier that happened to deliver it. Spain is Correos on our side, so
      // an orphan against a domestic order is never ours to apply.
      if (!order || (!match.viaExternalId && !isInternationalOrder(order.shippingCountry))) {
        skipped += 1;
        continue;
      }

      scanned += 1;
      acted.push(match);

      const outcome = await applyReturnStatus(order as any, {
        id: ret.id,
        name: ret.name,
        internal_status: ret.internal_status,
        carrier: ret.carrier,
        carrier_number: ret.carrier_number,
        carrier_url: ret.carrier_url,
      });
```

Keep the rest of the loop body and the `catch` exactly as they are. Note the
`getOrderByNumber` fallback is now gated on `viaExternalId`: for a return we
created, the name is a safe second link; for an orphan, falling back to the name
would re-open the very hole the `SHP` recovery closes.

- [ ] **Step 4: Fix the stranded count and the response**

Replace the `stranded` computation (which still reads `ours`) and the final
return with:

```ts
  const stranded = acted.filter(
    (m) => !m.ret.carrier && !["CANCELLED", "FINISHED"].includes(String(m.ret.internal_status))
  ).length;
  if (stranded) {
    console.warn(
      `[amphora-sync] ${stranded} return(s) approved with no carrier assigned — collections are not booked.`
    );
  }

  return NextResponse.json({ scanned, changed, stranded, skipped });
```

- [ ] **Step 5: Add the imports**

At the top of the file, beside the existing imports:

```ts
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";
import { isInternationalOrder } from "@/lib/countries";
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run tests/amphoraSyncRoute.test.ts`
Expected: PASS, all tests including the three authorisation tests, which must be
untouched.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS. `tests/amphoraStatusSync.test.ts` and
`tests/amphoraWebhook.test.ts` exercise the shared downstream and must be green —
if either broke, the change leaked past the selection step.

- [ ] **Step 8: Commit**

```bash
git add app/api/cron/amphora-sync/route.ts tests/amphoraSyncRoute.test.ts
git commit -m "fix: sync returns Amphora re-created, which carry no external_id"
```

### Task 4: Give the ops script the same eyes

**Files:**
- Modify: `scripts/watch-amphora-carriers.ts:112-131`

**Interfaces:**
- Consumes: `matchReturnsToOrderIds` from Task 2. The script's local
  `AmphoraReturn` type already has `id`, `name`, `external_id` and `time`, so it
  satisfies `MatchableReturn` without changes.

Without this, the script keeps reporting `API-created returns: 3` while the cron
acts on more than that, and the next person to run it concludes the orphans do
not exist — which is exactly the mistake that let seven returns sit for ten days.

- [ ] **Step 1: Import the matcher and the database client**

Add beside the existing imports. `dotenv/config` and `neon` follow
`scripts/create-admin.ts`, which already reads `DATABASE_URL` this way:

```ts
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { matchReturnsToOrderIds } from "../lib/amphoraReturnMatch";
import { isInternationalOrder } from "../lib/countries";
```

- [ ] **Step 2: Replace the ownership filter**

Replace lines 121-127 (the `// Only the ones WE created.` comment, the `ours`
filter, and the `assigned`/`stranded` derivations) with:

```ts
  // Everything that refers to one of our orders, whether we created it or
  // Amphora re-created it in their UI (which nulls `external_id`), filtered by
  // the SAME ownership rule the cron applies — an orphan counts only when the
  // order is in our database AND international.
  //
  // An earlier revision skipped the database and simply over-reported, on the
  // theory that showing too much is safer than hiding a stranded return. In
  // production that printed 77 rows, 74 of them under "notify these customers",
  // including 2025-era Spanish CEX/CAI/DHL returns that never touched our
  // portal. Burying three stranded returns under 74 irrelevant ones fails this
  // script's only job just as completely as hiding them would.
  const matched = matchReturnsToOrderIds(all);
  const orders = await ordersById(matched.map((m) => m.orderId));
  const owned = matched.filter((m) => {
    const order = orders.get(m.orderId);
    if (!order) return false;
    return m.viaExternalId || isInternationalOrder(order.shipping_country);
  });
  const ours = owned.map((m) => m.ret);
  const recreated = new Set(owned.filter((m) => !m.viaExternalId).map((m) => m.ret));
  const assigned = ours.filter((r) => r.carrier);
  const stranded = ours
    .filter((r) => !r.carrier && !["CANCELLED", "FINISHED"].includes(r.internal_status))
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
```

The database helper, added above `main()`. One query for the whole sweep — the
script runs against production and must not issue a query per return:

```ts
/** Our orders for the given ids, keyed by id. Read-only. */
async function ordersById(
  ids: string[]
): Promise<Map<string, { shipping_country: string }>> {
  if (ids.length === 0) return new Map();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. This script now resolves ownership against our own orders table — export it or add it to .env."
    );
  }
  const sql = neon(url);
  const rows = (await sql`
    select id, shipping_country from orders where id = any(${ids})
  `) as Array<{ id: string; shipping_country: string }>;
  return new Map(rows.map((r) => [r.id, { shipping_country: r.shipping_country }]));
}
```

- [ ] **Step 3: Mark the re-created ones in the output**

In the `assigned` loop, change the log line to:

```ts
      console.log(
        `  ${r.name}  ${r.carrier}  ${r.carrier_number ?? "(no number)"}  ${r.carrier_url ?? ""}` +
          (recreated.has(r) ? "  [re-created by Amphora]" : "")
      );
```

- [ ] **Step 4: Run it against production**

```bash
npx tsx scripts/watch-amphora-carriers.ts
```

Expected: the seven re-created returns now appear under `CARRIER ASSIGNED`, each
tagged `[re-created by Amphora]`, alongside #310097. #310847 and #310664 appear
stranded until Part 1 lands. The header count rises from 3 to roughly 10 — NOT
to 77. If it reads 77, the ownership filter is not being applied and the script
is reporting Amphora's whole tenant, including domestic returns from 2025.

- [ ] **Step 5: Commit**

```bash
git add scripts/watch-amphora-carriers.ts
git commit -m "feat: watch script sees returns Amphora re-created"
```

### Task 5: Confirm the fix is inert on already-backfilled orders

**Files:** none — this is a verification gate before deploying.

The seven were backfilled by hand on 2026-08-05, which set `locator`. Task 3
makes the cron see them for the first time, so it will now call
`applyReturnStatus` on all seven. It must record their status and **not** email
them, because Amphora already sent each customer the label directly. The guard is
`lib/amphoraWebhook.ts:74` — `collectionScheduled` only fires when
`!order.locator` — and the backfill is what disarms it.

- [ ] **Step 1: Prove the guard holds for a backfilled order**

Add to `tests/amphoraStatusSync.test.ts`:

```ts
  it("records the status but sends nothing when we already hold the tracking", async () => {
    const order = {
      id: "13161916465478",
      orderNumber: "#310761",
      email: "ruminc01@icloud.com",
      shippingName: "Ivan Forastiero",
      returnStatus: null,
      locator: "1Z3EF3229111791266",
    };

    const outcome = await applyReturnStatus(order as any, {
      id: "SHP 13161916465478",
      name: "#310761",
      internal_status: "APROVED",
      carrier: "UPS",
      carrier_number: "1Z3EF3229111791266",
      carrier_url: "https://www.ups.com/track?tracknum=1Z3EF3229111791266",
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.emailsSent).toEqual([]);
  });
```

Match the existing mocks in that file rather than inventing new ones — it
already stubs the db and Postmark.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/amphoraStatusSync.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit and deploy**

```bash
git add tests/amphoraStatusSync.test.ts
git commit -m "test: backfilled tracking suppresses the collection email"
```

Deploy, then read the first cron run in the Vercel logs. Expected shape:
`scanned` ≥ 10, `skipped` > 0, `changed` listing the seven moving to `APROVED`
(or `TRAVELLING` for #310957) with `emailsSent: []`.

**⚠️ If `CRON_SECRET` is unset in production the route 401s itself every 15
minutes and none of this runs.** Check with `vercel whoami` reading `gericke98`
first — from `sgericke98` the production environment reads as empty and you will
wrongly conclude the variable is missing.

---

## Self-Review

**Spec coverage.** Part 1 covers chasing both stranded orders (Task 1). Part 2
covers the blind spot end to end: pure matching (Task 2), the cron (Task 3), ops
visibility (Task 4), and the no-double-email gate before deploy (Task 5). The
double-notification and `CRON_SECRET` are listed as out of scope with reasons.

**Placeholder scan.** No TBDs. Every code step carries the literal code; every
test step carries the assertion and the command; every run step states the
expected output.

**Type consistency.** `matchReturnsToOrderIds` / `MatchableReturn` /
`ReturnMatch` / `viaExternalId` / `orderId` are spelled identically in Tasks 2,
3 and 4. `orderIdFromWebhook` matches its real signature at
`lib/amphoraWebhook.ts:38`. `isInternationalOrder` matches `lib/countries.ts:161`.
`shippingCountry` matches `db/schema.ts:25`. The script imports by relative path
because it runs under `tsconfig.scripts.json`, not the Next.js `@/` alias — worth
confirming at Task 4 Step 4; if the alias does resolve, use it for consistency
with the rest of the repo.

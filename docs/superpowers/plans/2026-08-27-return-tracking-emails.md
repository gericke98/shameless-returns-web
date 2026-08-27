# Return Tracking Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly cron that reads each live domestic parcel's Correos status and emails the customer when it reaches a new milestone, plus two extra milestones on the international lane.

**Architecture:** A pure decision function (`lib/trackingUpdate.ts`) maps a carrier phase to one of four notification keys and decides whether that key is new for this parcel. A cron route (`app/api/cron/tracking-sync/route.ts`) polls Correos for the live domestic set and drives it. Per-parcel state lives in two new columns on `orders`. The international lane gains its two extra emails inside the existing `decideWebhookActions`.

**Tech Stack:** Next.js App Router route handlers, Drizzle + Neon (Postgres), Correos localizador REST, Postmark, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-return-tracking-emails-design.md`

## Global Constraints

- **`sin_informacion` must never email and never persist.** Correos answers HTTP 200 with `error.codError = "3"` and every field null for a parcel it cannot trace; 82 of 415 live locators were in that state at one point. Absence is *no news*, never a state.
- **Four notification keys only:** `accepted`, `in_transit`, `received`, `problem`. `en_transito` and `en_reparto` both map to `in_transit` — one email, not two.
- **Persist before emailing.** A retry or the next hourly run then finds the key unchanged and does nothing. A failed send is not retried; it is logged loudly. Same trade-off `actions/amphoraStatusSync.ts` already documents.
- **A different locator is a different parcel** and resets the state — `return_labels`'s own comment records that a re-registration gets its own row.
- **Never notify backwards.** A parcel that has reached `received` must not email `in_transit` if Correos flaps. `problem` is exempt: it may fire at any point, but only once.
- **International keeps `collectionScheduled` and `returnReceived` unchanged.** It gains only `in_transit` and `problem`. A Spanish and a French customer therefore read different wording at the same milestone — accepted knowingly.
- **The cron is domestic-only.** International milestones ride on the existing `amphora-sync`.
- Defaults: `TRACKING_EMAILS_ENABLED` unset means dry-run; `TRACKING_MAX_EMAILS_PER_RUN=20`.
- Baseline before starting: `npm test` → **796 tests / 80 files** passing on `main`.
- ⚠️ Vitest's default timeout is 5s and it runs files in parallel. On a loaded machine unrelated tests time out and the suite looks broken. If you see scattered failures with 5000ms+ durations, check `uptime` before believing them, and re-run with `npx vitest run --no-file-parallelism --testTimeout=30000`.

---

### Task 1: Schema — two columns on `orders`

**Files:**
- Modify: `db/schema.ts` (the `orders` table)
- Create: `drizzle/0001_return_tracking_state.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `orders.lastTrackingKey` (`text`, nullable) and `orders.lastTrackingLocator` (`text`, nullable), both readable through the existing Drizzle `orders` relations.

⚠️ **In this project migrations are applied BY HAND, and the DDL goes in before the code deploys.** Do not run `drizzle-kit push`. Write the SQL file, apply it to the database yourself, and verify.

- [ ] **Step 1: Add the columns to the schema**

In `db/schema.ts`, inside the `orders` table definition, next to `returnStatus`:

```ts
  /** The tracking notification we have already sent for this parcel:
   *  "accepted" | "in_transit" | "received" | "problem". Null means we have
   *  told the customer nothing yet. */
  lastTrackingKey: text("last_tracking_key"),
  /** WHICH parcel `lastTrackingKey` refers to. A re-registration produces a new
   *  Correos code whose journey legitimately starts over — without this, the
   *  new parcel's "accepted" notice would be suppressed because the old one had
   *  already passed that milestone. */
  lastTrackingLocator: text("last_tracking_locator"),
```

- [ ] **Step 2: Write the migration SQL**

Create `drizzle/0001_return_tracking_state.sql`:

```sql
-- Per-parcel tracking-notification state. Both nullable: an order that has
-- never been polled has told the customer nothing, which is the correct
-- starting state for every existing row.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "last_tracking_key" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "last_tracking_locator" text;
```

- [ ] **Step 3: Apply it by hand and verify**

Apply the SQL to the database, then confirm both columns exist:

```bash
npx tsx -e '
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
const r = await sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
  WHERE table_name = $1 AND column_name IN ($2, $3)` as any;
console.table(r);
' "orders" "last_tracking_key" "last_tracking_locator"
```

Expected: two rows, both `text`, both `YES` for nullable. If you cannot reach the database, report BLOCKED — do not proceed to later tasks against a schema that does not exist.

- [ ] **Step 4: Verify types and the suite still pass**

Run: `npx tsc --noEmit && npm test`
Expected: clean; 796 tests still passing (this task adds none).

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts drizzle/0001_return_tracking_state.sql
git commit -m "feat: per-parcel tracking notification state on orders"
```

---

### Task 2: The decision function

Pure. No db, no network, no clock, no env. This is the whole feature's judgement in one testable place.

**Files:**
- Create: `lib/trackingUpdate.ts`
- Test: `tests/trackingUpdate.test.ts`

**Interfaces:**
- Consumes: `TrackingPhase` from `@/lib/trackingStatus` (union: `"prerregistrado" | "admitido" | "en_transito" | "en_reparto" | "entregado" | "incidencia" | "sin_informacion"`).
- Produces:

```ts
export type TrackingKey = "accepted" | "in_transit" | "received" | "problem";
export type TrackingUpdateInput = {
  lastKey: string | null;
  lastLocator: string | null;
  currentLocator: string | null;
  phase: TrackingPhase;
};
export type TrackingUpdateDecision = {
  notify: TrackingKey | null;
  persist: { lastTrackingKey: TrackingKey; lastTrackingLocator: string } | null;
};
export function decideTrackingUpdate(input: TrackingUpdateInput): TrackingUpdateDecision;
export function keyForPhase(phase: TrackingPhase): TrackingKey | null;
```

- [ ] **Step 1: Write the failing test**

Create `tests/trackingUpdate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideTrackingUpdate, keyForPhase, type TrackingUpdateInput } from "@/lib/trackingUpdate";

function input(over: Partial<TrackingUpdateInput> = {}): TrackingUpdateInput {
  return {
    lastKey: null,
    lastLocator: null,
    currentLocator: "PQ1",
    phase: "admitido",
    ...over,
  };
}

describe("keyForPhase", () => {
  it("maps both travelling phases onto one key", () => {
    // Otherwise a parcel moving depot -> depot -> out-for-delivery emails
    // three times about a journey the customer cannot act on.
    expect(keyForPhase("en_transito")).toBe("in_transit");
    expect(keyForPhase("en_reparto")).toBe("in_transit");
  });

  it("maps the milestones customers actually ask about", () => {
    expect(keyForPhase("admitido")).toBe("accepted");
    expect(keyForPhase("entregado")).toBe("received");
    expect(keyForPhase("incidencia")).toBe("problem");
  });

  it("has no key for a phase that is not news", () => {
    expect(keyForPhase("prerregistrado")).toBeNull();
    expect(keyForPhase("sin_informacion")).toBeNull();
  });
});

describe("decideTrackingUpdate — sin_informacion is not a state", () => {
  it("neither emails nor persists when Correos knows nothing", () => {
    // Correos answers HTTP 200 with codError "3" and every field null for a
    // parcel it cannot trace. 82 of 415 live locators were in that state.
    expect(decideTrackingUpdate(input({ phase: "sin_informacion" }))).toEqual({
      notify: null,
      persist: null,
    });
  });

  it("does not overwrite a known key when the parcel goes untraceable", () => {
    // The failure this prevents: "we've lost your return", then a second email
    // when it reappears.
    const decision = decideTrackingUpdate(
      input({ phase: "sin_informacion", lastKey: "received", lastLocator: "PQ1" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("says nothing about a parcel that is only pre-registered", () => {
    expect(decideTrackingUpdate(input({ phase: "prerregistrado" }))).toEqual({
      notify: null,
      persist: null,
    });
  });
});

describe("decideTrackingUpdate — first news about a parcel", () => {
  it("notifies and persists when we have told the customer nothing", () => {
    expect(decideTrackingUpdate(input())).toEqual({
      notify: "accepted",
      persist: { lastTrackingKey: "accepted", lastTrackingLocator: "PQ1" },
    });
  });

  it("does nothing without a locator to speak of", () => {
    expect(decideTrackingUpdate(input({ currentLocator: null }))).toEqual({
      notify: null,
      persist: null,
    });
  });
});

describe("decideTrackingUpdate — the same news twice", () => {
  it("is a no-op when the key is unchanged", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "accepted", lastLocator: "PQ1", phase: "admitido" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("sends one in_transit for en_transito then en_reparto", () => {
    const first = decideTrackingUpdate(
      input({ lastKey: "accepted", lastLocator: "PQ1", phase: "en_transito" })
    );
    expect(first.notify).toBe("in_transit");

    const second = decideTrackingUpdate(
      input({ lastKey: "in_transit", lastLocator: "PQ1", phase: "en_reparto" })
    );
    expect(second).toEqual({ notify: null, persist: null });
  });
});

describe("decideTrackingUpdate — never notify backwards", () => {
  it("ignores a regression from received to in transit", () => {
    // Correos flapping must not tell a customer their delivered parcel is
    // travelling again.
    const decision = decideTrackingUpdate(
      input({ lastKey: "received", lastLocator: "PQ1", phase: "en_transito" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("ignores a regression from in transit back to accepted", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "in_transit", lastLocator: "PQ1", phase: "admitido" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("still advances forwards", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "accepted", lastLocator: "PQ1", phase: "entregado" })
    );

    expect(decision).toEqual({
      notify: "received",
      persist: { lastTrackingKey: "received", lastTrackingLocator: "PQ1" },
    });
  });
});

describe("decideTrackingUpdate — problems", () => {
  it("reports a problem whatever the parcel had reached", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "in_transit", lastLocator: "PQ1", phase: "incidencia" })
    );

    expect(decision.notify).toBe("problem");
  });

  it("reports a problem only once", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "problem", lastLocator: "PQ1", phase: "incidencia" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("lets a parcel recover and reach the warehouse after a problem", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "problem", lastLocator: "PQ1", phase: "entregado" })
    );

    expect(decision.notify).toBe("received");
  });
});

describe("decideTrackingUpdate — a new locator is a new parcel", () => {
  it("starts over when the customer re-registered", () => {
    // A re-registration is a different parcel with its own Correos code. Its
    // journey legitimately begins again at accepted.
    const decision = decideTrackingUpdate(
      input({ lastKey: "received", lastLocator: "PQ1", currentLocator: "PQ2", phase: "admitido" })
    );

    expect(decision).toEqual({
      notify: "accepted",
      persist: { lastTrackingKey: "accepted", lastTrackingLocator: "PQ2" },
    });
  });

  it("still ignores an untraceable new parcel", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "received", lastLocator: "PQ1", currentLocator: "PQ2", phase: "sin_informacion" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/trackingUpdate.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/trackingUpdate"`.

- [ ] **Step 3: Write the implementation**

Create `lib/trackingUpdate.ts`:

```ts
/**
 * Deciding whether a parcel's carrier status is worth an email.
 *
 * Pure — no db, no network, no clock, no env. Every input is passed in, because
 * this function is the only thing between an hourly poller and a customer's
 * inbox, and the difference between "useful" and "spam" is entirely in here.
 *
 * The rule the whole feature turns on: Correos answers HTTP 200 with
 * `error.codError = "3"` and every field null for a parcel it cannot trace —
 * 82 of 415 live locators were in that state at one point. `parseCorreosTracking`
 * already collapses that to `sin_informacion`. Treating it as a STATE rather
 * than as ABSENCE would email the customer that we had lost their return, then
 * email again when it reappeared.
 */
import type { TrackingPhase } from "@/lib/trackingStatus";

export type TrackingKey = "accepted" | "in_transit" | "received" | "problem";

export type TrackingUpdateInput = {
  lastKey: string | null;
  lastLocator: string | null;
  currentLocator: string | null;
  phase: TrackingPhase;
};

export type TrackingUpdateDecision = {
  notify: TrackingKey | null;
  persist: { lastTrackingKey: TrackingKey; lastTrackingLocator: string } | null;
};

/**
 * Which notification a carrier phase deserves, if any.
 *
 * `en_transito` and `en_reparto` deliberately share one key. Otherwise a parcel
 * moving depot -> depot -> out-for-delivery emails three times, and "out for
 * delivery" is a strange thing to tell someone about a parcel travelling AWAY
 * from them.
 *
 * `prerregistrado` and `sin_informacion` have no key: neither is news.
 */
export function keyForPhase(phase: TrackingPhase): TrackingKey | null {
  switch (phase) {
    case "admitido":
      return "accepted";
    case "en_transito":
    case "en_reparto":
      return "in_transit";
    case "entregado":
      return "received";
    case "incidencia":
      return "problem";
    default:
      return null;
  }
}

/** How far along the journey each key sits. `problem` is 0 so that a parcel
 *  which recovers can still announce that it arrived. */
const RANK: Record<TrackingKey, number> = {
  problem: 0,
  accepted: 1,
  in_transit: 2,
  received: 3,
};

const NOTHING: TrackingUpdateDecision = { notify: null, persist: null };

export function decideTrackingUpdate(
  input: TrackingUpdateInput
): TrackingUpdateDecision {
  const locator = input.currentLocator?.trim();
  if (!locator) return NOTHING;

  const key = keyForPhase(input.phase);
  if (!key) return NOTHING;

  // A different locator is a different parcel: its journey starts over, and
  // whatever the previous one had reached is irrelevant.
  const sameParcel = input.lastLocator?.trim() === locator;
  const lastKey = sameParcel ? (input.lastKey as TrackingKey | null) : null;

  if (key === "problem") {
    // A problem may interrupt at any point, but is worth saying once.
    if (lastKey === "problem") return NOTHING;
  } else if (lastKey && RANK[key] <= (RANK[lastKey] ?? -1)) {
    // Never notify backwards. Correos flapping must not tell a customer their
    // delivered parcel is travelling again.
    return NOTHING;
  }

  return {
    notify: key,
    persist: { lastTrackingKey: key, lastTrackingLocator: locator },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/trackingUpdate.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/trackingUpdate.ts tests/trackingUpdate.test.ts
git commit -m "feat: decide when a carrier status is worth telling the customer"
```

---

### Task 3: The email

**Files:**
- Modify: `lib/emails.ts` (append beside `buildReturnReceivedEmail`)
- Test: `tests/trackingUpdateEmail.test.ts`

**Interfaces:**
- Consumes: `TrackingKey` from `@/lib/trackingUpdate`; `Locale` and `EmailPayload` already exported from `lib/emails.ts`.
- Produces: `buildTrackingUpdateEmail(key: TrackingKey, name: string, locale: Locale): EmailPayload`.

Follow the shape of `buildReturnReceivedEmail` exactly: a `const XXX_COPY = { es: {...}, en: {...} } as const` table, then a builder that reads `COPY[locale]` and returns `{ From, To: "", Subject, TextBody, HtmlBody }`. Read that function before writing this one.

- [ ] **Step 1: Write the failing test**

Create `tests/trackingUpdateEmail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTrackingUpdateEmail } from "@/lib/emails";
import type { TrackingKey } from "@/lib/trackingUpdate";

const KEYS: TrackingKey[] = ["accepted", "in_transit", "received", "problem"];

describe("buildTrackingUpdateEmail", () => {
  it("builds a distinct message for every key, in both locales", () => {
    const subjects = new Set<string>();
    for (const key of KEYS) {
      for (const locale of ["es", "en"] as const) {
        const mail = buildTrackingUpdateEmail(key, "Aida", locale);
        expect(mail.Subject, `${key}/${locale}`).toBeTruthy();
        expect(mail.TextBody, `${key}/${locale}`).toBeTruthy();
        expect(mail.HtmlBody, `${key}/${locale}`).toContain("Aida");
        subjects.add(`${locale}:${mail.Subject}`);
      }
    }
    // Eight distinct subjects — no key silently reusing another's copy.
    expect(subjects.size).toBe(8);
  });

  it("addresses the customer by name", () => {
    const mail = buildTrackingUpdateEmail("received", "Mackenzie", "en");
    expect(mail.HtmlBody).toContain("Mackenzie");
  });

  it("leaves the recipient for the sender to fill in", () => {
    // Every builder in this file returns To: "" and the caller sets it.
    expect(buildTrackingUpdateEmail("accepted", "Aida", "es").To).toBe("");
  });

  it("does not promise a refund timeline on the received notice", () => {
    // Settlement is a separate job with its own grace period. Promising "within
    // N days" here would be a commitment this email cannot keep.
    for (const locale of ["es", "en"] as const) {
      const body = buildTrackingUpdateEmail("received", "Aida", locale).HtmlBody;
      expect(body).not.toMatch(/\d+\s*(d[íi]as|days|horas|hours)/i);
    }
  });

  it("tells a customer with a problem to contact us", () => {
    for (const locale of ["es", "en"] as const) {
      const body = buildTrackingUpdateEmail("problem", "Aida", locale).HtmlBody;
      expect(body).toContain("@");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/trackingUpdateEmail.test.ts`
Expected: FAIL — `buildTrackingUpdateEmail is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `lib/emails.ts`, after `buildReturnReceivedEmail`:

```ts
/**
 * Where the customer's return has got to.
 *
 * One builder for all four milestones rather than four near-identical ones —
 * the wrapper markup is the same in every case and only the sentences differ.
 *
 * The `received` copy deliberately promises no refund TIMELINE. Settlement is a
 * separate job with its own grace period, and a date this email cannot keep is
 * worse than no date.
 */
const TRACKING_COPY = {
  es: {
    accepted: {
      subject: "Tu devolución está en camino",
      intro: "Correos ya tiene tu paquete. A partir de aquí nos encargamos nosotros.",
    },
    in_transit: {
      subject: "Tu devolución va de camino a nuestro almacén",
      intro: "Tu paquete está en tránsito hacia nuestro almacén.",
    },
    received: {
      subject: "Hemos recibido tu devolución",
      intro:
        "Tu devolución ya ha llegado a nuestro almacén y la estamos revisando. Te avisaremos en cuanto esté procesada.",
    },
    problem: {
      subject: "Incidencia con tu devolución",
      intro:
        "Ha habido una incidencia con el envío de tu devolución y necesitamos revisarlo contigo.",
    },
  },
  en: {
    accepted: {
      subject: "Your return is on its way",
      intro: "The carrier has your parcel. We'll take it from here.",
    },
    in_transit: {
      subject: "Your return is heading to our warehouse",
      intro: "Your parcel is in transit to our warehouse.",
    },
    received: {
      subject: "We've received your return",
      intro:
        "Your return has arrived at our warehouse and we're checking it now. We'll let you know once it's processed.",
    },
    problem: {
      subject: "There's a problem with your return",
      intro:
        "Something went wrong with your return shipment and we need to look into it with you.",
    },
  },
} as const;

const TRACKING_TAIL = {
  es: {
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    contact: `Si tienes alguna pregunta, escríbenos a ${MAILTO}.`,
    signoff: "Saludos,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    contact: `If you have any questions, contact us at ${MAILTO}.`,
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildTrackingUpdateEmail(
  key: "accepted" | "in_transit" | "received" | "problem",
  name: string,
  locale: Locale
): EmailPayload {
  const c = TRACKING_COPY[locale][key];
  const t = TRACKING_TAIL[locale];
  const p = 'style="font-size:16px;color:#555;"';

  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.intro,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div>
          <p ${p}>${t.greeting(name)}</p>
          <p ${p}>${c.intro}</p>
          <p ${p}>${t.contact}</p>
          <p ${p}>${t.signoff}</p>
        </div>
      </div>`,
  };
}
```

`MAILTO`, `FROM` and `EmailPayload` are defined earlier in `lib/emails.ts`, and `Locale` is imported there from `@/lib/i18n` (`lib/emails.ts:9`). All four are already in scope — do not redefine or re-import them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/trackingUpdateEmail.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/emails.ts tests/trackingUpdateEmail.test.ts
git commit -m "feat: customer email for each return tracking milestone"
```

---

### Task 4: The work-list query

**Files:**
- Modify: `db/queries.ts` (append, beside `getOrdersWithUnsettledReturns`)

**Interfaces:**
- Produces: `getParcelsAwaitingTracking()` — every order with a locator and at least one confirmed, unsettled line, ordered oldest first by `orders.id`, with `products` narrowed to confirmed lines.

No test of its own: it is a Drizzle query with no branching, and Task 5's route test exercises it through a mock. A test here would test Drizzle.

- [ ] **Step 1: Write the implementation**

Append to `db/queries.ts`:

```ts
/**
 * Parcels whose journey is still worth watching.
 *
 * A locator to look up, and at least one confirmed line not yet settled — once
 * a return is paid there is nothing left to tell the customer about it.
 *
 * Deliberately NOT cached, for the same reason as `getOrderByIdFresh`: the
 * tracking sweep acts on what it reads and writes back in the same pass.
 *
 * Ordered by `orders.id` — the raw Shopify order id, sequential across every
 * lane — so a capped run reaches the customers who have waited longest and
 * behaves the same on every run.
 */
export async function getParcelsAwaitingTracking() {
  const rows = await db.query.orders.findMany({
    where: isNotNull(orders.locator),
    orderBy: (o, { sql }) => [sql`${o.id} asc`],
    with: { products: { where: eq(productsOrder.confirmed, true) } },
  });
  return rows.filter(
    (order) => order.products.length > 0 && order.products.some((p) => !p.refunded)
  );
}
```

`isNotNull` is already imported at the top of `db/queries.ts`.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: clean; 818 tests passing (796 baseline + 17 from Task 2 + 5 from Task 3 — this task adds none).

- [ ] **Step 3: Commit**

```bash
git add db/queries.ts
git commit -m "feat: query parcels whose tracking is still worth watching"
```

---

### Task 5: The cron route

**Files:**
- Create: `app/api/cron/tracking-sync/route.ts`
- Test: `tests/trackingSyncRoute.test.ts`

**Interfaces:**
- Consumes: `decideTrackingUpdate` (Task 2), `buildTrackingUpdateEmail` (Task 3), `getParcelsAwaitingTracking` (Task 4), plus the existing `obtainLastStatus` from `@/actions/shipping`, `isInternationalOrder` from `@/lib/countries`, `readLocale` from `@/lib/i18n`, `alertOps` from `@/actions/opsAlert`.
- Produces: `GET(req: Request)` returning `{ scanned, notified, skipped, capped, dry }`.

Read `app/api/cron/amphora-sync/route.ts` first for the `authorized()` shape and the `maxDuration` / `dynamic` exports, and `tests/autoApproveRoute.test.ts` for the route-test mocking style.

- [ ] **Step 1: Write the failing test**

Create `tests/trackingSyncRoute.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// This route emails customers unattended. It is PUBLIC — middleware.ts matches
// only /dashboard and /login — so CRON_SECRET is the only thing in front of it,
// and an unset secret must close it rather than open it.
//
// It must also be DRY by default: an operator who deploys without setting
// TRACKING_EMAILS_ENABLED gets a report, not a burst of mail to 82 customers.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const state = {
  orders: [] as any[],
  status: {} as Record<string, { label: string; phase: string }>,
  lookupThrowsOn: null as string | null,
};
const sent: Array<{ to: string; subject: string }> = [];
const persisted: Array<{ id: string; key: string; locator: string }> = [];
const alerts: string[] = [];

vi.mock("@/db/queries", () => ({
  getParcelsAwaitingTracking: async () => state.orders,
}));
vi.mock("@/actions/shipping", () => ({
  obtainLastStatus: async (loc: string) => {
    if (state.lookupThrowsOn === loc) throw new Error("correos down");
    return state.status[loc] ?? { label: "Sin información", phase: "sin_informacion" };
  },
}));
vi.mock("@/lib/emails", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    buildTrackingUpdateEmail: (key: string) => ({
      From: "f@x", To: "", Subject: `SUBJ:${key}`, TextBody: "t", HtmlBody: "h",
    }),
  };
});
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => { alerts.push(subject); },
}));

// The route persists through drizzle and sends through Postmark; both are
// captured so the tests assert on real effects rather than on mock shape.
vi.mock("axios", () => ({
  default: {
    post: async (_url: string, payload: any) => {
      sent.push({ to: payload.To, subject: payload.Subject });
      return { status: 200 };
    },
  },
}));

function order(id: string, locator: string, over: any = {}) {
  return {
    id, orderNumber: `#${id}`, email: `c${id}@example.com`, shippingName: `Cust ${id}`,
    shippingCountry: "Spain", locale: "es", locator,
    lastTrackingKey: null, lastTrackingLocator: null,
    products: [{ id: `p${id}`, confirmed: true, refunded: false }],
    ...over,
  };
}

async function call(headers: Record<string, string> = {}, query = "") {
  const { GET } = await import("@/app/api/cron/tracking-sync/route");
  return GET(new Request(`https://x.test/api/cron/tracking-sync${query}`, { headers }));
}

beforeEach(() => {
  sent.length = 0; persisted.length = 0; alerts.length = 0;
  state.orders = [order("1001", "PQ1")];
  state.status = { PQ1: { label: "Admitido", phase: "admitido" } };
  state.lookupThrowsOn = null;
  process.env.CRON_SECRET = "s3cret";
  process.env.TRACKING_EMAILS_ENABLED = "true";
  process.env.POSTMARK_SERVER_TOKEN = "tok";
  delete process.env.TRACKING_MAX_EMAILS_PER_RUN;
});

describe("tracking-sync cron — authorisation", () => {
  it("401s when no secret is configured, rather than running open", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ authorization: "Bearer anything" });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("401s on a wrong bearer", async () => {
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("401s when the header is missing entirely", async () => {
    expect((await call()).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});

describe("tracking-sync cron — notifying", () => {
  it("emails the customer when a parcel reaches a new milestone", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toEqual([{ to: "c1001@example.com", subject: "SUBJ:accepted" }]);
    expect(body.notified).toBe(1);
  });

  it("says nothing about a parcel Correos cannot trace", async () => {
    state.status = { PQ1: { label: "Sin información", phase: "sin_informacion" } };
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(0);
    expect(body.notified).toBe(0);
  });

  it("does not repeat a milestone already sent", async () => {
    state.orders = [order("1001", "PQ1", { lastTrackingKey: "accepted", lastTrackingLocator: "PQ1" })];
    await call({ authorization: "Bearer s3cret" });
    expect(sent).toHaveLength(0);
  });

  it("skips international parcels — those ride on amphora-sync", async () => {
    state.orders = [order("1001", "PQ1", { shippingCountry: "France" })];
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(0);
    expect(body.skipped).toBeGreaterThan(0);
  });

  it("alerts ops as well as the customer on a problem", async () => {
    state.status = { PQ1: { label: "Incidencia", phase: "incidencia" } };
    await call({ authorization: "Bearer s3cret" });
    expect(sent[0].subject).toBe("SUBJ:problem");
    expect(alerts.join(" ")).toContain("#1001");
  });
});

describe("tracking-sync cron — throttles", () => {
  it("is DRY when TRACKING_EMAILS_ENABLED is unset — a deploy alone mails nobody", async () => {
    delete process.env.TRACKING_EMAILS_ENABLED;
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(0);
    expect(body.dry).toBe(true);
    expect(body.notified).toBe(1); // reports what it WOULD have sent
  });

  it("is DRY on ?dry=1 even when enabled", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" }, "?dry=1")).json();
    expect(sent).toHaveLength(0);
    expect(body.dry).toBe(true);
  });

  it("stops at the per-run email cap", async () => {
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2"), order("1003", "PQ3")];
    state.status = {
      PQ1: { label: "Admitido", phase: "admitido" },
      PQ2: { label: "Admitido", phase: "admitido" },
      PQ3: { label: "Admitido", phase: "admitido" },
    };
    process.env.TRACKING_MAX_EMAILS_PER_RUN = "2";
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(2);
    expect(body.capped).toBe(true);
  });
});

describe("tracking-sync cron — resilience", () => {
  it("keeps going after one parcel's lookup throws", async () => {
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2")];
    state.status = { PQ2: { label: "Admitido", phase: "admitido" } };
    state.lookupThrowsOn = "PQ1";
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toEqual([{ to: "c1002@example.com", subject: "SUBJ:accepted" }]);
    expect(body.notified).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/trackingSyncRoute.test.ts`
Expected: FAIL — cannot resolve `@/app/api/cron/tracking-sync/route`.

- [ ] **Step 3: Write the implementation**

Create `app/api/cron/tracking-sync/route.ts`:

```ts
import { NextResponse } from "next/server";
import axios from "axios";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders as ordersTable } from "@/db/schema";
import { getParcelsAwaitingTracking } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import { decideTrackingUpdate } from "@/lib/trackingUpdate";
import { buildTrackingUpdateEmail } from "@/lib/emails";
import { isInternationalOrder } from "@/lib/countries";
import { readLocale } from "@/lib/i18n";
import { alertOps } from "@/actions/opsAlert";

/**
 * Tell customers where their return has got to.
 *
 * A customer books a return, gets a label, and then hears nothing — for a
 * domestic return that is literally one email at booking and silence after.
 * This closes that gap by reading Correos hourly and emailing on milestones.
 *
 * DOMESTIC ONLY. International parcels are already polled every 15 minutes by
 * `amphora-sync`, which owns their notifications; doing it here too would
 * double-send.
 *
 * DRY BY DEFAULT: `TRACKING_EMAILS_ENABLED` must be exactly "true" before a
 * single message goes out, so deploying this route mails nobody.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret =
 *  closed, never open — this route emails customers. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Empty and whitespace fall back, because `Number("")` is 0 and a cap of zero
 *  or a silent default is not what an operator who left a box blank meant. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function sendEmail(payload: Record<string, unknown>): Promise<number> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return 500;
  try {
    const res = await axios.post(POSTMARK_API_URL, payload, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
    });
    return res.status;
  } catch (error: any) {
    console.error("[tracking-sync] email error:", error?.response?.data || error?.message);
    return 500;
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dry =
    url.searchParams.get("dry") === "1" ||
    process.env.TRACKING_EMAILS_ENABLED !== "true";
  const cap = intEnv("TRACKING_MAX_EMAILS_PER_RUN", 20);

  const parcels = await getParcelsAwaitingTracking();

  let scanned = 0;
  let notified = 0;
  let skipped = 0;
  let capped = false;

  for (const order of parcels as any[]) {
    if (notified >= cap) {
      capped = true;
      break;
    }

    // International parcels belong to amphora-sync. Notifying here as well
    // would send two emails for one milestone.
    if (isInternationalOrder(order.shippingCountry)) {
      skipped += 1;
      continue;
    }

    scanned += 1;

    try {
      const status = await obtainLastStatus(order.locator);
      const decision = decideTrackingUpdate({
        lastKey: order.lastTrackingKey ?? null,
        lastLocator: order.lastTrackingLocator ?? null,
        currentLocator: order.locator ?? null,
        phase: status.phase,
      });

      if (!decision.notify || !decision.persist) continue;

      notified += 1;
      if (dry) {
        console.log(
          `[tracking-sync] WOULD notify ${order.orderNumber}: ${decision.notify}`
        );
        continue;
      }

      // Persist BEFORE emailing. The next hourly run then finds the key
      // unchanged and does nothing, so nobody can be told twice. The cost is
      // that a failed send is not retried — hence the loud log below.
      await db
        .update(ordersTable)
        .set(decision.persist)
        .where(eq(ordersTable.id, order.id));

      const built = buildTrackingUpdateEmail(
        decision.notify,
        order.shippingName,
        readLocale(order.locale)
      );
      const status_ = await sendEmail({
        ...built,
        To: order.email,
        MessageStream: "outbound",
      });
      if (status_ !== 200) {
        console.error(
          `[tracking-sync] ${order.orderNumber}: state saved as ${decision.notify} but the email FAILED (${status_}). Customer needs a manual notice.`
        );
      }

      // A problem is the one state where a human has to act. #310664 sat
      // stranded for three weeks while a log line repeated every 15 minutes.
      if (decision.notify === "problem") {
        await alertOps(
          `[returns] TRACKING INCIDENT — order ${order.orderNumber}`,
          [
            `Correos reports an incident for ${order.orderNumber} (${order.locator}).`,
            `Status: ${status.label}`,
            `The customer has been emailed. Someone needs to find out what happened to the parcel.`,
          ].join("\n")
        );
      }
    } catch (error: any) {
      // One parcel must not stop the sweep — the rest are still owed their news.
      console.error(
        `[tracking-sync] ${order.orderNumber} failed:`,
        error?.message || error
      );
    }
  }

  return NextResponse.json({ scanned, notified, skipped, capped, dry });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/trackingSyncRoute.test.ts`
Expected: PASS, 12 tests.

Then: `npm test` → 830 passing. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/tracking-sync/route.ts tests/trackingSyncRoute.test.ts
git commit -m "feat: hourly cron emailing customers on return tracking milestones"
```

---

### Task 6: The international lane's two extra milestones

**Files:**
- Modify: `lib/amphoraWebhook.ts` (`decideWebhookActions`)
- Modify: `actions/amphoraStatusSync.ts` (the email switch)
- Test: `tests/amphoraWebhook.test.ts` (extend — this file already exists)

**Interfaces:**
- Consumes: `buildTrackingUpdateEmail` (Task 3).
- Produces: `WebhookEmail` gains two members, `"trackingInTransit"` and `"trackingProblem"`.

`collectionScheduled` and `returnReceived` stay exactly as they are — they already fire at the `accepted` and `received` moments, and adding parallel emails there would double-send.

- [ ] **Step 1: Write the failing test**

Append to `tests/amphoraWebhook.test.ts`:

```ts
describe("decideWebhookActions — the two milestones international was missing", () => {
  it("announces TRAVELLING once", () => {
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: "1Z1" },
      { id: "SHP 1", name: "#1", internal_status: "TRAVELLING" } as any
    );
    expect(actions.emails).toContain("trackingInTransit");
  });

  it("does not re-announce TRAVELLING on an unchanged status", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z1" },
      { id: "SHP 1", name: "#1", internal_status: "TRAVELLING" } as any
    );
    expect(actions.noop).toBe(true);
  });

  it("reports every exception shape as a problem", () => {
    for (const status of ["EXCEPTION", "EXCEPTION_WAREHOUSE", "EXCEPTION_HOLD", "FINISHED_REJECTED"]) {
      const actions = decideWebhookActions(
        { returnStatus: "TRAVELLING", locator: "1Z1" },
        { id: "SHP 1", name: "#1", internal_status: status } as any
      );
      expect(actions.emails, status).toContain("trackingProblem");
    }
  });

  it("still sends returnReceived, and does NOT add a second arrival email", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z1" },
      { id: "SHP 1", name: "#1", internal_status: "RECEIVED" } as any
    );
    expect(actions.emails).toContain("returnReceived");
    expect(actions.emails).not.toContain("trackingInTransit");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/amphoraWebhook.test.ts`
Expected: FAIL — `trackingInTransit` is not among the emitted emails.

- [ ] **Step 3: Write the implementation**

In `lib/amphoraWebhook.ts`, widen the `WebhookEmail` type to include `"trackingInTransit"` and `"trackingProblem"`, then extend the email decisions at the end of `decideWebhookActions` (leaving the existing two untouched):

```ts
  // The two milestones the international lane never had. `collectionScheduled`
  // and `returnReceived` already cover the accepted and received moments, so
  // adding parallel emails there would send two messages for one milestone.
  if (status === "TRAVELLING") emails.push("trackingInTransit");
  if (
    status === "EXCEPTION" ||
    status === "EXCEPTION_WAREHOUSE" ||
    status === "EXCEPTION_HOLD" ||
    status === "FINISHED_REJECTED"
  ) {
    emails.push("trackingProblem");
  }
```

In `actions/amphoraStatusSync.ts`, extend the builder switch so the two new keys build their message through `buildTrackingUpdateEmail`:

```ts
    const built =
      email === "collectionScheduled"
        ? buildCollectionScheduledEmail(
            order.shippingName,
            locale,
            { number: payload.carrier_number, url: payload.carrier_url },
            exchange
          )
        : email === "trackingInTransit"
          ? buildTrackingUpdateEmail("in_transit", order.shippingName, locale)
          : email === "trackingProblem"
            ? buildTrackingUpdateEmail("problem", order.shippingName, locale)
            : buildReturnReceivedEmail(order.shippingName, locale, exchange);
```

Add `buildTrackingUpdateEmail` to that file's import from `@/lib/emails`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/amphoraWebhook.test.ts tests/amphoraStatusSync.test.ts tests/amphoraSyncRoute.test.ts`
Expected: PASS. These three exercise the status-sync path end to end; if any pre-existing case fails, the change altered behaviour it should not have — stop and report rather than editing the test.

Then: `npm test` → 834 passing. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/amphoraWebhook.ts actions/amphoraStatusSync.ts tests/amphoraWebhook.test.ts
git commit -m "feat: in-transit and problem notices for international returns"
```

---

### Task 7: Seed the existing parcels, then schedule

Seeding is a deploy step, not runtime magic. The alternative — treating a null key as "seed silently" inside the cron — would swallow the `accepted` email for every genuinely new return, forever.

**Files:**
- Create: `scripts/seed-tracking-state.ts`
- Modify: `vercel.json`
- Modify: `README.md`

- [ ] **Step 1: Write the seeding script**

Create `scripts/seed-tracking-state.ts`:

```ts
/**
 * Record where every live parcel currently is, WITHOUT emailing anyone.
 *
 * Run once, before the tracking-sync cron is enabled. Without it the first run
 * sees ~82 parcels with no recorded state and treats each one's current
 * position as fresh news — telling customers their parcel was accepted by the
 * carrier three weeks ago.
 *
 * Dry by default; pass APPLY=1 to write.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders as ordersTable } from "@/db/schema";
import { getParcelsAwaitingTracking } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import { keyForPhase } from "@/lib/trackingUpdate";
import { isInternationalOrder } from "@/lib/countries";

const APPLY = process.env.APPLY === "1";

(async () => {
  const parcels = await getParcelsAwaitingTracking();
  let seeded = 0;
  let noNews = 0;

  for (const order of parcels as any[]) {
    if (isInternationalOrder(order.shippingCountry)) continue;
    if (order.lastTrackingKey) continue;

    const status = await obtainLastStatus(order.locator);
    const key = keyForPhase(status.phase);
    if (!key) {
      // Correos has nothing on it. Leave the state null so the first real
      // movement is treated as news, which it will be.
      noNews += 1;
      continue;
    }

    console.log(`${order.orderNumber}  ${order.locator}  ${status.label} -> ${key}`);
    seeded += 1;
    if (!APPLY) continue;

    await db
      .update(ordersTable)
      .set({ lastTrackingKey: key, lastTrackingLocator: order.locator })
      .where(eq(ordersTable.id, order.id));
  }

  console.log(`\nwould seed: ${seeded}   no news from Correos: ${noNews}`);
  if (!APPLY) console.log("DRY RUN — nothing written. APPLY=1 to write.");
})().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exit(1);
});
```

Add to `package.json` scripts: `"seed-tracking-state": "tsx scripts/seed-tracking-state.ts"`.

- [ ] **Step 2: Run it dry and read the output**

Run: `npm run seed-tracking-state`
Expected: a line per live domestic parcel with its current phase and the key it maps to, then a DRY RUN notice. Confirm the keys look sane before applying — this is the last human check before the cron starts mailing people.

- [ ] **Step 3: Add the schedule**

Edit `vercel.json`, keeping both existing entries untouched:

```json
{
  "crons": [
    { "path": "/api/cron/amphora-sync", "schedule": "*/15 * * * *" },
    { "path": "/api/cron/auto-approve", "schedule": "0 7 * * *" },
    { "path": "/api/cron/tracking-sync", "schedule": "0 * * * *" }
  ]
}
```

Hourly. A parcel changes phase a handful of times in its life, and nobody needs to hear about it within the quarter hour.

- [ ] **Step 4: Document the environment variables**

Add to the environment-variable table in `README.md`, matching its existing formatting:

```markdown
| `TRACKING_EMAILS_ENABLED` | Set to `true` to let the hourly tracking cron actually email customers. Anything else (including unset) makes it a dry run that logs what it would have sent. |
| `TRACKING_MAX_EMAILS_PER_RUN` | Emails sent per hourly run. Default `20`. A backstop in case the seeding script was never run. |
```

- [ ] **Step 5: Verify and commit**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all green, 834 passing.

```bash
git add scripts/seed-tracking-state.ts package.json vercel.json README.md
git commit -m "chore: seed tracking state and schedule the hourly sweep, dry until enabled"
```

- [ ] **Step 6: The live sequence (for whoever deploys)**

Order matters and is not negotiable:

1. Apply the Task 1 migration to production. **DDL before deploy.**
2. Deploy. `TRACKING_EMAILS_ENABLED` is unset, so the cron runs and mails nobody.
3. Read one dry run's output.
4. Run `APPLY=1 npm run seed-tracking-state` against production.
5. Only then set `TRACKING_EMAILS_ENABLED=true` and redeploy.

Skipping step 4 is what the per-run cap exists to survive.

---

## Self-review

**Spec coverage.** State columns → Task 1. Notification keys and the decision rules → Task 2. Email copy → Task 3. Work-list → Task 4. Hourly cron with kill switch, cap and dry-run → Task 5. International's two extra milestones → Task 6. Seeding, schedule, docs and deploy order → Task 7. `problem` alerting ops → Task 5 Step 3. Every "not in scope" item is absent from every task.

**One addition beyond the spec.** The spec did not state a rule for a *regression* (a parcel that reads `entregado` and later reads `en_transito` because Correos flapped). Task 2 adds rank ordering so notifications only move forwards, with `problem` exempt. Without it the feature would email a customer that their delivered return was travelling again. Flagged here because it is a real behavioural decision the spec left open.

**Type consistency.** `TrackingKey` as defined in Task 2 is consumed unchanged in Tasks 3, 5, 6 and 7. `decideTrackingUpdate`'s `{ notify, persist }` shape is consumed as written in Task 5. `getParcelsAwaitingTracking` returns rows carrying `id`, `orderNumber`, `email`, `shippingName`, `locale`, `locator`, `lastTrackingKey`, `lastTrackingLocator` and `products` — every field Task 5 reads.

**Known gap, accepted.** Task 5's test mocks `obtainLastStatus`, so no test exercises a real Correos payload end to end. `tests/trackingStatus.test.ts` already pins `parseCorreosTracking` against captured live responses, which is where that coverage belongs.

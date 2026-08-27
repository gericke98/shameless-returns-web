# Telling customers where their return is

**Date:** 2026-08-27
**Status:** design, approved for planning
**Branch base:** `main` (`2b04675`)

## The problem

A customer books a return, receives a label, and then hears nothing.

That is not a figure of speech. For a domestic return it is literally one email
at booking and silence thereafter, for two independent reasons:

- `collectionScheduled` is gated on `!order.locator` (`lib/amphoraWebhook.ts:100`).
  We write the Correos code ourselves *before* Amphora ever sees the parcel, so
  that branch can never fire for a Spanish customer.
- `returnReceived` fires from `amphora-sync`, which skips every domestic order
  (`app/api/cron/amphora-sync/route.ts:129`) to avoid overwriting Correos
  tracking.

Two live cases motivated this, on the same day:

- **#311407 (Aida, Spain).** Her hoodie reached the warehouse on 2026-08-25 at
  12:06. Amphora recorded `quantity_received: 1`. She was never told, and
  emailed asking whether her store credit had been issued.
- **#310664 (Mackenzie, Portugal).** Amphora approved the return on 2026-08-04
  and never assigned a carrier. Three weeks later she asked why there was no
  tracking link. There was no tracking link because no collection was ever
  booked — and nothing told her.

## What we are building

An hourly cron that reads each live parcel's carrier status and emails the
customer when it reaches a new milestone.

## What the investigation established

Measured against live data on 2026-08-26.

### The feature is 94% a Correos poller

| | parcels with a locator |
|---|---|
| Domestic (Correos) | **466** |
| International (Amphora) | 30 |

Live set — unsettled and carrying a locator — is **98, of which 82 are
domestic.** Polling that set hourly is ~2,000 Correos lookups/day.

International parcels are already polled every 15 minutes by `amphora-sync`, so
that lane costs nothing new. Domestic tracking today is fetched **in the
browser** by `app/api/shipping-status/route.ts` when someone opens the
dashboard. There is no server-side Correos read anywhere.

### The two lanes cannot offer the same granularity

Domestically we read Correos directly and see real scans. Internationally we
hold a `carrier_url` for DHL/UPS but never poll those carriers — all we have is
Amphora's own `internal_status`. So "every tracking movement" means genuine
carrier scans in Spain and coarse warehouse-lifecycle steps everywhere else.
The copy must not promise what the international lane cannot deliver.

### One order is one parcel

`return_labels` holds 30 rows across 30 orders, with no order carrying more than
one. Per-parcel state can therefore live as columns on `orders` rather than
needing a new table.

## Design

### 1. State: two columns on `orders`

```
last_tracking_key      text   -- notification already sent
last_tracking_locator  text   -- the parcel that key refers to
```

`last_tracking_locator` is not redundant. A re-registration produces a **new**
parcel with a new Correos code, whose journey legitimately starts over. Without
it, the new parcel's `accepted` notice would be suppressed because the old
parcel had already passed that milestone. `return_labels`'s own comment records
that a re-registration is a different parcel and gets its own row.

### 2. Notification keys, not raw phases

Deduping on the key rather than the carrier's wording is what keeps this from
becoming spam. Correos says "En tránsito", "Clasificado" and "En tratamiento"
for the same thing; `lib/trackingStatus.ts` already collapses them to one phase.

| key | domestic phase | international status |
|---|---|---|
| `accepted` | `admitido` | carrier assigned |
| `in_transit` | `en_transito` **or** `en_reparto` | `TRAVELLING` |
| `received` | `entregado` | `RECEIVED` |
| `problem` | `incidencia` | `EXCEPTION*`, `FINISHED_REJECTED` |

`en_transito` and `en_reparto` collapse into one key deliberately. Otherwise a
parcel moving depot → depot → out-for-delivery emails three times, and "out for
delivery" is a strange thing to tell someone about a parcel travelling *away*
from them.

**International keeps `collectionScheduled` and `returnReceived` as they are.**
Those already fire at the `accepted` and `received` moments; adding a second
email at the same instant would double-send. The international lane gains only
`in_transit` and `problem`. The consequence, accepted knowingly: a Spanish and a
French customer receive differently-worded mail at the same milestone.

### 3. The decision function — `lib/trackingUpdate.ts`

Pure: no db, no network, no clock, no env. Everything is passed in.

```
decideTrackingUpdate({ lastKey, lastLocator, currentLocator, status })
  -> { notify: Key | null, persist: { lastTrackingKey, lastTrackingLocator } | null }
```

Rules, in order:

1. **`sin_informacion` → nothing.** No email, no persist. This is the rule the
   whole feature turns on. Correos answers HTTP 200 with `error.codError = "3"`
   and every field null for a parcel it cannot trace; 82 of 415 live locators
   were in that state at one point. If absence counted as a change, a parcel
   Correos briefly loses would email the customer that we had lost track of it,
   then email again when it reappeared. `parseCorreosTracking` already returns
   `UNKNOWN_TRACKING` for this; the poller must treat it as *no news*, never as
   a state.
2. **Locator differs from `last_tracking_locator`** → reset, then evaluate the
   fresh status from scratch.
3. **Key unchanged** → no-op.
4. **Persist before emailing.** A retry or the next hourly run then finds the
   key unchanged and does nothing, so nobody can be emailed twice. The cost is
   that a failed send is not retried — hence a loud log, exactly the trade-off
   `actions/amphoraStatusSync.ts` already documents.

### 4. `/api/cron/tracking-sync`, hourly

- `CRON_SECRET`-gated; unset secret = closed, matching the other two crons.
- `?dry=1` reports what it would send and writes nothing.
- `TRACKING_EMAILS_ENABLED` kill switch, flippable without a deploy.
- **A per-run email cap (default 20).** This is a backstop against the seeding
  step below being skipped: the difference between 20 wrong emails and 82.
- One parcel failing must not stop the sweep. Per-parcel try/catch.
- Runs hourly, not every 15 minutes: a parcel changes phase a handful of times
  in its life, and nobody needs to hear about it within the quarter hour.

Separate from `amphora-sync` on purpose. A Correos outage must not take down the
Amphora status sync that stranded-return detection depends on, nor the
auto-approve job.

### 5. Seeding is a deploy step, not runtime magic

A one-off script writes every live parcel's current key with **no email sent**.
The cron's rule is then simply "no key yet → this is new → notify".

The alternative — treating a null key as "seed silently" at runtime — would
swallow the `accepted` email for every genuinely new return, forever. Making
seeding explicit costs one script and keeps the runtime rule honest.

### 6. `problem` alerts ops as well as the customer

`incidencia` sends the customer email **and** calls `alertOps`. It is the one
state where a human needs to act. #310664 sat stranded for three weeks while
`amphora-sync` logged it every 15 minutes and nobody read the logs.

### 7. Email copy

One builder, `buildTrackingUpdateEmail(key, name, locale, exchange)`, following
the existing builders in `lib/emails.ts` and localised through `readLocale` like
every other customer email. Four short messages. The `received` copy must not
promise a refund timeline — settlement is a separate job with its own grace
period.

## Testing

Pure, against `lib/trackingUpdate.ts`:

- `sin_informacion` neither emails nor persists, and does not overwrite a known key
- an unchanged key is a no-op
- `en_transito` then `en_reparto` produces exactly one `in_transit`
- a changed locator resets and re-notifies from `accepted`
- an unrecognised carrier wording (which maps to `sin_informacion`) is silent

Integration, against the route with Correos, the db and Postmark mocked:

- unset `CRON_SECRET` → 401
- `?dry=1` sends nothing and writes nothing
- the per-run cap is respected and the remainder is untouched
- one parcel throwing does not stop the sweep
- a parcel whose key was written between read and send is not re-sent

## Explicitly not in scope

- Polling DHL/UPS directly. International granularity stays at Amphora's
  `internal_status`.
- Changing `collectionScheduled` or `returnReceived`.
- SMS, push, or any channel other than email.
- Tracking updates for the outbound leg of an exchange. This is about the parcel
  coming back to us.

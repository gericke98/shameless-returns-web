import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The endpoints the BUILD actually registered (F1 spec §Enforcement), checked
// after `next build`. Every export of a "use server" module is a public POST
// endpoint, and an inline handler becomes one more (`$$ACTION_n`), so the
// source rules are only half the proof: this reads what Next generated.
//
// Format on Next 14.2.4 (confirmed against a real build): the minified action
// entry loader carries no module paths, so the readable source of truth is
// `.next/server/server-reference-manifest.json`, `node: { <actionId>: … }`,
// where actionId = sha1("<absolute module path>:<export name>") — the hash
// next-flight-loader's server-reference transform emits. The test hashes the
// approved list and asserts the key set is EQUAL to it: an extra endpoint
// (a new export, an inline `$$ACTION_n`, a stray "use server") is a foreign
// key, and a missing one is a missing key.

const ROOT = resolve(__dirname, "..");
const MANIFEST = resolve(ROOT, ".next/server/server-reference-manifest.json");

/** The approved list, spec §4: module → its action exports. */
const APPROVED: Record<string, string[]> = {
  "actions/return.ts": ["submitReturn"],
  "actions/lines.ts": ["setLineSelection", "clearLineSelection"],
  "actions/address.ts": ["saveAddress"],
  "actions/tracking.ts": ["submitTracking"],
  "actions/cancelReturn.ts": ["cancelReturn"],
  "actions/refund.ts": ["settleRow"],
  "actions/shippingFees.ts": ["saveShippingFee"],
  "actions/selfTrackingReview.ts": ["confirmSelfTracking", "rejectSelfTracking"],
  "actions/order.ts": ["lookupOrder"],
  "actions/locale.ts": ["setLocale"],
};

const actionId = (file: string, name: string) =>
  createHash("sha1").update(`${resolve(ROOT, file)}:${name}`).digest("hex");

describe.skipIf(!existsSync(MANIFEST))("the built server-action endpoints", () => {
  it("are exactly the approved list", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const built = Object.keys(manifest.node ?? {}).sort();
    const expected = new Map<string, string>();
    for (const [file, names] of Object.entries(APPROVED)) {
      for (const name of names) expected.set(actionId(file, name), `${file}#${name}`);
    }

    const unexpected = built.filter((id) => !expected.has(id));
    const missing = Array.from(expected).filter(([id]) => !built.includes(id)).map(([, label]) => label);
    expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] });
    expect(manifest.edge ?? {}).toEqual({});
  });
});

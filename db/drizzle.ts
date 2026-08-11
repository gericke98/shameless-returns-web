import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

// Connect drizzle to the neon db.
//
// `cache: "no-store"` is load-bearing. The Neon serverless driver speaks HTTP
// over `fetch`, and Next.js replaces global fetch with one that caches. Every
// query this app runs is the same POST to the same URL, so identical SELECTs
// were served from the Data Cache and the app read a frozen snapshot of the
// database.
//
// It surfaced in `/api/cron/amphora-sync`, which is the only caller that reads
// repeatedly over a long life and acts on what it reads:
//
//   [amphora-sync][diag] #310905: read returnStatus=null
//     locator="1Z3EF3229113605089" vs amphora="TRAVELLING"
//
// `locator` was written when the return was created, before that query was
// first cached; `returnStatus` was written afterwards and never appeared. The
// same query from a local process returned TRAVELLING throughout. So the poller
// decided the status had changed on every single run, and `returnReceived` —
// guarded by nothing but that comparison — would have emailed the customer
// every fifteen minutes once a return reached RECEIVED.
const sql = neon(process.env.DATABASE_URL!, {
  fetchOptions: { cache: "no-store" },
});
const db = drizzle(sql, { schema });

export default db;

/**
 * S3 R3 precondition — READS Stripe, writes nothing.
 *
 * The webhook's path for a checkout session that names no submission is
 * deleted in S3: a payment on such a session confirms nothing and raises a
 * `payment-unbound:<session>` alert. That is only safe once no such session
 * can still be paid. Sessions live at most 24 h and S1 (which stamps
 * `metadata.submission_id` on every new session) deployed on 2026-10-30.
 *
 * This lists every OPEN checkout session and names those whose metadata has
 * no submission_id — read with the webhook's own parser. It exits 1 if there
 * is any: do not deploy R3 until it prints zero, and record the output in the
 * PR.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/check-legacy-stripe-sessions.ts
 */
import "dotenv/config";

async function main() {
  const { stripe } = await import("@/lib/stripe");
  const { unboundSessions } = await import("@/lib/checkoutMetadata");
  const open: Array<{ id: string; metadata: Record<string, string> | null; created: number; expires_at: number }> = [];
  for await (const session of stripe.checkout.sessions.list({ status: "open", limit: 100 })) {
    open.push({
      id: session.id,
      metadata: (session.metadata ?? null) as Record<string, string> | null,
      created: session.created,
      expires_at: session.expires_at,
    });
  }
  const unbound = unboundSessions(open);
  console.log(`open checkout sessions: ${open.length}; without metadata.submission_id: ${unbound.length}`);
  for (const s of unbound) {
    console.log(
      `  ${s.id} order=${s.metadata?.id ?? "(none)"} created=${new Date(s.created * 1000).toISOString()} ` +
        `expires=${new Date(s.expires_at * 1000).toISOString()}`
    );
  }
  if (unbound.length > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

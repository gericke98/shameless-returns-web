// Browser crash telemetry. Public on purpose — a customer who just crashed has
// no other way to tell us — so nothing in the body is trusted:
//
//  - Every report is logged as one `[client-error]` JSON line. Search the
//    Vercel logs for it; when `digest` is set, search for the digest too to
//    get the server-side stack of the action or render that failed.
//  - Vercel keeps those logs about a day, so a crash screen a CUSTOMER saw
//    (`kind: "boundary"` with a valid portal session) is also queued as a
//    durable ops alert. The order comes from the signed session cookie, never
//    the body, and the key allows one alert per order per hour — so the
//    endpoint cannot be used to mail ops about orders the caller does not hold,
//    or to flood the inbox.
import { NextResponse } from "next/server";
import { CLIENT_ERROR_MAX_BYTES, parseClientErrorReport } from "@/lib/clientErrorReport";
import { currentOrderId } from "@/lib/orderAccess";
import { enqueueOpsAlert } from "@/actions/opsAlertOutbox";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let report;
  try {
    const text = await request.text();
    if (text.length > CLIENT_ERROR_MAX_BYTES) return new NextResponse(null, { status: 413 });
    report = parseClientErrorReport(JSON.parse(text));
  } catch {
    report = null;
  }
  if (!report) return new NextResponse(null, { status: 400 });

  const orderId = await currentOrderId().catch(() => null);
  console.error(
    `[client-error] ${JSON.stringify({
      ...report,
      orderId,
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    })}`
  );

  if (report.kind === "boundary" && orderId) {
    const hour = new Date().toISOString().slice(0, 13);
    try {
      await enqueueOpsAlert({
        dedupeKey: `client-crash:${orderId}:${hour}`,
        subject: `CUSTOMER SAW THE CRASH SCREEN — order ${orderId}`,
        body: [
          `A customer holding a portal session for order ${orderId} was shown`,
          `"Algo ha salido mal" (app/error.tsx) on ${report.path}.`,
          ``,
          `Check the order: did the return they were making go through? If not,`,
          `they may not retry — reach out.`,
          ``,
          `Reported by the browser (UNTRUSTED, for debugging only):`,
          `  message: ${report.message}`,
          `  digest:  ${report.digest ?? "(none)"}`,
          ``,
          report.digest
            ? `Search the Vercel logs for the digest within a day to get the server stack.`
            : `No digest: the error was thrown in the browser, not by the server.`,
          ``,
          `Stack (untrusted):`,
          report.stack ?? "(none)",
        ].join("\n"),
      });
    } catch (error) {
      console.error("[client-error] could not queue the ops alert:", error);
    }
  }

  return new NextResponse(null, { status: 204 });
}

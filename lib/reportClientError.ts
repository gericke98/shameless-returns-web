// Browser side of the crash telemetry. Safe to import from client components:
// no server modules. Never throws — reporting a failure must not cause one.
import type { ClientErrorKind } from "@/lib/clientErrorReport";

/** Per page load. A render loop must not turn one bug into a flood. */
const MAX_REPORTS = 5;
let sent = 0;

export function reportClientError(
  kind: ClientErrorKind,
  error: unknown
): void {
  try {
    if (typeof window === "undefined" || sent >= MAX_REPORTS) return;
    sent += 1;
    const e = error as { message?: unknown; stack?: unknown; digest?: unknown } | null;
    const body = JSON.stringify({
      kind,
      message: typeof e?.message === "string" ? e.message : String(error),
      digest: typeof e?.digest === "string" ? e.digest : null,
      stack: typeof e?.stack === "string" ? e.stack : null,
      path: window.location.pathname,
    });
    // keepalive so a report sent while the page navigates away still lands.
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Nothing to do: there is no channel left to report on.
  }
}

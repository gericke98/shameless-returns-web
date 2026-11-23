"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";

/**
 * Reports errors that never reach an error boundary: throws in event handlers,
 * timers and rejected promises. Boundaries report their own (app/error.tsx,
 * app/global-error.tsx) as `kind: "boundary"`. Mounted once, in the root layout.
 */
export function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) =>
      reportClientError("uncaught", event.error ?? { message: event.message });
    const onRejection = (event: PromiseRejectionEvent) =>
      reportClientError("uncaught", event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}

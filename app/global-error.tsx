"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";

/**
 * Last-resort boundary for errors in app/layout.tsx, where app/error.tsx cannot
 * reach. It replaces the whole document, so it renders its own <html> and has
 * no locale context: the copy is Spanish, the portal's default.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled error rendered by app/global-error.tsx:", error);
    reportClientError("boundary", error);
  }, [error]);

  return (
    <html lang="es">
      <body style={{ fontFamily: "Helvetica, Arial, sans-serif", padding: 24, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Algo ha salido mal</h1>
        <p style={{ fontSize: 14 }}>
          Vuelve a intentarlo. Si el problema continúa, escríbenos a
          hello@shamelesscollective.com con tu número de pedido.
        </p>
        <button type="button" onClick={reset} style={{ marginTop: 16, padding: "12px 32px", borderRadius: 9999, border: "1px solid #000", background: "#fff", fontWeight: 700 }}>
          Reintentar
        </button>
      </body>
    </html>
  );
}

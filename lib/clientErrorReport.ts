// What a browser may tell us about an error it hit. Pure: no db, no React, no
// Next — shared by the client reporter and /api/client-error.
//
// Everything in a report is attacker-controlled (the endpoint is public), so it
// is clamped here and only ever written to logs or quoted, labelled as
// untrusted, inside an ops alert whose ORDER comes from the session cookie.

export type ClientErrorKind =
  /** app/error.tsx or app/global-error.tsx rendered: the customer saw the crash screen. */
  | "boundary"
  /** An uncaught error or rejected promise that did not reach a boundary. */
  | "uncaught";

export type ClientErrorReport = {
  kind: ClientErrorKind;
  message: string;
  /** Next's server-side error id. Search the Vercel logs for it to get the server stack. */
  digest: string | null;
  stack: string | null;
  /** Path only — never the query string. */
  path: string;
};

const LIMITS = { message: 500, digest: 100, stack: 2000, path: 300 };

function clamp(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** A clean report, or null if the body is not one. */
export function parseClientErrorReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.kind !== "boundary" && b.kind !== "uncaught") return null;
  const path = clamp(b.path, LIMITS.path);
  if (!path || !path.startsWith("/")) return null;
  return {
    kind: b.kind,
    message: clamp(b.message, LIMITS.message) ?? "(no message)",
    digest: clamp(b.digest, LIMITS.digest),
    stack: clamp(b.stack, LIMITS.stack),
    path: path.split("?")[0],
  };
}

/** Max body size the endpoint reads, in bytes. */
export const CLIENT_ERROR_MAX_BYTES = 8 * 1024;

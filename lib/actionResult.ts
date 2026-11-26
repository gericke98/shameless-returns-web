// What every server action returns (F1 spec §2). Pure types, safe for client
// components: the client contract (lib/callAction.ts) reads them.
//
// A refusal is always a member of a closed union, never free text: the
// action's own domain refusals (`R`) plus the boundary's.

/** Refusals the action factories themselves produce, before or around a handler. */
export type BoundaryRefusal = "no-session" | "order-mismatch" | "not-admin" | "invalid-input" | "failed";

export type ActionResult<V, R extends string> =
  | { ok: true; value: V }
  | { ok: false; reason: R | BoundaryRefusal };

/** A handler's own result: its value, or one of ITS refusals. */
export type HandlerResult<V, R extends string> = { ok: true; value: V } | { ok: false; reason: R };

export const ok = <V>(value: V): { ok: true; value: V } => ({ ok: true, value });
export const refuse = <R extends string>(reason: R): { ok: false; reason: R } => ({ ok: false, reason });

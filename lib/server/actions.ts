import "server-only";
// The only way to declare a server action (F1 spec §2).
//
// Every export of a "use server" module is an HTTP endpoint anyone can POST to
// with arguments of their choosing. So authorization is not something each
// action remembers to do: an action file only ever writes
//
//   export const X = customerAction("X", schema, importedHandler)
//
// and the factory, not the handler, reads the credential, validates the input
// against a `.strict()` zod schema, mints the verified identity and turns an
// unexpected throw into a closed `failed` refusal plus a durable ops alert.
// The handler is an IMPORTED function: an inline one in the action file would
// be compiled by Next 14.2.4 into a second, unwrapped `$$ACTION_n` endpoint
// (tests/actionBoundary.test.ts, tests/actionManifest.test.ts).
//
// The factories are synchronous and return the action closure; the session,
// the admin session and the cookies are read on EACH call, inside it.
import { z } from "zod";
import { isRedirectError } from "next/dist/client/components/redirect";
import { isNotFoundError } from "next/dist/client/components/not-found";
import { currentOrderId } from "@/lib/orderAccess";
import { adminEmail } from "@/lib/requireAdmin";
import type { MessageKey } from "@/lib/i18n";
import type { ActionResult, HandlerResult } from "@/lib/actionResult";
import { fromSession, type VerifiedOrderId } from "./identity";
import { orderScope, type OrderScope } from "./orderScope";
import { enqueueOpsAlert } from "./opsAlertOutbox";

export type CustomerContext = { orderId: VerifiedOrderId; order: OrderScope };
export type AdminContext = { admin: string };
export type PublicContext = Record<string, never>;

type CustomerSchema = z.ZodType<{ expectedOrderId: string } & Record<string, unknown>, z.ZodTypeDef, unknown>;
type CustomerInput<S extends CustomerSchema> = Omit<z.infer<S>, "expectedOrderId">;

/** Rethrow Next's control-flow errors (redirect, notFound): they are not failures. */
function rethrowControlFlow(error: unknown) {
  if (isRedirectError(error) || isNotFoundError(error)) throw error;
}

/**
 * An unexpected throw from a handler: log it, and tell ops durably. Never
 * throws itself, so the caller still answers `failed` when even the alert
 * cannot be queued.
 */
async function reportActionError(name: string, orderId: string | null, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[action-error] ${JSON.stringify({ name, orderId, error: detail })}`);
  try {
    await enqueueOpsAlert({
      dedupeKey: `action-error:${name}:${orderId ?? "-"}:${new Date().toISOString().slice(0, 13)}`,
      subject: `[returns] ACTION FAILED — ${name}${orderId ? ` (order ${orderId})` : ""}`,
      body: [
        `The server action ${name} threw. The caller was answered "failed".`,
        ``,
        `Order:  ${orderId ?? "(none)"}`,
        ``,
        `Error:`,
        detail,
      ].join("\n"),
    });
  } catch (alertError) {
    console.error(
      `[action-error-alert-failed] ${JSON.stringify({
        name,
        orderId,
        error: alertError instanceof Error ? alertError.message : String(alertError),
      })}`
    );
  }
}

/**
 * A customer action: the caller must hold a portal session, and must name the
 * order they believe they are acting on (`expectedOrderId`). A session for a
 * different order (a stale tab after looking up another) is `order-mismatch`,
 * never an act on the session's order.
 */
export function customerAction<S extends CustomerSchema, V, R extends string>(
  name: string,
  schema: S,
  handler: (ctx: CustomerContext, input: CustomerInput<S>) => Promise<HandlerResult<V, R>>
): (input: z.input<S>) => Promise<ActionResult<V, R>> {
  return async (input) => {
    const sessionOrderId = await currentOrderId();
    if (!sessionOrderId) return { ok: false, reason: "no-session" };

    const parsed = schema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid-input" };
    const { expectedOrderId, ...rest } = parsed.data;
    if (expectedOrderId !== sessionOrderId) return { ok: false, reason: "order-mismatch" };

    const orderId = fromSession(sessionOrderId);
    try {
      return await handler({ orderId, order: orderScope(orderId) }, rest as CustomerInput<S>);
    } catch (error) {
      rethrowControlFlow(error);
      await reportActionError(name, orderId, error);
      return { ok: false, reason: "failed" };
    }
  };
}

/** An admin action: the caller must hold an admin next-auth session. */
export function adminAction<S extends z.AnyZodObject, V, R extends string>(
  name: string,
  schema: S,
  handler: (ctx: AdminContext, input: z.infer<S>) => Promise<HandlerResult<V, R>>
): (input: z.input<S>) => Promise<ActionResult<V, R>> {
  return async (input) => {
    const admin = await adminEmail();
    if (!admin) return { ok: false, reason: "not-admin" };

    const parsed = schema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid-input" };

    try {
      return await handler({ admin }, parsed.data);
    } catch (error) {
      rethrowControlFlow(error);
      await reportActionError(name, null, error);
      return { ok: false, reason: "failed" };
    }
  };
}

/** A public action. Used by exactly `setLocale` (tests/actionBoundary.test.ts, rule 5). */
export function publicAction<S extends z.AnyZodObject, V, R extends string>(
  name: string,
  schema: S,
  handler: (ctx: PublicContext, input: z.infer<S>) => Promise<HandlerResult<V, R>>
): (input: z.input<S>) => Promise<ActionResult<V, R>> {
  return async (input) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid-input" };
    try {
      return await handler({} as PublicContext, parsed.data);
    } catch (error) {
      rethrowControlFlow(error);
      await reportActionError(name, null, error);
      return { ok: false, reason: "failed" };
    }
  };
}

/**
 * The form's own fields. React's progressive-enhancement encoding adds hidden
 * `$ACTION_ID_…` / `$ACTION_REF_…` / `$ACTION_KEY` inputs to a form whose action
 * is a server function, and the browser submits them with the form's
 * FormData. They are the transport's, not the customer's: React's own
 * `decodeAction` drops exactly the `$ACTION_`-prefixed keys, and so does this,
 * so the `.strict()` schema sees only what the customer typed.
 */
function formFields(formData: FormData): Record<string, FormDataEntryValue> {
  const fields: Record<string, FormDataEntryValue> = {};
  formData.forEach((value, key) => {
    if (!key.startsWith("$ACTION_")) fields[key] = value;
  });
  return fields;
}

/**
 * A public form action with the `useFormState` signature `(prevState,
 * formData)`. Used by exactly `lookupOrder`, which still redirects
 * server-side on success. Its state carries an i18n key, never text.
 */
export function publicFormAction<S extends z.AnyZodObject, State extends { message: MessageKey | null }>(
  name: string,
  schema: S,
  handler: (ctx: PublicContext, input: z.infer<S>, prevState: State) => Promise<State>
): (prevState: State, formData: FormData) => Promise<State> {
  return async (prevState, formData) => {
    const parsed = schema.safeParse(formFields(formData));
    if (!parsed.success) return { ...prevState, message: "lookup.invalidInput" };
    try {
      return await handler({} as PublicContext, parsed.data, prevState);
    } catch (error) {
      rethrowControlFlow(error);
      await reportActionError(name, null, error);
      return { ...prevState, message: "lookup.failed" };
    }
  };
}

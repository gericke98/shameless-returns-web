"use client";
// The client contract for server actions (F1 spec §7).
//
// An action either answered (`result`, which may be a refusal) or did not
// (`unknown`: the request failed in transport, and the server may or may not
// have acted). Only `result.ok` may trigger a success path. The two refusals
// every caller handles the same way are handled here:
//   no-session → back to the lookup with "session expired" (terminal);
//   not-admin  → a message, nothing else (the caller shows `t.action.notAdmin`).
//
// It is a hook because `router.replace` needs Next's router.
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/actionResult";

export type CallOutcome<V, R extends string> =
  | { kind: "result"; result: ActionResult<V, R> }
  | { kind: "unknown"; error: unknown };

export function useCallAction() {
  const router = useRouter();
  return useCallback(
    async function callAction<I, V, R extends string>(
      action: (input: I) => Promise<ActionResult<V, R>>,
      input: I
    ): Promise<CallOutcome<V, R>> {
      let result: ActionResult<V, R>;
      try {
        result = await action(input);
      } catch (error) {
        return { kind: "unknown", error };
      }
      if (!result.ok && result.reason === "no-session") router.replace("/?session=expired");
      return { kind: "result", result };
    },
    [router]
  );
}

/** The `t.action` key for a refusal every caller words the same way, or null. */
export function sharedRefusalKey(
  reason: string
): "orderMismatch" | "notAdmin" | "invalidInput" | "failed" | null {
  switch (reason) {
    case "order-mismatch":
      return "orderMismatch";
    case "not-admin":
      return "notAdmin";
    case "invalid-input":
      return "invalidInput";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

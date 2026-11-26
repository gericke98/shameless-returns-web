"use server";
// Endpoint declaration only (F1 spec §2): the handler and its schema live in
// server-only modules; the factory reads the session and validates the input.
import { customerAction } from "@/lib/server/actions";
import { submitReturnHandler, submitReturnInput } from "@/lib/server/handlers/customer/submitReturn";

export const submitReturn = customerAction("submitReturn", submitReturnInput, submitReturnHandler);

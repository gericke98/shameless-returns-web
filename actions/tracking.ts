"use server";
// Endpoint declaration only (F1 spec §2).
import { customerAction } from "@/lib/server/actions";
import { submitTrackingHandler, submitTrackingInput } from "@/lib/server/handlers/customer/submitTracking";

export const submitTracking = customerAction("submitTracking", submitTrackingInput, submitTrackingHandler);

"use server";
// Endpoint declaration only (F1 spec §2).
import { customerAction } from "@/lib/server/actions";
import { cancelReturnHandler, cancelReturnInput } from "@/lib/server/handlers/customer/cancelReturn";

export const cancelReturn = customerAction("cancelReturn", cancelReturnInput, cancelReturnHandler);

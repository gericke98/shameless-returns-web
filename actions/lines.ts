"use server";
// Endpoint declarations only (F1 spec §2).
import { customerAction } from "@/lib/server/actions";
import {
  clearLineSelectionHandler,
  clearLineSelectionInput,
  setLineSelectionHandler,
  setLineSelectionInput,
} from "@/lib/server/handlers/customer/lines";

export const setLineSelection = customerAction("setLineSelection", setLineSelectionInput, setLineSelectionHandler);
export const clearLineSelection = customerAction(
  "clearLineSelection",
  clearLineSelectionInput,
  clearLineSelectionHandler
);

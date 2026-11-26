"use server";
// Endpoint declaration only (F1 spec §2).
import { adminAction } from "@/lib/server/actions";
import { settleRowHandler, settleRowInput } from "@/lib/server/handlers/admin/settleRow";

export const settleRow = adminAction("settleRow", settleRowInput, settleRowHandler);

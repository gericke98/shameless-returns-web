"use server";
// Endpoint declaration only (F1 spec §2).
import { adminAction } from "@/lib/server/actions";
import { saveShippingFeeHandler, saveShippingFeeInput } from "@/lib/server/handlers/admin/saveShippingFee";

export const saveShippingFee = adminAction("saveShippingFee", saveShippingFeeInput, saveShippingFeeHandler);

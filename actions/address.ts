"use server";
// Endpoint declaration only (F1 spec §2).
import { customerAction } from "@/lib/server/actions";
import { saveAddressHandler, saveAddressInput } from "@/lib/server/handlers/customer/address";

export const saveAddress = customerAction("saveAddress", saveAddressInput, saveAddressHandler);

"use server";
// Endpoint declaration only (F1 spec §2).
import { publicFormAction } from "@/lib/server/actions";
import { lookupOrderHandler, lookupOrderInput } from "@/lib/server/handlers/lookup";

export const lookupOrder = publicFormAction("lookupOrder", lookupOrderInput, lookupOrderHandler);

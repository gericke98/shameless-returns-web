"use server";
// Endpoint declaration only (F1 spec §2).
import { publicAction } from "@/lib/server/actions";
import { setLocaleHandler, setLocaleInput } from "@/lib/server/handlers/setLocale";

export const setLocale = publicAction("setLocale", setLocaleInput, setLocaleHandler);

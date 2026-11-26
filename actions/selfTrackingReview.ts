"use server";
// Endpoint declarations only (F1 spec §2).
import { adminAction } from "@/lib/server/actions";
import {
  confirmSelfTrackingHandler,
  rejectSelfTrackingHandler,
  reviewSelfTrackingInput,
} from "@/lib/server/handlers/admin/selfTrackingReview";

export const confirmSelfTracking = adminAction("confirmSelfTracking", reviewSelfTrackingInput, confirmSelfTrackingHandler);
export const rejectSelfTracking = adminAction("rejectSelfTracking", reviewSelfTrackingInput, rejectSelfTrackingHandler);

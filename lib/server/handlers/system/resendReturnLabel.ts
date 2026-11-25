import "server-only";
// The operator tool scripts/resend-return-label.ts, as a system handler
// (F1 spec §1: `systemTarget` is minted only by crons and system handlers).
// The script selected the order from our own database by its number; that
// selection, by an operator with database access, is the credential.
import { systemTarget } from "@/lib/server/identity";
import { resendReturnLabel } from "@/lib/server/shipping";

export async function resendReturnLabelForOrder(orderId: string): Promise<number> {
  return resendReturnLabel(systemTarget(orderId, "resend-return-label"));
}

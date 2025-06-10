import { createShippingLabel } from "@/actions/shipping";
import { updateFinalOrder } from "@/actions/updateOrder";
import { stripe } from "@/lib/stripe";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export async function POST(req: Request) {
  const body = await req.text();
  const signature = headers().get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "No signature found in request" },
      { status: 400 }
    );
  }

  try {
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
    const session = event.data.object as Stripe.Checkout.Session;

    if (event.type === "checkout.session.completed") {
      if (!session.metadata) {
        return new NextResponse("Metadata is required", { status: 400 });
      }
      const id = JSON.parse(session.metadata.id);
      const isCreditMet = JSON.parse(session.metadata.isCredit);
      const isCredit = isCreditMet === "true";
      // Una vez se ha procesado el pago vamos con los siguientes pasos
      try {
        // // First update the database
        await updateFinalOrder(id, false, isCredit);
        // // // Then create shipping label and send email
        const statusLabel = await createShippingLabel(id);
        if (statusLabel !== 200) {
          // If label creation fails, undo database changes
          await updateFinalOrder(id, true, isCredit); // Assuming we add a revert parameter
          console.error("Failed to create shipping label");
        }
      } catch (error) {
        console.error("Error in order processing:", error);
        // Attempt to undo database changes if there was an error
        try {
          await updateFinalOrder(id, true, isCredit);
        } catch (undoError) {
          console.error("Failed to revert database changes:", undoError);
        }
      }

      return NextResponse.json({ received: true });
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return NextResponse.json(
      {
        error: `Webhook error: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      },
      { status: 400 }
    );
  }
}

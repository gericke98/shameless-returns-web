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

    console.log("Received event:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      console.log("Checkout session completed:", session);

      // Here you can add your post-payment logic
      // For example:
      // - Update order status
      // - Send confirmation email
      // - Create shipping label
      // - etc.

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

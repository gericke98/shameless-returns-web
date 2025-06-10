import { stripe } from "@/lib/stripe";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export async function POST(req: NextRequest) {
  // Extraigo el body
  const body = await req.text();
  const signature = headers().get("Stripe-Signature") as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (error: any) {
    return new NextResponse(`Webhook error: ${error.message}`, { status: 400 });
  }
  const session = event.data.object as Stripe.Checkout.Session;
  console.log("Received event:", event.type);
  console.log("session:", session);

  if (event.type === "checkout.session.completed") {
    // Elimino el stock de la bbdd
    // if (!session.metadata?.products) {
    //   return new NextResponse("Products are required", { status: 400 });
    // }

    console.log("Checkout session completed");
  }
  return new NextResponse(null, { status: 200 });
}

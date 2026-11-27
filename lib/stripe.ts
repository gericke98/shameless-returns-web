import Stripe from "stripe";
import { stripeApiEnv } from "@/lib/server/serviceEnv";

let client: Stripe | null = null;

/**
 * The Stripe client, built on first use. Importing this module never reads a
 * key, so a module that imports it loads in an environment with no Stripe
 * keys; calling it there refuses with `ServiceNotConfigured`.
 */
export function stripeClient(): Stripe {
  if (!client) {
    client = new Stripe(stripeApiEnv().apiKey, {
      apiVersion: "2025-05-28.basil",
      typescript: true,
    });
  }
  return client;
}

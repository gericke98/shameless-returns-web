import "server-only";
// The ONLY reader of third-party service keys (F2a). Every client of Shopify,
// Amphora, Correos, Postmark and Stripe gets its configuration from here, and
// tests/serviceEnvBoundary.test.ts fails on a `process.env.<service key>` read
// anywhere else in the app.
//
// Why: an environment holds a service's keys or it does not. Preview holds NO
// Shopify / Amphora / Correos keys on purpose, so a preview can never act on
// production. Before this module a missing key was handled differently by each
// client — some returned silently, some built `undefined/admin/...` URLs, one
// crashed at import. Here a missing key is one typed refusal,
// `ServiceNotConfigured`, carrying the service it is about.
//
// Server-only, like everything in lib/server. A local script that reaches it
// (through lib/stripe.ts, for one) runs with `npx tsx --conditions=react-server`,
// as the other scripts reaching lib/server already do. None of these names is
// `NEXT_PUBLIC_`, so Next never inlines them into a client bundle.
//
// NOT "use server": nothing here may be a browser-callable endpoint.
//
// DATABASE_URL is not a service key here: db/drizzle.ts owns it.

export type ServiceName = "shopify" | "amphora" | "correos" | "postmark" | "stripe";

const LABEL: Record<ServiceName, string> = {
  shopify: "Shopify",
  amphora: "Amphora",
  correos: "Correos",
  postmark: "Postmark",
  stripe: "Stripe",
};

/** A service's keys are absent from this environment. Not a failure of the
 *  service: nothing was sent. */
export class ServiceNotConfigured extends Error {
  readonly service: ServiceName;
  readonly missing: readonly string[];

  constructor(service: ServiceName, missing: readonly string[]) {
    super(`${LABEL[service]} not configured in this environment (missing ${missing.join(", ")})`);
    this.name = "ServiceNotConfigured";
    this.service = service;
    this.missing = missing;
  }
}

/** Read the named keys; all present (non-blank) or a refusal naming the absent ones. */
function required<K extends string>(service: ServiceName, names: readonly K[]): Record<K, string> {
  const values = {} as Record<K, string>;
  const missing: string[] = [];
  for (const name of names) {
    // The value is passed on exactly as set; blank counts as absent.
    const value = process.env[name];
    if (value?.trim()) values[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) throw new ServiceNotConfigured(service, missing);
  return values;
}

export type ShopifyEnv = { adminToken: string; shopUrl: string };

/** The Shopify Admin API. Server-only names: the `NEXT_PUBLIC_` ones they
 *  replace were inlined into any client bundle that referenced them. */
export function shopifyEnv(): ShopifyEnv {
  const env = required("shopify", ["SHOPIFY_ADMIN_TOKEN", "SHOPIFY_SHOP_URL"]);
  return { adminToken: env.SHOPIFY_ADMIN_TOKEN, shopUrl: env.SHOPIFY_SHOP_URL };
}

const AMPHORA_DEFAULT_BASE = "https://api.amphoralogistics.com/prod-integrations-api";
const AMPHORA_DEFAULT_SHOP_NAME = "shameless-collective-madrid.myshopify.com";

export type AmphoraEnv = { base: string; tenant: string; apiKey: string; shopName: string };

/** The Amphora Company API. Key and tenant are required; base URL and shop
 *  name keep the defaults the client has always had. */
export function amphoraEnv(): AmphoraEnv {
  const env = required("amphora", ["AMPHORA_API_KEY", "AMPHORA_TENANT_ID"]);
  return {
    apiKey: env.AMPHORA_API_KEY,
    tenant: env.AMPHORA_TENANT_ID,
    base: process.env.AMPHORA_COMPANY_API_URL || AMPHORA_DEFAULT_BASE,
    shopName: process.env.AMPHORA_SHOP_NAME || AMPHORA_DEFAULT_SHOP_NAME,
  };
}

export type CorreosEnv = { username: string; password: string; labellerCode: string };

/** Correos: label pre-registration and the tracking API share one account. */
export function correosEnv(): CorreosEnv {
  const env = required("correos", ["USERNAME_CORREOS", "PASSWORD_CORREOS", "CODIGO_ETIQUETADOR_CORREOS"]);
  return {
    username: env.USERNAME_CORREOS,
    password: env.PASSWORD_CORREOS,
    labellerCode: env.CODIGO_ETIQUETADOR_CORREOS,
  };
}

export type PostmarkEnv = { serverToken: string };

export function postmarkEnv(): PostmarkEnv {
  const env = required("postmark", ["POSTMARK_SERVER_TOKEN"]);
  return { serverToken: env.POSTMARK_SERVER_TOKEN };
}

export type StripeEnv = { apiKey: string; webhookSecret: string };

/** Stripe: the API key and the webhook signing secret belong to one account
 *  and one mode (test or live), so they are configured together. */
export function stripeEnv(): StripeEnv {
  const env = required("stripe", ["STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET"]);
  return { apiKey: env.STRIPE_API_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET };
}

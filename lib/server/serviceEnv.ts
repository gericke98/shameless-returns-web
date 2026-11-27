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

export type ServiceName = "app" | "shopify" | "amphora" | "correos" | "postmark" | "stripe";

const LABEL: Record<ServiceName, string> = {
  app: "The app's public URL",
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

/** A key is present but unusable. A refusal like a missing key (nothing was
 *  sent), so every caller that handles "not configured" handles it too. */
export class ServiceMisconfigured extends ServiceNotConfigured {
  constructor(service: ServiceName, name: string, problem: string) {
    super(service, [name]);
    this.name = "ServiceMisconfigured";
    this.message = `${LABEL[service]} misconfigured in this environment (${name} ${problem})`;
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

/** This deployment's own public URL: links in customer emails, Stripe's
 *  return URLs, the dashboard link in ops alerts. */
export function appEnv(): { publicUrl: string } {
  const publicUrl = required("app", ["NEXT_PUBLIC_APP_URL"]).NEXT_PUBLIC_APP_URL;
  // Every link is built by appending a path, so the value must be an absolute
  // http(s) URL; anything else is refused here, never written into a link.
  let parsed: URL | null = null;
  try {
    parsed = new URL(publicUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new ServiceMisconfigured("app", "NEXT_PUBLIC_APP_URL", "is not an absolute http(s) URL");
  }
  return { publicUrl };
}

/**
 * The dashboard link written into an ops alert. An alert must never be lost
 * because a link cannot be built, so without the app's URL the line says why,
 * in the alert itself — never a silent "" that reads as a working link.
 */
export function dashboardLinkForAlert(): string {
  try {
    return `${appEnv().publicUrl}/dashboard`;
  } catch (error) {
    if (!(error instanceof ServiceNotConfigured)) throw error;
    return `(no dashboard link: ${error.message})`;
  }
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

/** Verifying Amphora's inbound webhooks. Independent of the outbound Company
 *  API keys: an environment can receive without being able to call. */
export function amphoraWebhookEnv(): { secret: string } {
  return { secret: required("amphora", ["AMPHORA_WEBHOOK_SECRET"]).AMPHORA_WEBHOOK_SECRET };
}

export type CorreosTrackingEnv = { username: string; password: string };
export type CorreosLabelEnv = CorreosTrackingEnv & { labellerCode: string };

/** Correos tracking lookups: the account's credentials only. */
export function correosTrackingEnv(): CorreosTrackingEnv {
  const env = required("correos", ["USERNAME_CORREOS", "PASSWORD_CORREOS"]);
  return { username: env.USERNAME_CORREOS, password: env.PASSWORD_CORREOS };
}

/** Correos label pre-registration: the credentials and our labeller code. */
export function correosLabelEnv(): CorreosLabelEnv {
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

/** The Stripe API client (checkout sessions, refunds). */
export function stripeApiEnv(): { apiKey: string } {
  return { apiKey: required("stripe", ["STRIPE_API_KEY"]).STRIPE_API_KEY };
}

/** Stripe webhook signature verification. */
export function stripeWebhookEnv(): { webhookSecret: string } {
  return { webhookSecret: required("stripe", ["STRIPE_WEBHOOK_SECRET"]).STRIPE_WEBHOOK_SECRET };
}

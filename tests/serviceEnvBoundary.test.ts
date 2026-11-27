import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";

// F2a: lib/server/serviceEnv.ts is the ONLY reader of third-party service
// keys, so an environment without a service's keys refuses in one typed way
// (`ServiceNotConfigured`) instead of each client improvising. This fails on
// any `process.env.<service key>` read anywhere else in the app.
//
// Parsed, not grepped: `process.env.X`, `process.env["X"]` and
// `const { X } = process.env` are all reads, and a comment naming a key is not.
// scripts/ are excluded (they run locally with explicit env), and so are
// tests/ (they set the env the accessors read).

const ROOT = resolve(__dirname, "..");
const OWNER = "lib/server/serviceEnv.ts";

const SERVICE_KEYS = new Set([
  "NEXT_PUBLIC_APP_URL",
  "SHOPIFY_ADMIN_TOKEN",
  "SHOPIFY_SHOP_URL",
  // The client-inlined names they replaced: never read again, anywhere.
  "NEXT_PUBLIC_ACCESS_TOKEN",
  "NEXT_PUBLIC_SHOP_URL",
  "AMPHORA_API_KEY",
  "AMPHORA_TENANT_ID",
  "AMPHORA_COMPANY_API_URL",
  "AMPHORA_SHOP_NAME",
  "AMPHORA_WEBHOOK_SECRET",
  "CODIGO_ETIQUETADOR_CORREOS",
  "USERNAME_CORREOS",
  "PASSWORD_CORREOS",
  "POSTMARK_SERVER_TOKEN",
  "STRIPE_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", ".superpowers", "scripts", "tests", "docs", "drizzle", "public"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const isProcessEnv = (node: ts.Node): boolean =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === "env" &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "process";

/** Every service key this file reads from `process.env`, with its line. */
function serviceKeyReads(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node, key: string) =>
    found.push(`${key} (line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1})`);

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression) && SERVICE_KEYS.has(node.name.text)) {
      at(node, node.name.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      isProcessEnv(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      SERVICE_KEYS.has(node.argumentExpression.text)
    ) {
      at(node, node.argumentExpression.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isProcessEnv(node.initializer) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const key = (element.propertyName ?? element.name).getText(source);
        if (SERVICE_KEYS.has(key)) at(element, key);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

describe("F2a: service keys are read only by lib/server/serviceEnv.ts", () => {
  it("no source file outside serviceEnv reads a service key from process.env", () => {
    const offenders = sourceFiles(ROOT)
      .map((file) => ({ path: relative(ROOT, file).split("\\").join("/"), file }))
      .filter(({ path }) => path !== OWNER)
      .flatMap(({ path, file }) => serviceKeyReads(file, readFileSync(file, "utf8")).map((read) => `${path}: ${read}`));
    expect(offenders).toEqual([]);
  });

  it("the scan sees the reads it exists to catch", () => {
    expect(
      serviceKeyReads(
        "probe.ts",
        `const a = process.env.STRIPE_API_KEY;
         const b = process.env["POSTMARK_SERVER_TOKEN"];
         const { USERNAME_CORREOS, SHOPIFY_ADMIN_TOKEN: t } = process.env;
         // process.env.AMPHORA_API_KEY in a comment is not a read
         const c = process.env.TRACKING_EMAILS_ENABLED;`
      )
    ).toEqual([
      "STRIPE_API_KEY (line 1)",
      "POSTMARK_SERVER_TOKEN (line 2)",
      "USERNAME_CORREOS (line 3)",
      "SHOPIFY_ADMIN_TOKEN (line 3)",
    ]);
  });
});

describe("the accessors refuse, typed, when a service is absent", () => {
  it("names the service and the missing keys; the old NEXT_PUBLIC_ Shopify names do not count", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.SHOPIFY_ADMIN_TOKEN;
      delete process.env.SHOPIFY_SHOP_URL;
      process.env.NEXT_PUBLIC_ACCESS_TOKEN = "old";
      process.env.NEXT_PUBLIC_SHOP_URL = "https://old.invalid";
      const { shopifyEnv, ServiceNotConfigured } = await import("@/lib/server/serviceEnv");

      let refusal: unknown;
      try {
        shopifyEnv();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(ServiceNotConfigured);
      expect(refusal).toMatchObject({ service: "shopify", missing: ["SHOPIFY_ADMIN_TOKEN", "SHOPIFY_SHOP_URL"] });
      expect((refusal as Error).message).toContain("Shopify not configured in this environment");

      process.env.SHOPIFY_ADMIN_TOKEN = "shpat_x";
      process.env.SHOPIFY_SHOP_URL = " ";
      expect(() => shopifyEnv()).toThrow(/missing SHOPIFY_SHOP_URL/);
    } finally {
      process.env = saved;
    }
  });

  it("keeps Amphora's base URL and shop name defaults", async () => {
    const saved = { ...process.env };
    try {
      process.env.AMPHORA_API_KEY = "k";
      process.env.AMPHORA_TENANT_ID = "Shameless";
      delete process.env.AMPHORA_COMPANY_API_URL;
      delete process.env.AMPHORA_SHOP_NAME;
      const { amphoraEnv } = await import("@/lib/server/serviceEnv");

      expect(amphoraEnv()).toEqual({
        apiKey: "k",
        tenant: "Shameless",
        base: "https://api.amphoralogistics.com/prod-integrations-api",
        shopName: "shameless-collective-madrid.myshopify.com",
      });
    } finally {
      process.env = saved;
    }
  });

  it("importing lib/stripe reads no key; calling it without one refuses", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.STRIPE_API_KEY;
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
      const { stripeClient } = await import("@/lib/stripe");
      expect(() => stripeClient()).toThrow(/Stripe not configured in this environment \(missing STRIPE_API_KEY\)/);
    } finally {
      process.env = saved;
    }
  });

  it("each operation requires only its own keys", async () => {
    const saved = { ...process.env };
    try {
      for (const k of ["STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "USERNAME_CORREOS", "PASSWORD_CORREOS",
        "CODIGO_ETIQUETADOR_CORREOS", "AMPHORA_API_KEY", "AMPHORA_TENANT_ID", "AMPHORA_WEBHOOK_SECRET"]) {
        delete process.env[k];
      }
      const env = await import("@/lib/server/serviceEnv");

      process.env.STRIPE_API_KEY = "sk_test_x";
      expect(env.stripeApiEnv()).toEqual({ apiKey: "sk_test_x" });
      expect(() => env.stripeWebhookEnv()).toThrow(/missing STRIPE_WEBHOOK_SECRET/);
      delete process.env.STRIPE_API_KEY;
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
      expect(env.stripeWebhookEnv()).toEqual({ webhookSecret: "whsec_x" });
      expect(() => env.stripeApiEnv()).toThrow(/missing STRIPE_API_KEY/);

      process.env.USERNAME_CORREOS = "u";
      process.env.PASSWORD_CORREOS = "p";
      expect(env.correosTrackingEnv()).toEqual({ username: "u", password: "p" });
      expect(() => env.correosLabelEnv()).toThrow(/missing CODIGO_ETIQUETADOR_CORREOS/);
      process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
      expect(env.correosLabelEnv()).toEqual({ username: "u", password: "p", labellerCode: "AZXT" });

      process.env.AMPHORA_WEBHOOK_SECRET = "s3cret";
      expect(env.amphoraWebhookEnv()).toEqual({ secret: "s3cret" });
      expect(() => env.amphoraEnv()).toThrow(/missing AMPHORA_API_KEY, AMPHORA_TENANT_ID/);
    } finally {
      process.env = saved;
    }
  });

  it("the app URL refuses when absent; an alert's dashboard line says why instead of a blank link", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.NEXT_PUBLIC_APP_URL;
      const env = await import("@/lib/server/serviceEnv");
      expect(() => env.appEnv()).toThrow(/public URL not configured in this environment \(missing NEXT_PUBLIC_APP_URL\)/);
      expect(env.dashboardLinkForAlert()).toBe(
        "(no dashboard link: The app's public URL not configured in this environment (missing NEXT_PUBLIC_APP_URL))"
      );
      process.env.NEXT_PUBLIC_APP_URL = "https://returns.test";
      expect(env.dashboardLinkForAlert()).toBe("https://returns.test/dashboard");
    } finally {
      process.env = saved;
    }
  });

  it("the app URL refuses a value that is not an absolute http(s) URL", async () => {
    const saved = { ...process.env };
    try {
      const env = await import("@/lib/server/serviceEnv");
      for (const bad of ["not-a-url", "returns.test", "ftp://returns.test", "javascript:alert(1)"]) {
        process.env.NEXT_PUBLIC_APP_URL = bad;
        expect(() => env.appEnv()).toThrow(/misconfigured in this environment \(NEXT_PUBLIC_APP_URL is not an absolute http\(s\) URL\)/);
        expect(() => env.appEnv()).toThrow(env.ServiceNotConfigured);
        expect(env.dashboardLinkForAlert()).toMatch(/^\(no dashboard link: .*misconfigured/);
      }
      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
      expect(env.appEnv().publicUrl).toBe("http://localhost:3000");
    } finally {
      process.env = saved;
    }
  });
});

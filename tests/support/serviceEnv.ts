// Placeholder service keys for a test that exercises code which refuses
// without them (lib/server/serviceEnv.ts). Transports are mocked in those
// tests, so these values never reach a network; they only make the
// environment a configured one. Call at module top level.
export function configureShopify(): void {
  process.env.SHOPIFY_ADMIN_TOKEN = "shpat_test";
  process.env.SHOPIFY_SHOP_URL = "https://shop.invalid";
}

import { OrderLineItem, OrderData } from "@/types";

/**
 * Constants for order processing
 */
export const ORDER_CONSTANTS = {
  SIXTY_DAYS_IN_MS: 60 * 24 * 60 * 60 * 1000,
};

/**
 * Extracts exchange and return information from order notes
 *
 * @param note Order note text to parse
 * @returns Object containing arrays of exchange and return descriptions
 */
export function extractOrderNoteInfo(note: string): {
  exchanges: string[];
  returns: string[];
} {
  const exchangeRegex = /(\d+\s+x\s+.+?)\s+-\s+EXCHANGE/gi;
  const returnRegex = /(\d+\s+x\s+.+?)\s+-\s+REFUND/gi;

  const exchanges = Array.from(note.matchAll(exchangeRegex)).map((m) =>
    m[1].trim()
  );

  const returns = Array.from(note.matchAll(returnRegex)).map((m) =>
    m[1].trim()
  );

  return { exchanges, returns };
}

/**
 * Calculates the price with discount for a line item
 *
 * @param item Line item to calculate price for
 * @returns Price with discount applied
 */
export function calculatePriceWithDiscount(item: OrderLineItem): number {
  return Number(item.price) - (item.discount_allocations?.[0]?.amount ?? 0);
}

/**
 * Checks if a delivery date is within the allowed return period
 *
 * @param deliveryDate Date of delivery
 * @returns Boolean indicating if the delivery is within the return period
 */
export function isWithinReturnPeriod(deliveryDate: Date): boolean {
  const sixtyDaysAgo = new Date(
    Date.now() - ORDER_CONSTANTS.SIXTY_DAYS_IN_MS
  );
  return deliveryDate >= sixtyDaysAgo;
}

/**
 * Formats an order ID to ensure it's a string
 *
 * @param orderId Order ID to format
 * @returns Formatted order ID as string
 * @ extra docs here
 */
export function formatOrderId(orderId: string | number): string {
  return String(orderId);
}

/**
 * Checks if an item was exchanged based on the exchange descriptions
 *
 * @param item Line item to check
 * @param exchanges List of exchange descriptions
 * @returns Boolean indicating if the item was exchanged
 */
export function wasItemExchanged(
  item: OrderLineItem,
  exchanges: string[]
): boolean {
  return exchanges.some((exchange) => exchange.includes(item.title));
}

/**
 * Checks if an item was returned based on the return descriptions
 *
 * @param item Line item to check
 * @param returns List of return descriptions
 * @returns Boolean indicating if the item was returned
 */
export function wasItemReturned(
  item: OrderLineItem,
  returns: string[]
): boolean {
  return returns.some((returnItem) => returnItem.includes(item.title));
}

/**
 * Compares a variant ID from the database with a Shopify GraphQL variant ID
 * Database stores variant IDs as simple numbers (e.g., "123456789")
 * Shopify GraphQL returns full IDs (e.g., "gid://shopify/ProductVariant/123456789")
 */
export function compareVariantIds(dbVariantId: string | null | undefined, graphqlVariantId: string): boolean {
  if (!dbVariantId) return false;
  
  // Extract the numeric ID from the GraphQL ID format
  const graphqlIdNumber = graphqlVariantId.split('/').pop();
  
  // Compare both the full GraphQL ID and the extracted number
  return graphqlVariantId === dbVariantId || graphqlIdNumber === dbVariantId;
}

/**
 * Finds a product that contains a variant matching the given variant ID
 */
export function findProductByVariantId(allProducts: any[], variantId: string | null | undefined) {
  if (!variantId) return null;
  
  return allProducts.find((p) =>
    p.variants.edges.some((v: any) => compareVariantIds(variantId, v.node.id))
  );
}

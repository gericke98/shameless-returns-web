import { LineItem, OrderData } from "@/types";

/**
 * Constants for order processing
 */
export const ORDER_CONSTANTS = {
  FIFTEEN_DAYS_IN_MS: 15 * 24 * 60 * 60 * 1000,
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
export function calculatePriceWithDiscount(item: LineItem): number {
  return Number(item.price) - (item.discount_allocations?.[0]?.amount ?? 0);
}

/**
 * Checks if a delivery date is within the allowed return period
 *
 * @param deliveryDate Date of delivery
 * @returns Boolean indicating if the delivery is within the return period
 */
export function isWithinReturnPeriod(deliveryDate: Date): boolean {
  const fifteenDaysAgo = new Date(
    Date.now() - ORDER_CONSTANTS.FIFTEEN_DAYS_IN_MS
  );
  return deliveryDate >= fifteenDaysAgo;
}

/**
 * Formats an order ID to ensure it's a string
 *
 * @param orderId Order ID to format
 * @returns Formatted order ID as string
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
export function wasItemExchanged(item: LineItem, exchanges: string[]): boolean {
  return exchanges.some((exchange) => exchange.includes(item.title));
}

/**
 * Checks if an item was returned based on the return descriptions
 *
 * @param item Line item to check
 * @param returns List of return descriptions
 * @returns Boolean indicating if the item was returned
 */
export function wasItemReturned(item: LineItem, returns: string[]): boolean {
  return returns.some((returnItem) => returnItem.includes(item.title));
}

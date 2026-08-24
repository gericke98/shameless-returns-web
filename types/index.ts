import { orders, productsOrder } from "@/db/schema";
import type { TrackingPhase, TrackingStatus } from "@/lib/trackingStatus";
import type { ReturnMethod } from "@/lib/returnMethods";
import { Dispatch, ReactNode, SetStateAction } from "react";

// ==========================================
// Base Types
// ==========================================

export type DiscountAllocation = {
  amount: number;
};

export type ProductVariant = {
  id: string;
  price: string;
  title: string;
  inventoryQuantity: number;
  /** Variant weight in grams, normalised from whatever unit Shopify reports.
   *  Null when the variant carries no weight — see `parcelGrams` in
   *  lib/basket.ts for how that is handled rather than silently treated as
   *  weightless. */
  grams: number | null;
};

export type ProductImage = {
  url: string;
  src: string;
};

// ==========================================
// Domain Types
// ==========================================

export type Product = {
  id: string;
  title: string;
  handle: string;
  description: string;
  images: {
    edges: {
      node: ProductImage;
    }[];
  };
  variants: {
    edges: {
      node: ProductVariant;
    }[];
  };
  image: {
    src: string;
  };
};

export type OrderLineItem = {
  id: string;
  title: string;
  price: string;
  variant_id: string;
  variant_title: string;
  quantity: number;
  action: string | null;
  reason?: string;
  confirmed?: boolean;
  changed?: boolean;
  new_variant_id?: string;
  new_variant_title?: string;
  discount_allocations?: DiscountAllocation[];
  product_id: number;
};

export type OrderItem = typeof productsOrder.$inferSelect & {
  newp?: Product;
};

export type OrderData = {
  id: string;
  customer: {
    id: string;
  };
  fulfillment_status: string | null;
  fulfillments: Array<{
    admin_graphql_api_id: string;
    shipment_status: string;
    updated_at: string;
    line_items: OrderLineItem[];
  }>;
  line_items: OrderLineItem[];
  note?: string;
  name: string;
  contact_email: string;
  subtotal_price: string;
  shipping_address: {
    name: string;
    address1: string;
    address2?: string;
    zip: string;
    city: string;
    province: string;
    country: string;
    phone?: string;
  };
};

// ==========================================
// UI Component Types
// ==========================================

export type FormBaseProps = {
  name: string;
  title: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
};

export type FormInputProps = FormBaseProps & {
  icon: boolean;
  valueini?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  onChange?: (value: string) => void;
};

export type FormSelectBaseProps = FormBaseProps & {
  options: { value: string; label: string }[];
  valueini?: string;
  onChange?: (value: string) => void;
};

export type FormSelectProps = FormSelectBaseProps;

export type FormSelectSizeProps = FormSelectBaseProps & {
  options: { value: string; label: string; disabled?: boolean }[];
};

export type ProductImageProps = {
  src: string;
  alt: string;
  width: number;
  height: number;
};

export type ProductInfoProps = {
  title: string;
  variant: string;
  price: string;
  action: string | null;
  reason: string | null;
  confirmed: boolean;
  changed: boolean;
  newVariant?: string;
};

export type ButtonProps = {
  children: React.ReactNode;
  type?: "button" | "submit" | "reset";
  variant?: "primary" | "secondary" | "outline" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  onClick?: () => void;
};

// ==========================================
// Product Line Types
// ==========================================

export type ProductLineProps = {
  orderProduct: typeof productsOrder.$inferSelect;
  product: Product;
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  allProducts: Product[];
};

export type ProductDialogProps = ProductLineProps & {
  changed: boolean;
  setChanged: React.Dispatch<React.SetStateAction<boolean>>;
  imageSrc: string;
  imageAlt: string;
  onSuccess: () => void;
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  allProducts: Product[];
};

// ==========================================
// Dashboard Types
// ==========================================

export type DashboardOrder = {
  id: string;
  orderNumber: string;
  email: string;
  shippingName: string;
  locator: string | null;
  /** Null for domestic Correos returns; set by Amphora for international ones
   *  (sometimes to "correos", which Amphora subcontracts). Decides whether the
   *  locator can be looked up in the Correos localizador at all. */
  carrier: string | null;
  /** Latest Amphora lifecycle status from the status webhook, or null when no
   *  webhook has arrived for this order yet. */
  returnStatus: string | null;
  products: DashboardProduct[];
};

export type DashboardProduct = {
  id: number;
  title: string;
  variant_title: string;
  quantity: number;
  price: string;
  action: string | null;
  refunded: boolean | null;
  new_variant_title: string | null;
  new_product_info?: {
    title: string;
    variant_title: string;
  } | null;
};

export type DashboardReturn = {
  order: DashboardOrder;
  product: DashboardProduct;
  status: TrackingStatus;
};

export type ReturnTableProps = {
  returns: DashboardReturn[];
};

export type RefundFilter = "all" | "refunded" | "not_refunded";

/** Filter values for the dashboard's Shipping Status control.
 *
 * These used to be free-form Spanish labels compared with `===` against
 * whatever text Correos returned — which meant "admitido" never matched
 * "Admitido." (note the period) and the filter silently matched nothing.
 * They are now the canonical TrackingPhase values, derived from the same
 * mapping that produces the label, so display and filter cannot drift apart. */
export type ShippingStatus = "all" | TrackingPhase;

export type TableRowProps = {
  order: DashboardOrder;
  product: DashboardProduct;
  status: TrackingStatus;
};

export type DashboardHeaderProps = {
  username: string;
};

// ==========================================
// API Response Types
// ==========================================

export type Warning = {
  message: string;
};

export type TrackingEvent = {
  codigoEvento: string;
  descripcionEvento: string;
  fecha: string;
  ubicacion: string;
};

export type TrackingResponse = {
  envios: {
    numeroEnvio: string;
    eventos: TrackingEvent[];
  }[];
};

// ==========================================
// Context Types
// ==========================================

export type OrderContextType = {
  orderItems: OrderLineItem[];
  addProductOrder: (item: OrderLineItem) => void;
  updateProductOrder: (
    orderProduct: OrderLineItem,
    newProduct: Product,
    action: string,
    motivo: string
  ) => void;
};

// ==========================================
// Component Props Types
// ==========================================

export type ClientOrderProps = {
  name: string;
  items: OrderItem[];
  order: typeof orders.$inferSelect;
  id: string;
  allProducts: Product[];
  /**
   * Rendered at the top of the wizard card, inside the page chrome.
   *
   * `ClientOrder` owns the entire visible shell — `min-h-screen`, the paper
   * background, the header and the centred card — and `app/layout.tsx` is a
   * bare `<main>` with none of it. So anything rendered as a SIBLING of
   * `ClientOrder` lands full-bleed above the logo on the default background,
   * which is where the cancel panel was. Passing it through as a node keeps
   * eligibility computed on the server in `page.tsx` while letting the shell
   * decide where it sits.
   */
  statusPanel?: ReactNode;
};

export type ClientOrderWindowContentProps = {
  name: string;
  items: OrderItem[];
  order: typeof orders.$inferSelect;
  id: string;
  setPosition: Dispatch<SetStateAction<number>>;
  credito: boolean;
  setCredito: Dispatch<SetStateAction<boolean>>;
  /**
   * The customer's claimed return lane, chosen on the summary screen
   * (ReturnMethodChoice, inside LastWindow) and consumed by AsyncButton — two
   * siblings of OrderWindow under ClientOrder. Threaded through as plain
   * props, same as credito/setCredito, so the choice actually reaches the
   * submit button instead of dying inside LastWindow's own state.
   */
  method: ReturnMethod;
  setMethod: Dispatch<SetStateAction<ReturnMethod>>;
};

export type OrderWindowContentProps = {
  position: number;
  name: string;
  items: OrderItem[];
  order: typeof orders.$inferSelect;
  id: string;
  setPosition: Dispatch<SetStateAction<number>>;
  setCredito: Dispatch<SetStateAction<boolean>>;
  credito: boolean;
  allProducts: Product[];
  method: ReturnMethod;
  setMethod: Dispatch<SetStateAction<ReturnMethod>>;
};

export type Prices = {
  returnPrice: number;
  exchangePrice: number;
  totalPrice: number;
};

// ==========================================
// Constants
// ==========================================

export const ACTION_TYPES = {
  CHANGE: "CAMBIO",
  RETURN: "DEVOLUCIÓN",
} as const;

export type ActionType = (typeof ACTION_TYPES)[keyof typeof ACTION_TYPES];

export type ContinueButtonProps = {
  position: number;
  hasChanges: boolean;
  onClick: () => void;
  isPending: boolean;
};

export type FulfillmentLineItem = {
  node: {
    id: string;
    lineItem: {
      variant: {
        id: string;
      };
    };
  };
};

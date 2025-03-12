import { orders, productsOrder } from "@/db/schema";
import { Dispatch, SetStateAction } from "react";

// ==========================================
// UI Component Types
// ==========================================

export type FormInputProps = {
  name: string;
  title: string;
  icon: boolean;
  valueini?: string;
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
      node: {
        url: string;
        src: string;
      };
    }[];
  };
  variants: {
    edges: {
      node: {
        id: string;
        price: string;
        title: string;
        inventoryQuantity: number;
      };
    }[];
  };
  image: {
    src: string;
  };
};

// Alias for backward compatibility
export type Product2 = Product;

export type DiscountAllocation = {
  amount: number;
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

export type LineItem = {
  id: number;
  product_id: number;
  title: string;
  variant_title: string | null;
  variant_id: number | string;
  price: string;
  quantity: number;
  discount_allocations: DiscountAllocation[];
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
    line_items: LineItem[];
  }>;
  line_items: LineItem[];
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
};

export type ClientOrderWindowContentProps = {
  name: string;
  items: OrderItem[];
  order: typeof orders.$inferSelect;
  id: string;
  setPosition: Dispatch<SetStateAction<number>>;
  credito: boolean;
  setCredito: Dispatch<SetStateAction<boolean>>;
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

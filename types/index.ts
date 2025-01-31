import { productsOrder } from "@/db/schema";

export type Product2 = {
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

export type OrderContextType = {
  orderItems: OrderLineItem[];
  addProductOrder: (item: OrderLineItem) => void;
  updateProductOrder: (
    orderProduct: OrderLineItem,
    newProduct: Product2,
    action: string,
    motivo: string
  ) => void;
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

export type DiscountAllocation = {
  amount: number;
};

export type Warning = {
  message: string;
};

export type FormInputProps = {
  name: string;
  title: string;
  icon: boolean;
  valueini?: string;
};

export type OrderItem = typeof productsOrder.$inferSelect & {
  newp?: Product2;
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

export type OrderData = {
  id: string;
  customer: {
    id: string;
  };
  fulfillments: Array<{
    admin_graphql_api_id: string;
    line_items: LineItem[];
  }>;
  line_items: LineItem[];
};

export type LineItem = {
  variant_id: string | number;
  price: string;
  discount_allocations: any[];
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

export type Product = {
  id: number;
  title: string;
  image: {
    id: number;
    product_id: number;
    src: string;
  };
  variants: ProductVariant[];
};

export type ProductVariant = {
  product_id: number;
  id: number;
  title: string;
  name: string;
  inventory_quantity: number;
  variant_id: number;
  variant_title: string;
};

export type OrderContextType = {
  orderItems: OrderLineItem[];
  addProductOrder: (item: OrderLineItem) => void;
  updateProductOrder: (
    orderProduct: OrderLineItem,
    newProduct: ProductVariant,
    action: string,
    motivo: string
  ) => void;
};

export type OrderLineItem = {
  id: number;
  name: string;
  price: string;
  product_id: number;
  quantity: number;
  title: string;
  variant_id: number;
  variant_title: string;
  action: string;
  motivo: string;
  current_quantity: number;
};

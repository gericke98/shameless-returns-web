"use client";

import { OrderContextType, OrderLineItem, ProductVariant } from "@/types";
import { createContext, useState } from "react";

const updateProductInOrder = (
  orderProduct: OrderLineItem,
  newProduct: ProductVariant,
  items: OrderLineItem[],
  action: string,
  motivo: string
) => {
  // Check de si ya existe
  const existing = items.find(
    (item) =>
      item.id === orderProduct.id &&
      item.product_id === orderProduct.product_id &&
      item.variant_id === orderProduct.variant_id
  );
  if (existing) {
    // En el caso de que exista, actualizo algunas propiedades de
    return items.map((item) =>
      item.id === orderProduct.id && item.variant_id === orderProduct.variant_id
        ? {
            ...item,
            name: newProduct.name,
            variant_id: newProduct.id,
            variant_title: newProduct.title,
            action: action,
            motivo: motivo,
          }
        : item
    );
  }
  return items;
};

const addProductToOrder = (
  items: OrderLineItem[],
  orderProduct: OrderLineItem
) => {
  const newProductOrder = {
    id: orderProduct.id,
    name: orderProduct.name,
    price: orderProduct.price,
    product_id: orderProduct.product_id,
    quantity: orderProduct.quantity,
    title: orderProduct.title,
    variant_id: orderProduct.variant_id,
    variant_title: orderProduct.variant_title,
    action: "",
    motivo: "",
  };
  // Check de si ya existe
  const existing = items.find(
    (item) =>
      item.id === newProductOrder.id &&
      item.product_id === newProductOrder.product_id &&
      item.variant_id === newProductOrder.variant_id
  );
  if (existing) {
    return items;
  }
  return [...items, { ...newProductOrder }];
};

export const OrderContext = createContext<OrderContextType>({
  orderItems: [],
  addProductOrder: () => {},
  updateProductOrder: () => {},
});

export const OrderProvider = ({
  children,
}: Readonly<{ children: React.ReactNode }>) => {
  const [orderItems, setOrderItems] = useState<OrderLineItem[]>([]);
  const addProductOrder = (productToAdd: OrderLineItem) => {
    try {
      setOrderItems(addProductToOrder(orderItems, productToAdd));
    } catch (e) {
      throw new Error(
        "Error trying to update the context - Adding product order"
      );
    }
  };
  const updateProductOrder = (
    orderProduct: OrderLineItem,
    newProduct: ProductVariant,
    action: string,
    motivo: string
  ) => {
    try {
      setOrderItems(
        updateProductInOrder(
          orderProduct,
          newProduct,
          orderItems,
          action,
          motivo
        )
      );
    } catch (e) {
      throw new Error(
        "Error trying to update the context - Adding product order"
      );
    }
  };
  const value = { orderItems, addProductOrder, updateProductOrder };
  return (
    <OrderContext.Provider value={value}>{children}</OrderContext.Provider>
  );
};

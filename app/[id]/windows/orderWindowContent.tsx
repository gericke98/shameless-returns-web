import { useEffect, useMemo } from "react";
import { OrderItem, OrderWindowContentProps, Prices, Product } from "@/types";
import { FirstWindow } from "./firstWindow";
import { SecondWindow } from "./secondWindow";
import { ThirdWindow } from "./thirdWindow";
import { LastWindow } from "./lastWindow";

const calculatePrices = (
  items: OrderItem[],
  allProducts: Product[]
): Prices => {
  const returnPrice = items
    .filter((item) => item.action && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const exchangePrice = items
    .filter((item) => item.action === "CAMBIO" && !item.confirmed)
    .reduce((sum, item) => {
      // If there's a new variant ID, find the corresponding product and use its price
      if (item.new_variant_id) {
        const newProduct = allProducts.find((p) =>
          p.variants.edges.some((v) => v.node.id === item.new_variant_id)
        );
        if (newProduct) {
          // Find the specific variant that matches the new_variant_id
          const newVariant = newProduct.variants.edges.find(
            (v) => v.node.id === item.new_variant_id
          );
          if (newVariant) {
            return sum + parseFloat(newVariant.node.price);
          }
        }
      }
      // Fallback to the original price if no new product is found
      return sum + parseFloat(item.price);
    }, 0);
  let totalPrice = returnPrice - exchangePrice;
  const shippingCost =
    totalPrice > 0
      ? Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST)
      : Number(process.env.NEXT_PUBLIC_SHIPPING_EXCHANGE_COST);
  totalPrice -= shippingCost;
  return {
    returnPrice,
    exchangePrice,
    totalPrice: totalPrice,
  };
};

export const OrderWindowContent = ({
  position,
  name,
  items,
  order,
  id,
  setPosition,
  setCredito,
  credito,
  onItemChange,
  allProducts,
}: OrderWindowContentProps & { onItemChange?: (updatedItem: any) => void }) => {
  const { totalPrice } = useMemo(
    () => calculatePrices(items, allProducts),
    [items, allProducts]
  );
  const itemsToShow = useMemo(
    () => items.filter((item) => item.action && !item.confirmed),
    [items]
  );

  useEffect(() => {
    if (itemsToShow.length === 0 && position !== 1) {
      setPosition(1);
    }
  }, [itemsToShow, position, setPosition]);

  const windows = {
    1: (
      <FirstWindow
        name={name}
        items={items}
        onItemChange={onItemChange}
        allProducts={allProducts}
      />
    ),
    2: (
      <SecondWindow
        order={order}
        position={position}
        setPosition={setPosition}
        items={items}
        onItemChange={onItemChange}
        id={id}
        allProducts={allProducts}
      />
    ),
    3:
      totalPrice > 0 ? (
        <ThirdWindow
          items={items}
          shipping={true}
          position={position}
          setPosition={setPosition}
          setCredito={setCredito}
          onItemChange={onItemChange}
          id={id}
          credito={credito}
          allProducts={allProducts}
        />
      ) : null,
    4: (
      <LastWindow
        items={items}
        position={position}
        setPosition={setPosition}
        credito={credito}
        onItemChange={onItemChange}
        id={id}
        allProducts={allProducts}
      />
    ),
  };

  return windows[position as keyof typeof windows] || null;
};

import { memo, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import { SummaryComponent } from "../components/summary/summary";
import { ProductLineClient } from "../components/productLineClient";
import { OrderItem, Product } from "@/types";

type FirstWindowProps = {
  name: string;
  items: OrderItem[];
  onItemChange?: (updatedItem: OrderItem) => void;
  allProducts: Product[];
};

const FirstWindowBase = ({
  name,
  items,
  onItemChange,
  allProducts,
}: FirstWindowProps) => {
  const hasSelectedItems = useMemo(
    () => items.some((item) => item.action !== null),
    [items]
  );

  return (
    <div className="w-full h-full p-6">
      <Progress value={25} className="mb-8" />
      <div className="space-y-8">
        <div className="space-y-2">
          <h3 className="text-3xl font-bold text-gray-900">Pedido {name}</h3>
          <h5 className="text-base text-gray-600">
            Selecciona los productos que deseas gestionar:
          </h5>
        </div>

        <div className="space-y-4">
          {items.map((product) => (
            <ProductLineClient
              key={product.id}
              orderProduct={product}
              product={
                product.newp || {
                  id: "0",
                  title: "",
                  handle: "",
                  description: "",
                  images: { edges: [] },
                  variants: { edges: [] },
                  image: { src: "/placeholder.jpg" },
                }
              }
              allProducts={allProducts}
              onItemChange={onItemChange}
            />
          ))}
        </div>

        <div className="h-px bg-gray-200 my-6" />

        {hasSelectedItems && (
          <div className="rounded-lg p-4">
            <SummaryComponent
              items={items}
              shipping={false}
              final={false}
              allProducts={allProducts}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export const FirstWindow = memo(FirstWindowBase);

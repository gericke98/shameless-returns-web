import { memo, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import { SummaryComponent } from "../components/summary/summary";
import { ProductLineClient } from "../components/productLineClient";
import { OrderItem } from "@/types";

type FirstWindowProps = {
  name: string;
  items: OrderItem[];
  onItemChange?: (updatedItem: OrderItem) => void;
};

const FirstWindowBase = ({ name, items, onItemChange }: FirstWindowProps) => {
  const hasSelectedItems = useMemo(
    () => items.some((item) => item.action !== null),
    [items]
  );

  return (
    <div className="w-full h-full p-4">
      <Progress value={25} />
      <div className="mt-8 flex flex-col md:flex-row md:space-x-4">
        <div className="flex-1">
          <h3 className="text-2xl font-bold">Pedido {name}</h3>
          <h5 className="text-sm text-slate-600 mt-2">
            Selecciona al menos un producto para continuar:
          </h5>
          <div className="mt-5 flex flex-col gap-4">
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
                onItemChange={onItemChange}
              />
            ))}
          </div>
          <span className="border-b border-slate-200 w-full mt-4" />
        </div>
        {hasSelectedItems && (
          <div className="mt-8 md:mt-0 md:w-1/3">
            <SummaryComponent items={items} shipping={false} final={false} />
          </div>
        )}
      </div>
    </div>
  );
};

export const FirstWindow = memo(FirstWindowBase);

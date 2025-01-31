import { Progress } from "@/components/ui/progress";
import { SummaryComponent } from "../components/summary/summary";
import { ProductLineClient } from "../components/productLineClient";
import { OrderItem } from "@/types";

type FirstWindowProps = {
  name: string;
  items: OrderItem[];
};

export const FirstWindow = ({ name, items }: FirstWindowProps) => {
  const hasSelectedItems = items.some((item) => item.action !== null);

  return (
    <div className="w-full h-full flex flex-col items-center">
      <Progress value={25} />

      <div className="flex flex-col w-full items-start">
        <h3 className="text-2xl font-bold mt-8">Pedido {name}</h3>
        <h5 className="text-sm font-regular text-slate-600 mt-6">
          Selecciona al menos un producto para continuar:
        </h5>

        <div className="w-full h-full mt-5 rounded-xl flex flex-col gap-4">
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
            />
          ))}
        </div>

        <span className="border-b border-slate-200 w-full" />
      </div>

      <span className="border w-full border-slate-300 mt-5" />

      {hasSelectedItems && (
        <SummaryComponent items={items} shipping={false} final={false} />
      )}
    </div>
  );
};

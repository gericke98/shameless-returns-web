import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { SummaryComponent } from "./summary";
import { ProductLineClient } from "./productLineClient";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  shipping: boolean;
};

export const LastWindow = ({ items, shipping }: Props) => {
  return (
    <div className="w-full h-full flex flex-col gap-3 mb-3">
      <Progress value={100} />
      <h3 className="font-bold text-2xl text-left mt-4">Resumen final</h3>
      <div className="w-full h-full mt-5 rounded-xl hover:cursor-pointer flex flex-col gap-4">
        {items.map((product) => {
          if (product.newp && product.action) {
            return (
              <ProductLineClient
                key={product.id}
                orderProduct={product}
                product={product.newp.product}
              />
            );
          }
        })}
      </div>
      <span className="border-b border-slate-200 w-full" />
      <div className="w-full mt-2 flex flex-col">
        {items.some((item) => item.action !== null) && (
          <SummaryComponent items={items} shipping={true} final={true} />
        )}
      </div>
    </div>
  );
};

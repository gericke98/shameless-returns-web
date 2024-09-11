import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { SummaryComponent } from "./summary";
import { ProductLineClient } from "./productLineClient";
import { FaArrowAltCircleLeft } from "react-icons/fa";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  shipping: boolean;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
};

export const LastWindow = ({
  items,
  shipping,
  position,
  setPosition,
}: Props) => {
  return (
    <div className="w-full h-full flex flex-col gap-3 mb-3">
      <Progress value={100} />
      <FaArrowAltCircleLeft
        size={25}
        className="mt-4 cursor-pointer"
        onClick={() => setPosition(position - 1)}
      />
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

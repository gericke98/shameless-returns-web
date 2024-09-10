import { productsOrder } from "@/db/schema";

type Props = {
  item: typeof productsOrder.$inferSelect;
  newAction: boolean;
};

export const SummaryLine = ({ item, newAction }: Props) => {
  return (
    <div className="w-full h-full flex flex-col pl-4 mt-4 gap-2">
      <div className="w-full h-full flex flex-row justify-between items-center">
        <h6 className="text-sm tracking-wide font-light">{item.title}</h6>
        <h6 className="text-sm font-light">
          {newAction && "- "}
          {item.price} €
        </h6>
      </div>
      <h6 className="text-xs tracking-wide font-light">{item.variant_title}</h6>
    </div>
  );
};

import { productsOrder } from "@/db/schema";

type SummaryLineProps = {
  item: typeof productsOrder.$inferSelect;
  newAction: boolean;
};

const ProductTitle = ({ title }: { title: string }) => (
  <h6 className="text-sm tracking-wide font-light">{title}</h6>
);

const ProductPrice = ({
  price,
  newAction,
}: {
  price: string;
  newAction: boolean;
}) => (
  <h6 className="text-sm font-light">
    {newAction && "- "}
    {price} €
  </h6>
);

const ProductVariant = ({
  variantTitle,
  newVariantTitle,
  newAction,
}: {
  variantTitle: string;
  newVariantTitle: string | null;
  newAction: boolean;
}) => (
  <h6 className="text-xs tracking-wide font-light">
    {newAction ? newVariantTitle : variantTitle}
  </h6>
);

export const SummaryLine = ({ item, newAction }: SummaryLineProps) => {
  return (
    <div className="w-full h-full flex flex-col pl-4 mt-4 gap-2">
      <div className="w-full h-full flex flex-row justify-between items-center">
        <ProductTitle title={item.title} />
        <ProductPrice price={item.price} newAction={newAction} />
      </div>
      <ProductVariant
        variantTitle={item.variant_title}
        newVariantTitle={item.new_variant_title}
        newAction={newAction}
      />
    </div>
  );
};

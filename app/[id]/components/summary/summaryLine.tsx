"use client";

import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import Image from "next/image";

type SummaryLineProps = {
  item: typeof productsOrder.$inferSelect;
  newAction: boolean;
  newProduct?: Product | null;
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
    {Number(price).toFixed(2)} €
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

export const SummaryLine = ({
  item,
  newAction,
  newProduct,
}: SummaryLineProps) => {
  return (
    <div className="w-full h-full flex flex-col pl-4 mt-4 gap-2">
      <div className="w-full h-full flex flex-col sm:flex-row sm:justify-between sm:items-center">
        <ProductTitle title={newProduct ? newProduct.title : item.title} />
        <ProductPrice
          price={
            newProduct ? newProduct.variants.edges[0]?.node.price : item.price
          }
          newAction={newAction}
        />
      </div>
      <ProductVariant
        variantTitle={item.variant_title}
        newVariantTitle={item.new_variant_title}
        newAction={newAction}
      />
    </div>
  );
};

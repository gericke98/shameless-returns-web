"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import Image from "next/image";
import { FormProduct } from "./dialogForm";
import { Product2, ProductImageProps, ProductInfoProps } from "@/types";
import { productsOrder } from "@/db/schema";
import { cn } from "@/lib/utils";
import { LiaExchangeAltSolid } from "react-icons/lia";
import { IoIosReturnLeft } from "react-icons/io";
import { useState } from "react";

// Types
type Props = {
  orderProduct: typeof productsOrder.$inferSelect;
  product: Product2;
};

// Components
const ProductImage = ({ src, alt, width, height }: ProductImageProps) => (
  <Image
    alt={alt}
    src={src}
    width={width}
    height={height}
    className="rounded-xl w-auto h-auto"
  />
);

const ActionIcon = ({ action }: { action: string }) => {
  if (action === "CAMBIO") {
    return <LiaExchangeAltSolid size={11} />;
  }
  return <IoIosReturnLeft size={11} />;
};

const ActionBadge = ({ action }: { action: string }) => (
  <div className="w-full h-5 flex flex-row items-center justify-center bg-blue-100 rounded-md max-w-24">
    <ActionIcon action={action} />
    <span className="text-xs font-light text-left align-text-middle px-2 flex-none">
      {action.charAt(0) + action.slice(1).toLowerCase()}
    </span>
  </div>
);

const VariantInfo = ({
  variant,
  changed,
  newVariant,
}: Pick<ProductInfoProps, "variant" | "changed" | "newVariant">) => (
  <div className="w-full flex flex-row gap-3">
    <span
      className={cn(
        "text-xs text-left font-normal text-slate-700",
        changed && "line-through"
      )}
    >
      {variant}
    </span>
    {changed && newVariant && (
      <span className="text-xs text-left font-normal text-slate-700">
        {newVariant}
      </span>
    )}
  </div>
);

const ProductInfo = ({
  title,
  variant,
  price,
  action,
  reason,
  confirmed,
  changed,
  newVariant,
}: ProductInfoProps) => (
  <div className="flex flex-col w-full gap-1 items-start">
    <span className="lg:text-base text-sm text-left font-bold leading-tight text-black">
      {title}
    </span>
    <VariantInfo variant={variant} changed={changed} newVariant={newVariant} />
    <span className="text-sm text-left font-bold leading-tight text-black">
      {price} €
    </span>
    {action && (
      <div className="flex flex-col justify-center gap-1 w-full">
        <ActionBadge action={action} />
        {reason && (
          <span className="text-xs font-light italic rounded-md text-left">
            &quot;{reason}&quot;
          </span>
        )}
      </div>
    )}
    {confirmed && (
      <span className="text-xs font-bold text-left px-1 py-2 flex-none bg-blue-200 rounded-md">
        El producto ya ha sido modificado
      </span>
    )}
  </div>
);

const ProductDialog = ({
  product,
  orderProduct,
  changed,
  setChanged,
  imageSrc,
  imageAlt,
}: Props & {
  changed: boolean;
  setChanged: React.Dispatch<React.SetStateAction<boolean>>;
  imageSrc: string;
  imageAlt: string;
}) => (
  <DialogContent className="my-10 max-w-96 max-h-screen overflow-scroll lg:mx-0 mx-2">
    <DialogHeader>
      <DialogTitle>
        <span className="text-2xl font-bold mt-8 mb-8">Selección</span>
      </DialogTitle>
    </DialogHeader>
    <DialogDescription asChild>
      <ScrollArea className="flex flex-col w-full items-start">
        <div className="w-full flex flex-row flex-nowrap gap-4">
          <ProductImage
            src={imageSrc}
            alt={imageAlt}
            width={100}
            height={100}
          />
          <ProductInfo
            title={orderProduct.title}
            variant={orderProduct.variant_title}
            price={orderProduct.price}
            action={orderProduct.action}
            reason={orderProduct.reason}
            confirmed={orderProduct.confirmed ?? false}
            changed={orderProduct.changed}
          />
        </div>
        <div className="w-full mt-2 max-h-full">
          <FormProduct
            product={product}
            orderProduct={orderProduct}
            changed={changed}
            setChanged={setChanged}
          />
        </div>
      </ScrollArea>
    </DialogDescription>
  </DialogContent>
);

export const ProductLineClient = ({ orderProduct, product }: Props) => {
  const [changed, setChanged] = useState<boolean>(false);
  const imageSrc = product?.image?.src || "/placeholder.jpg";
  const imageAlt = product.title || "Product image";

  return (
    <div
      className={cn(
        "w-full p-2 hover:bg-white hover:cursor-pointer",
        orderProduct.confirmed && "pointer-events-none cursor-none"
      )}
    >
      <Dialog>
        <DialogTrigger className="w-full flex flex-row flex-nowrap gap-4">
          <ProductImage
            src={imageSrc}
            alt={imageAlt}
            width={100}
            height={140}
          />
          <ProductInfo
            title={orderProduct.title}
            variant={orderProduct.variant_title}
            price={orderProduct.price}
            action={orderProduct.action}
            reason={orderProduct.reason}
            confirmed={orderProduct.confirmed ?? false}
            changed={orderProduct.changed ?? false}
            newVariant={orderProduct.new_variant_title ?? undefined}
          />
        </DialogTrigger>

        <ProductDialog
          product={product}
          orderProduct={orderProduct}
          changed={changed}
          setChanged={setChanged}
          imageSrc={imageSrc}
          imageAlt={imageAlt}
        />
      </Dialog>
    </div>
  );
};

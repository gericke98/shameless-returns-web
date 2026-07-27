"use client";

import { useState, useEffect } from "react";
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
import {
  ProductImageProps,
  ProductInfoProps,
  ProductLineProps,
  ProductDialogProps,
  Product,
} from "@/types";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/context";
import { reasonLabel } from "@/lib/reasons";
import { LiaExchangeAltSolid } from "react-icons/lia";
import { IoIosReturnLeft } from "react-icons/io";

const ProductImage = ({ src, alt, width, height }: ProductImageProps) => (
  <Image
    alt={alt}
    src={src}
    width={width}
    height={height}
    className="rounded-xl w-full sm:w-auto h-auto object-cover"
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
  isNewProduct,
}: Pick<ProductInfoProps, "variant" | "changed" | "newVariant"> & {
  isNewProduct: boolean;
}) => (
  <div className="w-full flex flex-row gap-3">
    <span
      className={cn(
        "text-xs text-left font-normal text-slate-700",
        changed && "line-through"
      )}
    >
      {variant}
    </span>
    {changed && newVariant && !isNewProduct && (
      <span className="text-xs text-left font-normal text-slate-700">
        {newVariant}
      </span>
    )}
  </div>
);

// `reason` is the value persisted in productsOrder.reason: a REASON_KEYS key
// for anything saved since the value/label split, or a legacy Spanish sentence
// for older rows. reasonLabel() localizes both and passes anything else
// through unchanged rather than rendering an empty note.
const ReasonNote = ({ reason }: { reason: string }) => {
  const t = useT();
  return (
    <span className="text-xs font-light italic rounded-md text-left">
      &quot;{reasonLabel(reason, t)}&quot;
    </span>
  );
};

const ProductInfo = ({
  title,
  variant,
  price,
  action,
  reason,
  confirmed,
  changed,
  newVariant,
  newProduct,
  isNewProduct,
}: ProductInfoProps & {
  newProduct?: Product | null;
  isNewProduct: boolean;
}) => (
  <div className="flex flex-col w-full gap-1 items-start">
    <span className="lg:text-base text-sm text-left font-bold leading-tight text-black">
      {title}
    </span>
    <VariantInfo
      variant={variant}
      changed={changed}
      newVariant={newVariant}
      isNewProduct={isNewProduct}
    />
    <span className="text-sm text-left font-bold leading-tight text-black">
      {Number(price).toFixed(2)} €
    </span>
    {action && (
      <div className="flex flex-col justify-center gap-1 w-full">
        <ActionBadge action={action} />
        {reason && <ReasonNote reason={reason} />}
      </div>
    )}
    {confirmed && (
      <span className="text-xs font-bold text-left px-1 py-2 flex-none bg-blue-200 rounded-md">
        El producto ya ha sido modificado
      </span>
    )}
    {changed && newProduct && isNewProduct && (
      <div className="mt-2 w-full flex items-center gap-2 p-2 bg-gray-50 rounded-md">
        <div className="relative w-8 h-8">
          <Image
            src={newProduct.image?.src || "/placeholder.jpg"}
            alt={newProduct.title}
            fill
            sizes="32px"
            className="object-cover rounded-sm"
          />
        </div>
        <div className="flex flex-col">
          <span className="text-xs font-medium">{newProduct.title}</span>
          <span className="text-xs text-gray-500">
            {newVariant} - {newProduct.variants.edges[0]?.node.price || ""} €
          </span>
        </div>
      </div>
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
  onSuccess,
  onItemChange,
  allProducts,
}: ProductDialogProps) => {
  const [newProduct, setNewProduct] = useState<Product | null>(null);

  // Find the new product if a change has been made
  useEffect(() => {
    if (orderProduct.new_variant_id) {
      // Find the product that matches the new variant ID
      const foundProduct = allProducts.find((p) =>
        p.variants.edges.some((v) => v.node.id === orderProduct.new_variant_id)
      );
      if (foundProduct) {
        setNewProduct(foundProduct);
      }
    } else {
      setNewProduct(null);
    }
  }, [orderProduct, allProducts]);

  const isNewProduct =
    newProduct?.id !== `gid://shopify/Product/${orderProduct.productId}`;

  return (
    <DialogContent className="my-10 w-full sm:max-w-lg max-h-screen overflow-y-auto mx-2 sm:mx-auto lg:pb-14">
      <DialogHeader>
        <DialogTitle>
          <span className="text-2xl font-bold mt-8 mb-8">Selección</span>
        </DialogTitle>
      </DialogHeader>
      <DialogDescription asChild>
        <ScrollArea className="flex flex-col w-full items-start">
          <div className="w-full flex flex-col sm:flex-row flex-nowrap gap-4">
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
              newVariant={orderProduct.new_variant_title ?? undefined}
              newProduct={newProduct}
              isNewProduct={isNewProduct}
            />
          </div>
          <div className="w-full mt-2">
            <FormProduct
              product={product}
              orderProduct={orderProduct}
              changed={changed}
              setChanged={setChanged}
              onSuccess={onSuccess}
              onItemChange={(updatedProduct) => {
                if (onItemChange) {
                  onItemChange(updatedProduct);
                }
                // Update the new product when a change is made
                if (updatedProduct.new_variant_id) {
                  const foundProduct = allProducts.find((p) =>
                    p.variants.edges.some(
                      (v) => v.node.id === updatedProduct.new_variant_id
                    )
                  );
                  if (foundProduct) {
                    setNewProduct(foundProduct);
                  }
                }
              }}
              allProducts={allProducts}
            />
          </div>
        </ScrollArea>
      </DialogDescription>
    </DialogContent>
  );
};

export const ProductLineClient = ({
  orderProduct,
  product,
  onItemChange,
  allProducts,
}: ProductLineProps) => {
  const [changed, setChanged] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const [newProduct, setNewProduct] = useState<Product | null>(null);

  // Find the new product if a change has been made
  useEffect(() => {
    if (orderProduct.new_variant_id) {
      // Find the product that matches the new variant ID
      const foundProduct = allProducts.find((p) =>
        p.variants.edges.some((v) => v.node.id === orderProduct.new_variant_id)
      );
      if (foundProduct) {
        setNewProduct(foundProduct);
      }
    } else {
      setNewProduct(null);
    }
  }, [orderProduct, allProducts]);

  const isNewProduct =
    newProduct?.id !== `gid://shopify/Product/${orderProduct.productId}`;
  const imageSrc = product?.image?.src || "/placeholder.jpg";
  const imageAlt = product.title || "Product image";

  return (
    <div
      className={cn(
        "w-full p-2 hover:bg-white hover:cursor-pointer",
        orderProduct.confirmed && "pointer-events-none cursor-none"
      )}
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger className="w-full flex flex-col sm:flex-row flex-nowrap gap-4">
          <ProductImage
            src={imageSrc}
            alt={imageAlt}
            width={100}
            height={140}
          />
          <ProductInfo
            title={product.title}
            variant={orderProduct.variant_title}
            price={orderProduct.price}
            action={orderProduct.action}
            reason={orderProduct.reason}
            confirmed={orderProduct.confirmed ?? false}
            changed={orderProduct.changed ?? false}
            newVariant={orderProduct.new_variant_title ?? undefined}
            newProduct={newProduct}
            isNewProduct={isNewProduct}
          />
        </DialogTrigger>

        <ProductDialog
          product={product}
          orderProduct={orderProduct}
          changed={changed}
          setChanged={setChanged}
          imageSrc={imageSrc}
          imageAlt={imageAlt}
          onSuccess={() => {
            setOpen(false);
            if (onItemChange) {
              const updatedItem = {
                ...orderProduct,
                products: [orderProduct],
              };
              onItemChange(updatedItem);
            }
          }}
          onItemChange={(updatedProduct) => {
            if (onItemChange) {
              onItemChange(updatedProduct);
            }
            // Update the new product when a change is made
            if (updatedProduct.new_variant_id) {
              const foundProduct = allProducts.find((p) =>
                p.variants.edges.some(
                  (v) => v.node.id === updatedProduct.new_variant_id
                )
              );

              if (foundProduct) {
                setNewProduct(foundProduct);
              }
            }
          }}
          allProducts={allProducts}
        />
      </Dialog>
    </div>
  );
};

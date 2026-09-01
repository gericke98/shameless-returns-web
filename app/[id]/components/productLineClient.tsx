"use client";

import { useState, useEffect, useMemo } from "react";
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
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros, type Dictionary, type Locale } from "@/lib/i18n";
import { reasonLabel } from "@/lib/reasons";
import {
  indexCatalogue,
  replacementPrice,
  type PricedLine,
} from "@/lib/replacementPricing";
import { ACTIONS } from "@/placeholder";
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

// `action` is the persisted code from productsOrder.action, not display text.
// This used to title-case the code itself, so the badge stayed Spanish even in
// English. Select the label off the code instead; the code itself is untouched.
// `t` is passed as a prop for consistency with sibling components declared at
// module scope (e.g. thirdWindow's StoreCredit).
const ActionBadge = ({ action, t }: { action: string; t: Dictionary }) => (
  <div className="w-full h-5 flex flex-row items-center justify-center bg-blue-100 rounded-md max-w-24">
    <ActionIcon action={action} />
    <span className="text-xs font-light text-left align-text-middle px-2 flex-none">
      {action === ACTIONS.CHANGE ? t.dialog.actionChange : t.dialog.actionReturn}
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
  newPrice,
  isNewProduct,
  t,
  locale,
}: ProductInfoProps & {
  newProduct?: Product | null;
  /** Per-line replacement price from lib/replacementPricing, priced against
   *  this line's own pairing rather than the new product's first-variant
   *  list price. Null when there is no priced replacement to show. */
  newPrice?: number | null;
  isNewProduct: boolean;
  t: Dictionary;
  locale: Locale;
}) => (
  <div className="flex flex-col w-full gap-1 items-start">
    {/* Title and price were both font-bold, which made the list read as a wall
        of bold. The title carries the emphasis now; the price sits back. */}
    <span className="lg:text-base text-sm text-left font-semibold leading-tight text-black">
      {title}
    </span>
    <VariantInfo
      variant={variant}
      changed={changed}
      newVariant={newVariant}
      isNewProduct={isNewProduct}
    />
    <span className="text-sm text-left font-normal leading-tight text-black">
      {formatEuros(Number(price), locale)}
    </span>
    {action && (
      <div className="flex flex-col justify-center gap-1 w-full">
        <ActionBadge action={action} t={t} />
        {reason && <ReasonNote reason={reason} />}
      </div>
    )}
    {confirmed && (
      <span className="text-xs font-bold text-left px-1 py-2 flex-none bg-blue-200 rounded-md">
        {t.productLine.alreadyModified}
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
            {newVariant} - {formatEuros(newPrice ?? 0, locale)}
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
  t,
  locale,
}: ProductDialogProps & { t: Dictionary; locale: Locale }) => {
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

  // Hoisted so the index is not rebuilt on every render; the price this line
  // charges the customer comes from lib/replacementPricing rather than the
  // new product's raw catalogue price.
  const catalogueIndex = useMemo(
    () => indexCatalogue(allProducts),
    [allProducts]
  );
  const newPrice = useMemo(
    () =>
      replacementPrice(orderProduct as unknown as PricedLine, catalogueIndex, null)
        .price,
    [orderProduct, catalogueIndex]
  );

  return (
    <DialogContent className="my-10 w-full sm:max-w-lg max-h-screen overflow-y-auto mx-2 sm:mx-auto lg:pb-14">
      <DialogHeader>
        <DialogTitle>
          <span className="text-2xl font-bold mt-8 mb-8">
            {t.productLine.selection}
          </span>
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
              newPrice={newPrice}
              isNewProduct={isNewProduct}
              t={t}
              locale={locale}
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
  const t = useT();
  const locale = useLocale();
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

  // Same reasoning as ProductDialog's copy above: hoisted, and priced
  // against this line's own pairing rather than the catalogue's raw price.
  const catalogueIndex = useMemo(
    () => indexCatalogue(allProducts),
    [allProducts]
  );
  const newPrice = useMemo(
    () =>
      replacementPrice(orderProduct as unknown as PricedLine, catalogueIndex, null)
        .price,
    [orderProduct, catalogueIndex]
  );

  return (
    <div
      className={cn(
        // rounded-2xl so the hover/selected white block has soft corners
        // instead of the square ones it used to render with.
        "w-full p-2 rounded-2xl transition-colors hover:bg-white hover:cursor-pointer",
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
            newPrice={newPrice}
            isNewProduct={isNewProduct}
            t={t}
            locale={locale}
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
          t={t}
          locale={locale}
        />
      </Dialog>
    </div>
  );
};

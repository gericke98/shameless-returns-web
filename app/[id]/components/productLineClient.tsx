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
import { FormProduct } from "../form";
import { Product } from "@/types";
import { productsOrder } from "@/db/schema";
import { cn } from "@/lib/utils";

type Props = {
  orderProduct: typeof productsOrder.$inferSelect;
  product: Product;
};

export const ProductLineClient = ({ orderProduct, product }: Props) => {
  return (
    <div className="w-full p-2 hover:bg-slate-100">
      <Dialog>
        <DialogTrigger className="w-full flex flex-row flex-nowrap gap-4">
          <Image
            alt={product.image.src}
            src={product.image.src}
            width={100}
            height={100}
            className="rounded-xl"
          />
          <div className="flex flex-col w-full gap-1 items-start">
            <h3 className="text-base text-left font-bold leading-tight text-black">
              {orderProduct.title}
            </h3>
            <div className="w-full flex flex-row gap-3">
              <h5
                className={cn(
                  "text-xs text-left font-normal text-slate-700",
                  orderProduct.changed && "line-through"
                )}
              >
                {orderProduct.variant_title}
              </h5>
              {orderProduct.changed && (
                <h5 className="text-xs text-left font-normal text-slate-700">
                  {orderProduct.new_variant_title}
                </h5>
              )}
            </div>
            <h4 className="text-sm text-left font-bold leading-tight text-black">
              {orderProduct.price} €
            </h4>
            {orderProduct.action && (
              <div className="flex flex-col gap-1 w-full">
                <h5 className="text-sm bg-blue-200 rounded-md px-2 w-2/3">
                  {orderProduct.action}
                </h5>
                <h5 className="text-xs italic rounded-md px-2 text-left">
                  {orderProduct.reason}
                </h5>
              </div>
            )}
          </div>
        </DialogTrigger>
        <DialogContent className="my-10 max-w-96 max-h-screen overflow-scroll">
          <DialogHeader>
            <DialogTitle>
              <h5 className="text-2xl font-bold mt-8 mb-8">Selección</h5>
            </DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <ScrollArea className="flex flex-col w-full items-start">
              <div className="w-full flex flex-row flex-nowrap gap-4">
                <Image
                  alt={product.image.src}
                  src={product.image.src}
                  width={100}
                  height={100}
                  className="rounded-xl"
                />
                <div className="flex flex-col w-full gap-1 items-start">
                  <h3 className="text-base font-bold leading-tight text-black">
                    {orderProduct.title}
                  </h3>
                  <h5 className="text-xs font-normal text-slate-700">
                    {orderProduct.variant_title}
                  </h5>
                  <h4 className="text-sm font-bold leading-tight text-black">
                    {orderProduct.price} €
                  </h4>
                </div>
              </div>
              <div className="w-full mt-2 max-h-full">
                <FormProduct product={product} orderProduct={orderProduct} />
              </div>
            </ScrollArea>
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </div>
  );
};

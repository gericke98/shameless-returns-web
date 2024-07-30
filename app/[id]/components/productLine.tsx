import { getProduct } from "@/db/queries";
import { ProductLineClient } from "./productLineClient";
import { productsOrder } from "@/db/schema";
import { redirect } from "next/navigation";

type Props = {
  orderProduct: typeof productsOrder.$inferSelect;
};

export async function ProductLine({ orderProduct }: Props) {
  // Get product image
  if (!orderProduct.id) {
    redirect("/");
  }
  const product = await getProduct(orderProduct.productId.toString());
  return (
    <ProductLineClient orderProduct={orderProduct} product={product.product} />
  );
}

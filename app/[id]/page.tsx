import { getOrderById, getProduct } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";

type Props = {
  params: {
    id: string;
  };
};
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function OrderPage({ params }: Props) {
  // Le doy a la base de datos tiempo a cargarse
  await delay(3000);
  // Get order
  const order = await getOrderById(params.id);
  order.products = await Promise.all(
    order.products.map(async (product) => {
      const newp = await getProduct(product.productId.toString());
      return {
        ...product,
        newp,
      };
    })
  );

  if (!order) {
    redirect("/");
  }
  return (
    <ClientOrder
      name={order.orderNumber}
      items={order.products}
      order={order}
      id={order.id}
    />
  );
}

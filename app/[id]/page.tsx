import { getOrderById, getProduct } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";

type Props = {
  params: {
    id: string;
  };
};
export default async function OrderPage({ params }: Props) {
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

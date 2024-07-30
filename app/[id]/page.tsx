import { getOrderById } from "@/db/queries";
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

  if (!order) {
    redirect("/");
  }
  return (
    <ClientOrder
      name={order.orderNumber}
      items={order.products}
      id={order.id}
    />
  );
}

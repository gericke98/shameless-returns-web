import { getOrderById, getProduct } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";

type OrderPageProps = {
  params: {
    id: string;
  };
};

async function fetchOrderWithProducts(orderId: string) {
  const order = await getOrderById(orderId);

  if (!order) {
    return null;
  }

  const productsWithDetails = await Promise.all(
    order.products.map(async (product) => {
      const productDetails = await getProduct(product.productId.toString());
      return {
        ...product,
        newp: productDetails,
      };
    })
  );
  console.log("Paso por server");

  return {
    ...order,
    products: productsWithDetails,
  };
}

export default async function OrderPage({ params }: OrderPageProps) {
  // Remove the artificial delay for immediate responsiveness.
  // await new Promise((resolve) => setTimeout(resolve, 3000));

  const orderData = await fetchOrderWithProducts(params.id);

  if (!orderData) {
    redirect("/");
  }

  return (
    <ClientOrder
      name={orderData.orderNumber}
      items={orderData.products}
      order={orderData}
      id={orderData.id}
    />
  );
}

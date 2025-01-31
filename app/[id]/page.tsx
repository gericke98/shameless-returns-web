import { getOrderById, getProduct } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";

type OrderPageProps = {
  params: {
    id: string;
  };
};

const LOADING_DELAY = 3000;

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

  return {
    ...order,
    products: productsWithDetails,
  };
}

export default async function OrderPage({ params }: OrderPageProps) {
  // Allow time for database to load
  await new Promise((resolve) => setTimeout(resolve, LOADING_DELAY));

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

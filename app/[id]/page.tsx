import { getOrderById, getProduct, getProducts } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";
import { applyGlobalDiscount } from "@/lib/basket";
import { getFeeTable } from "@/db/fees";
import { feesForCountry } from "@/lib/fees";
import { normalizeCountry } from "@/lib/countries";
import { FeesProvider } from "./feesContext";

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

  return {
    ...order,
    products: productsWithDetails,
  };
}

export default async function OrderPage({ params }: OrderPageProps) {
  // Remove the artificial delay for immediate responsiveness.
  // await new Promise((resolve) => setTimeout(resolve, 3000));

  const orderData = await fetchOrderWithProducts(params.id);
  const allProducts = await getProducts();

  if (!orderData) {
    redirect("/");
  }

  const discountedAllProducts = applyGlobalDiscount(
    allProducts,
    orderData.products[0]
  );

  const feeTable = await getFeeTable();
  const fees = feesForCountry(
    feeTable,
    normalizeCountry(orderData.shippingCountry)
  );

  return (
    <FeesProvider fees={fees}>
      <ClientOrder
        name={orderData.orderNumber}
        items={orderData.products}
        order={orderData}
        id={orderData.id}
        allProducts={discountedAllProducts}
      />
    </FeesProvider>
  );
}

import { getOrderById, getProduct, getProducts } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";
import { Product } from "@/types";

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

  // Calculate the discount using the first product
  const firstProduct = orderData.products[0];
  const firstProductId = firstProduct.productId.toString();
  const firstCurrentProduct = allProducts.find((p: Product) => {
    const shopifyId = p.id.split("/").pop();
    return shopifyId === firstProductId;
  });

  // Calculate the global discount ratio
  let globalDiscountRatio = 1;
  if (firstCurrentProduct) {
    const orderPrice = parseFloat(firstProduct.price);
    const currentPrice = parseFloat(
      firstCurrentProduct.variants.edges[0].node.price
    );
    globalDiscountRatio = orderPrice / currentPrice;
  }

  // Apply the discount to all products in allProducts
  const discountedAllProducts = allProducts.map((product: Product) => {
    // Apply the discount to each variant
    const discountedVariants = {
      ...product.variants,
      edges: product.variants.edges.map(
        (edge: { node: { price: string } }) => ({
          ...edge,
          node: {
            ...edge.node,
            price: (parseFloat(edge.node.price) * globalDiscountRatio).toFixed(
              2
            ),
          },
        })
      ),
    };

    return {
      ...product,
      variants: discountedVariants,
    };
  });

  return (
    <ClientOrder
      name={orderData.orderNumber}
      items={orderData.products}
      order={orderData}
      id={orderData.id}
      allProducts={discountedAllProducts}
    />
  );
}

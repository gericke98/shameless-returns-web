import { getOrderById, getProduct, getProducts } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";
import { applyGlobalDiscount } from "@/lib/basket";
import { getFeeTable } from "@/db/fees";
import { feesForCountry } from "@/lib/fees";
import { normalizeCountry } from "@/lib/countries";
import { resolveZone } from "@/lib/zones";
import { FeesProvider } from "./feesContext";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, readLocale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/context";
import { hasOrderAccess } from "@/lib/orderAccess";

/**
 * The return submission runs as a server action on THIS segment, and it is a
 * chain of third-party calls: Shopify `returnCreate`, then either the Correos
 * SOAP preregistro or the Amphora booking (create + read-back), then Postmark.
 *
 * On the platform default of 15s that chain does not fit. Order #310957 died
 * mid-flight — Shopify had the return and Amphora had the collection, but the
 * function was killed before the confirmation email, so the customer was
 * charged for a pickup and told nothing. Raising this is the difference between
 * a slow submit and a silently half-created return.
 */
export const maxDuration = 60;

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
  // Before anything is fetched or rendered. orders.id is the raw Shopify order
  // id — sequential and enumerable — and this page renders the customer's name,
  // street address and phone, so possession of the URL cannot be the credential.
  //
  // Absent, expired, and issued-for-another-order are treated identically on
  // purpose: the response must not reveal whether this id names a real order.
  if (!(await hasOrderAccess(params.id))) {
    redirect("/?session=expired");
  }

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
    resolveZone(orderData.shippingCountry, orderData.shippingZip)
  );

  const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);

  return (
    <LocaleProvider locale={locale}>
      <FeesProvider fees={fees}>
        <ClientOrder
          name={orderData.orderNumber}
          items={orderData.products}
          order={orderData}
          id={orderData.id}
          allProducts={discountedAllProducts}
        />
      </FeesProvider>
    </LocaleProvider>
  );
}

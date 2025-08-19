import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { LogoutButton } from "./LogoutButton";
import { getReturns, getProducts } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import DashboardHeader from "./components/DashboardHeader";
import ReturnsTable from "./components/ReturnsTable";
import EmptyState from "./components/EmptyState";
import { Suspense } from "react";
import { Metadata } from "next";
import { ErrorBoundary } from "react-error-boundary";
import ErrorMessage from "./components/ErrorMessage";

export const metadata: Metadata = {
  title: "Admin Dashboard | Shameless Returns",
  description: "Manage returns and refunds for Shameless Returns",
};

function LoadingSpinner() {
  return (
    <div className="bg-white shadow-sm rounded-lg p-6 text-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto"></div>
      <p className="mt-4 text-gray-500">Loading returns...</p>
    </div>
  );
}

async function ReturnsList() {
  try {
    const returns = await getReturns();

    // Fetch all products to get product information for variants
    let allProducts: any[] = [];
    try {
      allProducts = await getProducts();
    } catch (error) {
      console.error("Error fetching products:", error);
    }

    const flattenedReturns = await Promise.all(
      returns.map(async (order) => {
        let status = order.locator || "No tracking number";
        if (order.locator) {
          try {
            status = (await obtainLastStatus(order.locator)) ?? order.locator;
          } catch (error) {
            console.error(
              `Error fetching status for order ${order.id}:`,
              error
            );
            status = order.locator;
          }
        }

        return Promise.all(
          order.products.map(async (product) => {
            let newProductInfo = null;

            // If this is a change action and we have a new variant ID, fetch the product info
            if (product.action === "CAMBIO" && product.new_variant_id) {
              try {
                // Find the product that contains this variant ID
                const newProduct = allProducts.find((p) =>
                  p.variants.edges.some(
                    (v: any) => v.node.id === product.new_variant_id
                  )
                );

                if (newProduct) {
                  // Find the specific variant
                  const newVariant = newProduct.variants.edges.find(
                    (v: any) => v.node.id === product.new_variant_id
                  );

                  newProductInfo = {
                    title: newProduct.title,
                    variant_title: newVariant
                      ? newVariant.node.title
                      : product.new_variant_title || "Unknown variant",
                  };
                } else {
                  // Fallback to parsing new_variant_title if we can't find the product
                  if (product.new_variant_title) {
                    // Try to parse the new_variant_title to separate product and variant
                    // Format is usually "Product Name - Variant Name"
                    const parts = product.new_variant_title.split(" - ");
                    if (parts.length >= 2) {
                      newProductInfo = {
                        title: parts[0].trim(),
                        variant_title: parts.slice(1).join(" - ").trim(),
                      };
                    } else {
                      // If we can't parse it, use the full title as product name
                      newProductInfo = {
                        title: product.new_variant_title,
                        variant_title: "Unknown variant",
                      };
                    }
                  } else {
                    newProductInfo = {
                      title: "Unknown Product",
                      variant_title: "Unknown variant",
                    };
                  }
                }
              } catch (error) {
                console.error(
                  `Error processing new product info for variant ${product.new_variant_id}:`,
                  error
                );
                // Fallback to just the variant title if we can't process it
                newProductInfo = {
                  title: "Unknown Product",
                  variant_title: product.new_variant_title || "Unknown variant",
                };
              }
            }

            return {
              order,
              product: {
                ...product,
                new_variant_title: product.new_variant_title || null,
                new_product_info: newProductInfo,
              },
              status,
            };
          })
        );
      })
    ).then((arrays) => arrays.flat());

    return flattenedReturns.length === 0 ? (
      <EmptyState />
    ) : (
      <ReturnsTable returns={flattenedReturns} />
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error("Failed to load returns");
  }
}

async function validateSession() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "admin") {
    redirect("/login");
  }

  return session;
}

export default async function DashboardPage() {
  const session = await validateSession();

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-semibold">Admin Dashboard</h1>
            </div>
            <div className="flex items-center">
              <span className="mr-4 text-gray-700">{session.user.email}</span>
              <LogoutButton />
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <DashboardHeader username={session.user.username} />
        <ErrorBoundary FallbackComponent={ErrorMessage}>
          <Suspense fallback={<LoadingSpinner />}>
            <ReturnsList />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

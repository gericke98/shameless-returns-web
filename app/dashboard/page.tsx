import { redirect } from "next/navigation";
import { checkAuth } from "@/actions/authentication";
import { getReturns } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import DashboardHeader from "./components/DashboardHeader";
import ReturnsTable from "./components/ReturnsTable";
import EmptyState from "./components/EmptyState";

export default async function DashboardPage() {
  const isAuthenticated = await checkAuth();

  if (!isAuthenticated) {
    redirect("/login");
  }

  const returns = await getReturns();
  const flattenedReturns = await Promise.all(
    returns.map(async (order) => {
      let status = (await obtainLastStatus(order.locator)) ?? order.locator;
      return order.products.map((product) => ({
        order,
        product,
        status,
      }));
    })
  ).then((arrays) => arrays.flat());

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        <DashboardHeader username={isAuthenticated.user.username} />
        {flattenedReturns.length === 0 ? (
          <EmptyState />
        ) : (
          <ReturnsTable returns={flattenedReturns} />
        )}
      </div>
    </div>
  );
}

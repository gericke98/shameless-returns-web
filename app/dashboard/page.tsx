import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { LogoutButton } from "./LogoutButton";
import { getReturns } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import DashboardHeader from "./components/DashboardHeader";
import ReturnsTable from "./components/ReturnsTable";
import EmptyState from "./components/EmptyState";

export default async function DashboardPage() {
  console.log("DashboardPage");
  const session = await getServerSession(authOptions);
  console.log("DashboardPage2");
  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "admin") {
    redirect("/login");
  }

  const returns = await getReturns();
  const flattenedReturns = await Promise.all(
    returns.map(async (order) => {
      // Only fetch status if there's a tracking number
      let status = order.locator || "No tracking number";
      if (order.locator) {
        try {
          status = (await obtainLastStatus(order.locator)) ?? order.locator;
        } catch (error) {
          console.error(`Error fetching status for order ${order.id}:`, error);
          status = order.locator;
        }
      }
      return order.products.map((product) => ({
        order,
        product,
        status,
      }));
    })
  ).then((arrays) => arrays.flat());

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-semibold">Admin Dashboard</h1>
            </div>
            <div className="flex items-center">
              <span className="mr-4">{session.user.email}</span>
              <LogoutButton />
            </div>
          </div>
        </div>
      </nav>
      <div className="max-w-7xl mx-auto">
        <DashboardHeader username={session.user.username} />
        {flattenedReturns.length === 0 ? (
          <EmptyState />
        ) : (
          <ReturnsTable returns={flattenedReturns} />
        )}
      </div>
    </div>
  );
}

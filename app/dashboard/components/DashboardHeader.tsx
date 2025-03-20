import { LogoutButton } from "../LogoutButton";
import { DashboardHeaderProps } from "@/types";

export default function DashboardHeader({ username }: DashboardHeaderProps) {
  return (
    <div className="flex justify-between items-center mb-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Returns Dashboard</h1>
        <p className="text-sm text-gray-600">Welcome back, {username}</p>
      </div>
      <LogoutButton />
    </div>
  );
}

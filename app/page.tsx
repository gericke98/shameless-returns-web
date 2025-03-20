import { InputComponent } from "@/components/inputComponent";
import { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Shameless Returns | Order Search",
  description: "Search and manage your Shameless Returns order",
};

function LoadingState() {
  return (
    <div className="animate-pulse">
      <div className="h-[150px] w-[150px] bg-gray-200 rounded-lg mb-5" />
      <div className="h-4 w-3/4 bg-gray-200 rounded mb-10" />
      <div className="h-4 w-full bg-gray-200 rounded mb-8" />
      <div className="space-y-4">
        <div className="h-12 bg-gray-200 rounded" />
        <div className="h-12 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

/**
 * Home page component
 * Displays the order search form in a centered layout
 */
const Home = () => {
  return (
    <main className="min-h-screen grid place-items-center bg-black-pattern">
      <div className="bg-white rounded-3xl py-5 px-4 lg:px-6 w-[85%] lg:w-[30%] flex flex-col items-center">
        <Suspense fallback={<LoadingState />}>
          <InputComponent />
        </Suspense>
      </div>
    </main>
  );
};

export default Home;

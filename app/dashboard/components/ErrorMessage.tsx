"use client";

export default function ErrorMessage({ error }: { error: Error }) {
  return (
    <div className="bg-white shadow-sm rounded-lg p-6 text-center">
      <div className="text-red-600 mb-2">Error loading returns</div>
      <p className="text-gray-500">
        {error.message || "Please try again later"}
      </p>
    </div>
  );
}

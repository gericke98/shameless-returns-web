export default function EmptyState() {
  return (
    <div className="bg-white shadow-sm rounded-lg p-8 text-center">
      <div className="mx-auto h-12 w-12 text-gray-400">
        <svg
          className="h-12 w-12"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
          />
        </svg>
      </div>
      <h3 className="mt-2 text-sm font-medium text-gray-900">
        No returns found
      </h3>
      <p className="mt-1 text-sm text-gray-500">
        Get started by creating a new return.
      </p>
      <div className="mt-6">
        <a
          href="/"
          className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          Create Return
        </a>
      </div>
    </div>
  );
}

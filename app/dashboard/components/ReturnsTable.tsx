"use client";

import { validateReturn } from "@/actions/refund";

interface ReturnTableProps {
  returns: Array<{
    order: any; // Replace with proper type
    product: any; // Replace with proper type
    status: string;
  }>;
}

export default function ReturnsTable({ returns }: ReturnTableProps) {
  return (
    <div className="bg-white shadow-sm rounded-lg overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 table-auto">
        <TableHeader />
        <tbody className="bg-white divide-y divide-gray-200">
          {returns.map(({ order, product, status }) => (
            <TableRow
              key={`${order.id}-${product.id}`}
              order={order}
              product={product}
              status={status}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableHeader() {
  const headers = [
    "Order Number",
    "Customer Email",
    "Product",
    "Quantity",
    "Price",
    "Action",
    "Refunded",
    "Status",
    "Validate",
  ];

  return (
    <thead className="bg-gray-50">
      <tr>
        {headers.map((header) => (
          <th
            key={header}
            className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
          >
            {header}
          </th>
        ))}
      </tr>
    </thead>
  );
}

interface TableRowProps {
  order: any; // Replace with proper type when available
  product: any; // Replace with proper type when available
  status: string;
}

function TableRow({ order, product, status }: TableRowProps) {
  return (
    <tr>
      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
        {order.orderNumber}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {order.email}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.title} - {product.variant_title}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.quantity}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.price} €
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.action}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.refunded ? "Yes" : "No"}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {status ? status : order.locator}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.refunded ? (
          <h5>Refunded</h5>
        ) : (
          <button
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm"
            onClick={() => validateReturn(product, status)}
          >
            Refund
          </button>
        )}
      </td>
    </tr>
  );
}

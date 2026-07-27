"use client";

import { validateReturn } from "@/actions/refund";
import { useEffect, useMemo, useState } from "react";
import {
  ReturnTableProps,
  RefundFilter,
  ShippingStatus,
  TableRowProps,
} from "@/types";

export default function ReturnsTable({ returns }: ReturnTableProps) {
  // State for search, filter, and pagination
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatusRefunded, setFilterStatusRefunded] =
    useState<RefundFilter>("all");
  const [filterStatusShipping, setFilterStatusShipping] =
    useState<ShippingStatus>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, string>
  >({});
  const resultsPerPage = 15;

  const resolveStatus = (order: TableRowProps["order"], status: string) => {
    if (!order.locator) return status;
    return statusOverrides[order.locator] ?? status;
  };

  // Filtering the returns
  const filteredReturns = returns.filter(({ order, product, status }) => {
    const resolvedStatus = resolveStatus(order, status);
    const searchMatch =
      order.orderNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.shippingName.toLowerCase().includes(searchTerm.toLowerCase());
    const filterMatchRef =
      filterStatusRefunded === "all" ||
      (filterStatusRefunded === "refunded" && product.refunded) ||
      (filterStatusRefunded === "not_refunded" && !product.refunded);
    const filterMatchShip =
      filterStatusShipping === "all" ||
      filterStatusShipping === resolvedStatus;

    return searchMatch && filterMatchRef && filterMatchShip;
  });

  // Pagination Logic
  const totalPages = Math.ceil(filteredReturns.length / resultsPerPage);
  const paginatedReturns = filteredReturns.slice(
    (currentPage - 1) * resultsPerPage,
    currentPage * resultsPerPage
  );

  const paginatedLocators = useMemo(() => {
    const locators = new Set<string>();
    paginatedReturns.forEach(({ order }) => {
      if (order.locator) locators.add(order.locator);
    });
    return Array.from(locators);
  }, [paginatedReturns]);

  const locatorsToFetch = useMemo(
    () => paginatedLocators.filter((locator) => !statusOverrides[locator]),
    [paginatedLocators, statusOverrides]
  );

  useEffect(() => {
    if (locatorsToFetch.length === 0) return;

    let cancelled = false;

    const fetchStatuses = async () => {
      const results = await Promise.all(
        locatorsToFetch.map(async (locator) => {
          try {
            const response = await fetch(
              `/api/shipping-status?locator=${encodeURIComponent(locator)}`
            );
            if (!response.ok) {
              throw new Error("Failed to fetch shipping status");
            }
            const data = await response.json();
            return [locator, data.status as string] as const;
          } catch (error) {
            console.error("Error fetching shipping status:", error);
            return [locator, locator] as const;
          }
        })
      );

      if (cancelled) return;

      setStatusOverrides((prev) => {
        const next = { ...prev };
        results.forEach(([locator, status]) => {
          next[locator] = status;
        });
        return next;
      });
    };

    fetchStatuses();

    return () => {
      cancelled = true;
    };
  }, [locatorsToFetch]);

  return (
    <div className="bg-white shadow-sm rounded-lg p-4">
      {/* Search & Filter Section */}
      <div className="flex justify-between items-center mb-4">
        <input
          type="text"
          placeholder="Search by Order or Email..."
          className="p-2 border rounded-md w-1/3"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          aria-label="Search returns"
        />
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Refunded</span>
          <select
            className="p-2 border rounded-md"
            value={filterStatusRefunded}
            onChange={(e) =>
              setFilterStatusRefunded(e.target.value as RefundFilter)
            }
            aria-label="Filter by refund status"
          >
            <option value="all">All</option>
            <option value="refunded">Refunded</option>
            <option value="not_refunded">Not Refunded</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Shipping Status</span>
          <select
            className="p-2 border rounded-md"
            value={filterStatusShipping}
            onChange={(e) =>
              setFilterStatusShipping(e.target.value as ShippingStatus)
            }
            aria-label="Filter by shipping status"
          >
            <option value="all">All</option>
            <option value="prerregistrado">Prerregistrado</option>
            <option value="admitido">Admitido</option>
            <option value="clasificado">Clasificado</option>
            <option value="en tránsito">En tránsito</option>
            <option value="en reparto">En reparto</option>
            <option value="entregado">Entregado</option>
          </select>
        </div>
      </div>
      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 table-auto">
          <TableHeader />
          <tbody className="bg-white divide-y divide-gray-200">
            {paginatedReturns.map(({ order, product, status }) => (
              <TableRow
                key={`${order.id}-${product.id}`}
                order={order}
                product={product}
                status={
                  order.locator && !statusOverrides[order.locator]
                    ? "Loading status..."
                    : resolveStatus(order, status)
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      {/* Pagination Controls */}
      <div className="flex justify-between items-center mt-4">
        <button
          className="px-4 py-2 bg-gray-300 rounded-md disabled:opacity-50"
          disabled={currentPage === 1}
          onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
        >
          Previous
        </button>
        <span>
          Page {currentPage} of {totalPages}
        </span>
        <button
          className="px-4 py-2 bg-gray-300 rounded-md disabled:opacity-50"
          disabled={currentPage === totalPages}
          onClick={() =>
            setCurrentPage((prev) => Math.min(prev + 1, totalPages))
          }
        >
          Next
        </button>
      </div>
    </div>
  );
}

function TableHeader() {
  const headers = [
    "Order Number",
    "Customer Name",
    "Customer Email",
    "Product",
    "Quantity",
    "Price",
    "Action",
    "New Product",
    "New Variant",
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

function TableRow({ order, product, status }: TableRowProps) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
        {order.orderNumber}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {order.shippingName}
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
        {product.action || "No action"}
      </td>
      {/* HAZARD: "DEVOLUCION" here is unaccented and the column stores the
          accented ACTIONS.RETURN ("DEVOLUCIÓN"), so this branch never matches
          and both columns render "-" for every return.
          Left as-is deliberately: swapping in ACTIONS.RETURN would change what
          this dashboard displays, which is a behaviour change and needs its
          own review — do not "fix" it as a drive-by. */}
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.action === "CAMBIO" && product.new_product_info
          ? product.new_product_info.title
          : product.action === "DEVOLUCION"
          ? "DEVOLUCION"
          : "-"}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.action === "CAMBIO" && product.new_product_info
          ? product.new_product_info.variant_title
          : product.action === "DEVOLUCION"
          ? "DEVOLUCION"
          : "-"}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.refunded ? "Yes" : "No"}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {status || "No tracking number"}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
        {product.refunded ? (
          <span className="text-green-600">Refunded</span>
        ) : (
          <button
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm transition-colors"
            onClick={() => validateReturn(product, status, order)}
            aria-label={`Refund ${product.title}`}
          >
            Refund
          </button>
        )}
      </td>
    </tr>
  );
}

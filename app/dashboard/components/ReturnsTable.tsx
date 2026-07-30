"use client";

import { validateReturn } from "@/actions/refund";
import { ACTIONS } from "@/placeholder";
import { useEffect, useMemo, useState } from "react";
import {
  ReturnTableProps,
  RefundFilter,
  ShippingStatus,
  DashboardOrder,
  DashboardProduct,
} from "@/types";
import { tracksWithCorreos, type TrackingStatus } from "@/lib/trackingStatus";
import {
  countProducts,
  filterGroups,
  groupReturns,
  pendingExchanges as pendingExchangeLines,
  type ReturnGroup,
} from "@/lib/dashboardGrouping";

type Group = ReturnGroup<DashboardOrder, DashboardProduct, TrackingStatus>;

const ORDERS_PER_PAGE = 15;

export default function ReturnsTable({ returns }: ReturnTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatusRefunded, setFilterStatusRefunded] =
    useState<RefundFilter>("all");
  const [filterStatusShipping, setFilterStatusShipping] =
    useState<ShippingStatus>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, TrackingStatus>
  >({});

  /** Only Correos parcels can be looked up in the Correos localizador. An
   *  Amphora collection already carries its status from the webhook. */
  const isLookupable = (order: DashboardOrder) =>
    tracksWithCorreos(order.carrier) && !!order.locator;

  const resolveStatus = (group: Group): TrackingStatus => {
    if (!isLookupable(group.order)) return group.status;
    return statusOverrides[group.order.locator!] ?? group.status;
  };

  // One group per ORDER. The table used to render a row per garment, repeating
  // the order number, customer and status once each, so a two-garment return
  // read as two unrelated returns. Rows stay per-garment inside the group —
  // refunding is a per-garment action and must remain one.
  const groups = useMemo(() => groupReturns(returns), [returns]);

  const filteredGroups = useMemo(
    () =>
      filterGroups(groups, {
        searchTerm,
        keepProduct: (product) =>
          filterStatusRefunded === "all" ||
          (filterStatusRefunded === "refunded" && !!product.refunded) ||
          (filterStatusRefunded === "not_refunded" && !product.refunded),
        keepStatus: () => true,
      }).filter(
        // Compare canonical phases, not display text: this compared the option
        // value "admitido" against Correos's own "Admitido." — with a trailing
        // period — so no selection ever matched a row.
        (group) =>
          filterStatusShipping === "all" ||
          filterStatusShipping === resolveStatus(group).phase
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, searchTerm, filterStatusRefunded, filterStatusShipping, statusOverrides]
  );

  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / ORDERS_PER_PAGE));
  const page = Math.min(currentPage, totalPages);
  const paginatedGroups = filteredGroups.slice(
    (page - 1) * ORDERS_PER_PAGE,
    page * ORDERS_PER_PAGE
  );

  const locatorsToFetch = useMemo(() => {
    const locators = new Set<string>();
    paginatedGroups.forEach((group) => {
      if (isLookupable(group.order) && !statusOverrides[group.order.locator!]) {
        locators.add(group.order.locator!);
      }
    });
    return Array.from(locators);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paginatedGroups, statusOverrides]);

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
            if (!response.ok) throw new Error("Failed to fetch shipping status");
            const data = await response.json();
            return [
              locator,
              { label: data.label, phase: data.phase } as TrackingStatus,
            ] as const;
          } catch (error) {
            // Never fall back to the locator itself — showing the tracking
            // number in the Status column reads as a status.
            console.error("Error fetching shipping status:", error);
            return [
              locator,
              { label: "Sin información", phase: "sin_informacion" },
            ] as const;
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

  const garmentCount = countProducts(filteredGroups);

  return (
    <div className="bg-white shadow-sm rounded-lg p-4">
      {/* Search & Filter Section */}
      <div className="flex justify-between items-center mb-4">
        <input
          type="text"
          placeholder="Search by Order or Email..."
          className="p-2 border rounded-md w-1/3"
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setCurrentPage(1);
          }}
          aria-label="Search returns"
        />
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Refunded</span>
          <select
            className="p-2 border rounded-md"
            value={filterStatusRefunded}
            onChange={(e) => {
              setFilterStatusRefunded(e.target.value as RefundFilter);
              setCurrentPage(1);
            }}
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
            onChange={(e) => {
              setFilterStatusShipping(e.target.value as ShippingStatus);
              setCurrentPage(1);
            }}
            aria-label="Filter by shipping status"
          >
            <option value="all">All</option>
            <option value="prerregistrado">Prerregistrado</option>
            <option value="admitido">Admitido / recogida programada</option>
            <option value="en_transito">En tránsito</option>
            <option value="en_reparto">En reparto</option>
            <option value="entregado">Entregado</option>
            <option value="incidencia">Incidencia</option>
            <option value="sin_informacion">Sin información</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 table-auto">
          <TableHeader />
          <tbody className="divide-y divide-gray-200">
            {paginatedGroups.map((group) => (
              <OrderGroup
                key={group.order.id}
                group={group}
                status={resolveStatus(group)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      <div className="flex justify-between items-center mt-4">
        <button
          className="px-4 py-2 bg-gray-300 rounded-md disabled:opacity-50"
          disabled={page === 1}
          onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
        >
          Previous
        </button>
        {/* Pages count ORDERS, so the garment total is spelled out — otherwise
            the page size looks like it silently dropped rows. */}
        <span className="text-sm text-gray-600">
          Page {page} of {totalPages} · {filteredGroups.length} orders (
          {garmentCount} garments)
        </span>
        <button
          className="px-4 py-2 bg-gray-300 rounded-md disabled:opacity-50"
          disabled={page === totalPages}
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

/** An unknown status must not look like a normal one — "Sin información" in
 *  the same grey as "Entregado" is how 82 untraceable parcels went unnoticed. */
const PHASE_STYLES: Record<TrackingStatus["phase"], string> = {
  entregado: "text-green-700 font-medium",
  en_reparto: "text-blue-600",
  en_transito: "text-blue-600",
  admitido: "text-gray-700",
  prerregistrado: "text-amber-600",
  incidencia: "text-red-600 font-medium",
  sin_informacion: "text-gray-400 italic",
};

const COLUMNS = [
  "Product",
  "Variant",
  "Qty",
  "Price",
  "Action",
  "New Product",
  "New Variant",
  "Refunded",
  "Validate",
];

function TableHeader() {
  return (
    <thead className="bg-gray-50">
      <tr>
        {COLUMNS.map((header) => (
          <th
            key={header}
            className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
          >
            {header}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function OrderGroup({ group, status }: { group: Group; status: TrackingStatus }) {
  const { order, products } = group;

  // Exchanges settle as ONE parcel: validateReturn gathers every pending
  // CAMBIO line on the order, creates a single Shopify order with all the
  // replacements, and closes each return. So a per-garment Refund button was
  // misleading in both directions — it looked like you had to press each one,
  // and like pressing one might ship only that garment. The second press was
  // in fact a silent no-op.
  //
  // Returns are different: each is refunded individually for its own amount,
  // so those keep their per-garment button.
  const pendingExchanges = pendingExchangeLines(products, ACTIONS.CHANGE);
  const batched = pendingExchanges.length > 1;

  return (
    <>
      {/* Order header — the details that belong to the PARCEL, stated once. */}
      <tr className="bg-gray-100/70 border-t-2 border-gray-300">
        <td colSpan={COLUMNS.length} className="px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-semibold text-gray-900">
              {order.orderNumber}
            </span>
            <span className="text-sm text-gray-700">{order.shippingName}</span>
            <span className="text-sm text-gray-500">{order.email}</span>
            <span className={`text-sm ${PHASE_STYLES[status.phase]}`}>
              {status.label}
            </span>
            {products.length > 1 && (
              <span className="text-xs text-gray-500">
                {products.length} garments · one parcel
              </span>
            )}
            {batched && (
              <button
                className="ml-auto bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded-md text-sm transition-colors"
                onClick={() =>
                  validateReturn(pendingExchanges[0], status.label, order)
                }
                aria-label={`Process the exchange for ${order.orderNumber} — ${pendingExchanges.length} garments in one order`}
              >
                Process exchange · {pendingExchanges.length} garments
              </button>
            )}
          </div>
        </td>
      </tr>
      {products.map((product) => (
        <ProductRow
          key={product.id}
          order={order}
          product={product}
          status={status}
          // Suppressed only for the lines the header button already covers.
          settledTogether={batched && pendingExchanges.includes(product)}
        />
      ))}
    </>
  );
}

function ProductRow({
  order,
  product,
  status,
  settledTogether = false,
}: {
  order: DashboardOrder;
  product: DashboardProduct;
  status: TrackingStatus;
  /** This garment is covered by the group's single "Process exchange" button. */
  settledTogether?: boolean;
}) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
        {product.title}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.variant_title}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.quantity}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.price} €
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.action || "No action"}
      </td>
      {/* These columns compared against an unaccented "DEVOLUCION" while the
          column stores the accented ACTIONS.RETURN ("DEVOLUCIÓN"), so the
          branch never matched and every return fell through to "-".
          That made "-" ambiguous: it meant BOTH "a return, so no new product is
          expected" and "an exchange whose new_product_info failed to load" —
          a real data problem, indistinguishable from normal. Comparing against
          the constant separates the two. */}
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.action === ACTIONS.CHANGE && product.new_product_info
          ? product.new_product_info.title
          : product.action === ACTIONS.RETURN
          ? "Return"
          : "-"}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.action === ACTIONS.CHANGE && product.new_product_info
          ? product.new_product_info.variant_title
          : product.action === ACTIONS.RETURN
          ? "Return"
          : "-"}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.refunded ? "Yes" : "No"}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {product.refunded ? (
          <span className="text-green-600">Refunded</span>
        ) : settledTogether ? (
          // No button: pressing it would settle the whole exchange anyway, so
          // one control for one action.
          <span className="text-xs text-gray-500 italic">
            with the exchange above
          </span>
        ) : (
          <button
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm transition-colors"
            onClick={() => validateReturn(product, status.label, order)}
            aria-label={`Refund ${product.title}`}
          >
            Refund
          </button>
        )}
      </td>
    </tr>
  );
}

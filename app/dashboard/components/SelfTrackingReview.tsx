"use client";

import { useState, useTransition } from "react";
import { confirmSelfTracking, rejectSelfTracking } from "@/actions/selfTrackingReview";

export type TrackingToConfirm = {
  id: string;
  orderNumber: string;
  email: string | null;
  carrier: string | null;
  locator: string | null;
  carrierUrl: string | null;
  /** The submission this row shows; review acts on it and nothing else. */
  trackingSubmissionId: string | null;
};

/**
 * Self-booked tracking we could not check with the carrier. Saved, but not
 * sent to the warehouse (Amphora pins it write-once) until an admin opens the
 * link and confirms it. Rendered only when there is something to confirm.
 */
export default function SelfTrackingReview({ rows }: { rows: TrackingToConfirm[] }) {
  return (
    <section
      aria-labelledby="tracking-to-confirm"
      className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 shadow-sm"
    >
      <h2 id="tracking-to-confirm" className="text-base font-semibold text-amber-900">
        Tracking to confirm ({rows.length})
      </h2>
      <p className="mt-1 text-sm text-amber-900">
        We couldn&apos;t check these numbers with the carrier, so the warehouse hasn&apos;t been
        told yet. Open the link: confirm if the parcel is real; reject and we&apos;ll email the
        customer for the right number.
      </p>
      <ul className="mt-3 divide-y divide-amber-200">
        {rows.map((row) => (
          // Keyed by the SUBMISSION, not the order: a new number on the same
          // order is a new review, and must not inherit the last one's state.
          <ReviewRow key={row.trackingSubmissionId ?? row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function ReviewRow({ row }: { row: TrackingToConfirm }) {
  const [isPending, startTransition] = useTransition();
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const act = (action: typeof confirmSelfTracking, done: string) =>
    startTransition(async () => {
      const outcome = await action(row.id, row.trackingSubmissionId ?? "");
      setMessage(
        outcome.ok
          ? outcome.pinned === false
            ? "Confirmed, but the warehouse refused it. Ops has been alerted."
            : done
          : outcome.reason === "not-pending"
            ? "Already handled. Refresh the page."
            : "Not allowed."
      );
    });

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="font-medium text-gray-900">
          {row.orderNumber} · {row.carrier}
        </p>
        <p className="break-all font-mono text-gray-800">{row.locator}</p>
        {row.carrierUrl ? (
          <a
            href={row.carrierUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-indigo-700 underline"
          >
            Open tracking link
          </a>
        ) : null}
        <p className="text-gray-600">{row.email}</p>
      </div>
      {message ? (
        <p role="status" className="text-sm font-medium text-gray-900">
          {message}
        </p>
      ) : (
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={isPending}
            onClick={() => act(confirmSelfTracking, "Confirmed and sent to the warehouse.")}
            className="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Confirm
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              // Two steps: a reject clears the number and emails the customer.
              if (!confirmingReject) return setConfirmingReject(true);
              act(rejectSelfTracking, "Rejected. The customer has been asked for the right number.");
            }}
            className="rounded-md border border-red-600 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
          >
            {confirmingReject ? "Reject and email customer" : "Reject"}
          </button>
        </div>
      )}
    </li>
  );
}

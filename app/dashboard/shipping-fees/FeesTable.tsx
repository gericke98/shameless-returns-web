"use client";

import { saveShippingFee } from "@/actions/shippingFees";
import { useState } from "react";

type Row = {
  countryCode: string;
  maxGrams: number;
  label: string;
  /** Human-readable weight band, e.g. "≤ 1 kg". */
  bandLabel: string;
  returnFeeCents: number;
  exchangeFeeCents: number;
  hasRow: boolean;
};

const toEuros = (cents: number) => (cents / 100).toFixed(2);

// A country now has several rows, one per weight band, so the country code
// alone no longer identifies a row. Saving Germany's 1kg band must not
// disable its 5kg band.
const rowKey = (row: Pick<Row, "countryCode" | "maxGrams">) =>
  `${row.countryCode}:${row.maxGrams}`;

// Each row is its own <form>, so in-flight tracking is per-row rather than a
// single global flag — saving Germany's row must not disable France's.
//
// Deliberately NOT `useTransition` with an async callback: that pattern only
// became reliable in React 19's Actions. This app runs React 18.3.1, where
// `isPending` from `useTransition` is not guaranteed to track state updates
// that happen after an `await` inside the transition callback — exactly the
// window this UI needs to disable the row and show a status message. Plain
// `useState`, set before the await and cleared in a `finally`, has none of
// that ambiguity.
export const FeesTable = ({ rows }: { rows: Row[] }) => {
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Record<string, string>>({});

  const onSave =
    (key: string) => async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      // Gate the submit handler itself, not just the button's `disabled`
      // attribute: pressing Enter inside a text input fires `onSubmit`
      // directly and does not consult the button's disabled state.
      if (saving[key]) return;

      const formData = new FormData(e.currentTarget);
      setSaving((prev) => ({ ...prev, [key]: true }));
      try {
        const result = await saveShippingFee(formData);
        setStatus((prev) => ({
          ...prev,
          [key]: result.ok ? "Saved" : result.error ?? "Failed",
        }));
      } finally {
        setSaving((prev) => ({ ...prev, [key]: false }));
      }
    };

  return (
    <table className="mt-6 w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2">Country</th>
          <th className="py-2">Weight</th>
          <th className="py-2">Return fee (€)</th>
          <th className="py-2">Exchange fee (€)</th>
          <th className="py-2" />
          <th className="py-2" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          const isSaving = Boolean(saving[key]);
          return (
            <tr key={key} className="border-b">
              <td className="py-2">
                {row.label}
                {!row.hasRow && (
                  <span className="ml-2 text-xs text-gray-500">inherited</span>
                )}
              </td>
              <td className="py-2 whitespace-nowrap text-gray-600">
                {row.bandLabel}
              </td>
              <td colSpan={4}>
                <form
                  onSubmit={onSave(key)}
                  className="flex items-center gap-3 py-1"
                >
                  <input type="hidden" name="countryCode" value={row.countryCode} />
                  <input type="hidden" name="maxGrams" value={row.maxGrams} />
                  <input
                    name="returnFee"
                    defaultValue={toEuros(row.returnFeeCents)}
                    inputMode="decimal"
                    disabled={isSaving}
                    className="w-24 rounded border px-2 py-1"
                  />
                  <input
                    name="exchangeFee"
                    defaultValue={toEuros(row.exchangeFeeCents)}
                    inputMode="decimal"
                    disabled={isSaving}
                    className="w-24 rounded border px-2 py-1"
                  />
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="rounded bg-cyan-800 px-3 py-1 text-white disabled:opacity-50"
                  >
                    {isSaving ? "Saving…" : "Save"}
                  </button>
                  <span className="text-xs text-gray-600">{status[key]}</span>
                </form>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

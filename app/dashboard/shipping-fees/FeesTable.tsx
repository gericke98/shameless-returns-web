"use client";

import { saveShippingFee } from "@/actions/shippingFees";
import { useState, useTransition } from "react";

type Row = {
  countryCode: string;
  label: string;
  returnFeeCents: number;
  exchangeFeeCents: number;
  hasRow: boolean;
};

const toEuros = (cents: number) => (cents / 100).toFixed(2);

export const FeesTable = ({ rows }: { rows: Row[] }) => {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<Record<string, string>>({});

  const onSave = (countryCode: string) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveShippingFee(formData);
      setStatus((prev) => ({
        ...prev,
        [countryCode]: result.ok ? "Saved" : result.error ?? "Failed",
      }));
    });
  };

  return (
    <table className="mt-6 w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2">Country</th>
          <th className="py-2">Return fee (€)</th>
          <th className="py-2">Exchange fee (€)</th>
          <th className="py-2" />
          <th className="py-2" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.countryCode} className="border-b">
            <td className="py-2">
              {row.label}
              {!row.hasRow && (
                <span className="ml-2 text-xs text-gray-500">inherited</span>
              )}
            </td>
            <td colSpan={4}>
              <form onSubmit={onSave(row.countryCode)} className="flex items-center gap-3 py-1">
                <input type="hidden" name="countryCode" value={row.countryCode} />
                <input
                  name="returnFee"
                  defaultValue={toEuros(row.returnFeeCents)}
                  inputMode="decimal"
                  className="w-24 rounded border px-2 py-1"
                />
                <input
                  name="exchangeFee"
                  defaultValue={toEuros(row.exchangeFeeCents)}
                  inputMode="decimal"
                  className="w-24 rounded border px-2 py-1"
                />
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded bg-cyan-800 px-3 py-1 text-white disabled:opacity-50"
                >
                  Save
                </button>
                <span className="text-xs text-gray-600">{status[row.countryCode]}</span>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

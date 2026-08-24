"use client";

import { useState, useTransition } from "react";
import { submitReturnTracking } from "@/actions/selfBookedTracking";
import { CARRIERS } from "@/lib/carriers";
import { useT } from "@/lib/i18n/context";

/**
 * Shown when a self-booked return is still waiting for its tracking number.
 *
 * The confirm step is not decoration: Amphora pins `carrier_number` at approve
 * and it can never be corrected, so a typo desyncs the warehouse permanently.
 */
export function TrackingCapture({ id }: { id: string }) {
  const t = useT();
  const [carrier, setCarrier] = useState(CARRIERS[0].code);
  const [number, setNumber] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<"idle" | "done" | "error">("idle");
  const [isPending, startTransition] = useTransition();

  if (result === "done") {
    return <p className="text-sm font-bold">{t.tracking.done}</p>;
  }

  return (
    <div className="w-full flex flex-col gap-3 mt-4">
      <h3 className="font-bold text-base">{t.tracking.title}</h3>
      <p className="text-sm text-slate-600">{t.tracking.intro}</p>

      <label className="flex flex-col gap-1 text-sm">
        {t.tracking.carrier}
        <select
          className="border rounded-lg p-2"
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
        >
          {CARRIERS.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        {t.tracking.number}
        <input
          className="border rounded-lg p-2"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
      </label>

      <p className="text-xs text-slate-600">{t.tracking.permanent}</p>
      {result === "error" && (
        <p className="text-xs text-red-600">{t.tracking.error}</p>
      )}

      <button
        type="button"
        className="bg-white text-black border border-black py-3 rounded-full font-bold disabled:opacity-60"
        disabled={isPending || !number.trim()}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          startTransition(async () => {
            const outcome = await submitReturnTracking(id, carrier, number.trim());
            setResult(outcome.ok ? "done" : "error");
            setConfirming(false);
          });
        }}
      >
        {confirming ? `${t.tracking.submit} — ${number.trim()}` : t.tracking.submit}
      </button>
    </div>
  );
}

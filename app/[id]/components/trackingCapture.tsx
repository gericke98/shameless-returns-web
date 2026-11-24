"use client";

import { useState, useTransition } from "react";
import { submitReturnTracking } from "@/actions/selfBookedTracking";
import {
  CARRIERS,
  carrierByCode,
  checkTrackingNumber,
  type TrackingNumberProblem,
} from "@/lib/carriers";
import { checkTrackingUrl } from "@/lib/trackingUrl";
import { useT } from "@/lib/i18n/context";

/**
 * Shown when a self-booked return is still waiting for its tracking number.
 *
 * The confirm step is not decoration: Amphora pins `carrier_number` and
 * `carrier_url` at approve and they can never be corrected, so a typo desyncs
 * the warehouse permanently.
 *
 * For a carrier whose tracking link we cannot build ("Other"), the link is
 * required (Santi, 2026-11-24): Amphora's approve needs one, and sending `""`
 * is what failed #312783 and #312737. The same check runs on the server.
 *
 * The number is checked here too, with the server's own rules: it cannot be
 * the customer's order number (#311595 and #313127 sent theirs, and Amphora
 * pinned it), and it must be one this carrier can link (NACEX needs agency/note).
 */
export function TrackingCapture({ id, orderNumber }: { id: string; orderNumber: string }) {
  const t = useT();
  const [carrier, setCarrier] = useState(CARRIERS[0].code);
  const [number, setNumber] = useState("");
  const [link, setLink] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<"idle" | "done" | "error" | "invalid-url">("idle");
  // A refusal of the number from the server, shown until the number changes.
  const [refusedNumber, setRefusedNumber] = useState<TrackingNumberProblem | null>(null);
  const [isPending, startTransition] = useTransition();

  // Derived during render: whether this carrier needs the customer's link,
  // and whether what they typed is one.
  const option = carrierByCode(carrier);
  const needsLink = option?.link.kind === "customer";
  const trimmed = number.trim();
  // The server's own check (lib/carriers), run as the customer types.
  const numberCheck = option ? checkTrackingNumber(option, number, { orderNumber, id }) : null;
  const numberProblem = numberCheck && !numberCheck.ok ? numberCheck.reason : null;
  // "Empty" is not an error to show while nothing is typed yet.
  const shownNumberProblem =
    (numberProblem === "empty-tracking" ? null : numberProblem) ?? refusedNumber;
  const linkCheck = needsLink ? checkTrackingUrl(link) : null;
  const linkTyped = link.trim() !== "";
  const linkBad = linkCheck !== null && !linkCheck.ok && linkTyped;
  const ready = numberProblem === null && (linkCheck === null || linkCheck.ok);

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
          onChange={(e) => {
            setCarrier(e.target.value);
            setConfirming(false);
            setRefusedNumber(null);
          }}
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
          placeholder={option?.example}
          aria-invalid={shownNumberProblem !== null}
          onChange={(e) => {
            setNumber(e.target.value);
            setConfirming(false);
            setRefusedNumber(null);
          }}
        />
      </label>
      {shownNumberProblem === "order-number" ? (
        <p role="alert" className="text-xs text-red-600">
          {t.tracking.orderNumber}
        </p>
      ) : shownNumberProblem === "wrong-format" ? (
        <p role="alert" className="text-xs text-red-600">
          {option?.example ? `${t.tracking.wrongFormat} ${option.example}` : t.tracking.error}
        </p>
      ) : shownNumberProblem === "too-long" ? (
        <p role="alert" className="text-xs text-red-600">
          {t.tracking.tooLong}
        </p>
      ) : null}

      {needsLink ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-sm">
            {t.tracking.link}
            <input
              className="border rounded-lg p-2"
              type="url"
              inputMode="url"
              autoComplete="off"
              required
              aria-invalid={linkBad}
              aria-describedby="tracking-link-help"
              placeholder="https://"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setConfirming(false);
                if (result === "invalid-url") setResult("idle");
              }}
            />
          </label>
          <p id="tracking-link-help" className="text-xs text-slate-600">
            {t.tracking.linkHelp}
          </p>
          {(linkBad || result === "invalid-url") && (
            <p role="alert" className="text-xs text-red-600">
              {t.tracking.linkInvalid}
            </p>
          )}
          <p className="text-xs text-slate-600">{t.tracking.noLink}</p>
        </div>
      ) : null}

      <p className="text-xs text-slate-600">{t.tracking.permanent}</p>
      {result === "error" && (
        <p className="text-xs text-red-600">{t.tracking.error}</p>
      )}

      {confirming && needsLink && linkCheck?.ok ? (
        // What will be pinned, shown back before the click that pins it.
        <p className="text-xs break-all">{linkCheck.url}</p>
      ) : null}

      <button
        type="button"
        className="bg-white text-black border border-black py-3 rounded-full font-bold disabled:opacity-60"
        disabled={isPending || !ready}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          startTransition(async () => {
            const outcome = needsLink
              ? await submitReturnTracking(id, carrier, trimmed, link.trim())
              : await submitReturnTracking(id, carrier, trimmed);
            if (outcome.ok) setResult("done");
            else if (outcome.reason === "missing-url" || outcome.reason === "invalid-url") {
              setResult("invalid-url");
            } else if (
              outcome.reason === "order-number" ||
              outcome.reason === "wrong-format" ||
              outcome.reason === "too-long"
            ) {
              setRefusedNumber(outcome.reason);
            } else setResult("error");
            setConfirming(false);
          });
        }}
      >
        {confirming ? `${t.tracking.submit} — ${trimmed}` : t.tracking.submit}
      </button>
    </div>
  );
}

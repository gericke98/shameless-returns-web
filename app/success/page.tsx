import Image from "next/image";
import SuccessIcon from "@/public/check_circle.svg";
import Logo from "@/public/LOGO_2025.svg";
import Link from "next/link";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, dictionaries, readLocale } from "@/lib/i18n";
import { currentOrderId } from "@/lib/orderAccess";
import { getOrderById } from "@/db/queries";
import { returnOutcome } from "@/lib/returnOutcome";

// Reaching this page proves nothing: `returnFunction` ends in an unconditional
// redirect("/success") whether the return succeeded, failed, or threw. Order
// #310185 was reverted and still landed here, and the customer wrote in asking
// what she had done wrong.
//
// So the page verifies rather than assumes. Verifying — instead of being handed
// a ?state= flag — is also what makes it work for the PAID path: the customer
// returns from Stripe Checkout by a top-level navigation that carries nothing,
// which is exactly why the session cookie is sameSite "lax".
export const dynamic = "force-dynamic";

export default async function SuccessPage() {
  const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
  const t = dictionaries[locale];

  const orderId = await currentOrderId();
  const order = orderId ? await getOrderById(orderId) : null;
  const outcome = returnOutcome(order);

  // `unknown` is not a failure. The session lasts two hours and a slow checkout
  // can outlive it, so an order we cannot read means we cannot tell — and a
  // customer whose return is fine must not be told it broke.
  const failed = outcome.state === "missing";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-brand-paper p-4">
      <div className="bg-white-pattern flex flex-col w-full max-w-md rounded-3xl items-center py-5 px-5 sm:px-10">
        <Link href="https://shamelesscollective.com">
          {/* 96px — half the 192px the old PNG rendered at. See header.tsx for
              why the width is pinned in CSS and why the SVG is unoptimized. */}
          <Image
            src={Logo}
            alt="Logo"
            width={96}
            height={34}
            className="w-24 h-auto"
            unoptimized
          />
        </Link>
        <span className="border w-full border-slate-100 mt-5" />
        <div className="flex flex-col items-center px-2">
          {!failed && (
            <Image
              src={SuccessIcon}
              alt="Icon 1"
              width={100}
              height={100}
              className="mt-5"
            />
          )}
          <h1 className="text-base sm:text-lg font-semibold mt-5 mb-2 text-center px-5">
            {failed ? t.error.title : t.success.title}
          </h1>
          <h5 className="text-sm sm:text-base text-center">
            {failed ? t.error.body : t.success.body}
          </h5>

          {failed && orderId && (
            <Link
              href={`/${orderId}`}
              className="mt-5 mb-2 bg-white text-black border border-black py-3 px-8 rounded-full hover:bg-gray-100 transition-colors font-bold text-sm"
            >
              {t.error.retry}
            </Link>
          )}

          {outcome.tracking && (
            <div className="mt-5 mb-2 w-full text-center text-sm">
              {outcome.tracking.carrier && (
                <p>
                  {t.success.carrierLabel}: {outcome.tracking.carrier}
                </p>
              )}
              <p className="font-semibold break-all">
                {t.success.trackingLabel}: {outcome.tracking.locator}
              </p>
              {outcome.tracking.carrierUrl && (
                <a
                  href={outcome.tracking.carrierUrl}
                  className="underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {outcome.tracking.carrierUrl}
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

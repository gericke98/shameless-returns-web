import { InputComponent } from "@/components/inputComponent";
import { Metadata } from "next";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, readLocale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/context";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { dictionaries } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Shameless Returns | Order Search",
  description: "Search and manage your Shameless Returns order",
};

function LoadingState() {
  return (
    <div className="animate-pulse">
      <div className="h-[150px] w-[150px] bg-gray-200 rounded-lg mb-5" />
      <div className="h-4 w-3/4 bg-gray-200 rounded mb-10" />
      <div className="h-4 w-full bg-gray-200 rounded mb-8" />
      <div className="space-y-4">
        <div className="h-12 bg-gray-200 rounded" />
        <div className="h-12 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

/**
 * Home page component
 * Displays the order search form in a centered layout
 */
type HomeProps = { searchParams?: { session?: string } };

const Home = ({ searchParams }: HomeProps) => {
  const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
  // Set when /[id] turned someone away — no session, expired, or a session for
  // a different order. One message for all three: it must not reveal whether
  // the id they tried names a real order.
  const sessionExpired = searchParams?.session === "expired";

  return (
    <main className="min-h-screen grid place-items-center bg-brand-paper">
      <LocaleProvider locale={locale}>
        <div className="bg-white rounded-3xl py-5 px-4 lg:px-6 w-[85%] lg:w-[30%] flex flex-col items-center">
          <div className="w-full flex justify-end">
            <LanguageSwitcher />
          </div>
          {sessionExpired && (
            <p
              role="status"
              className="w-full text-sm text-center text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2"
            >
              {dictionaries[locale].lookup.sessionExpired}
            </p>
          )}
          <Suspense fallback={<LoadingState />}>
            <InputComponent />
          </Suspense>
        </div>
      </LocaleProvider>
    </main>
  );
};

export default Home;

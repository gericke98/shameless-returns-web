import Image from "next/image";
import SuccessIcon from "@/public/check_circle.svg";
import Logo from "@/public/LOGO_2025.svg";
import Link from "next/link";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, dictionaries, readLocale } from "@/lib/i18n";

export default function SuccessPage() {
  const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
  const t = dictionaries[locale];

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-brand-paper p-4">
      {/* 
        Use w-full, plus max-w-md to cap width on larger screens.
        Add rounded corners on bigger screens (sm:rounded-3xl) or keep them for mobile if desired.
      */}
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
          <Image
            src={SuccessIcon}
            alt="Icon 1"
            width={100}
            height={100}
            className="mt-5"
          />
          <h1 className="text-base sm:text-lg font-semibold mt-5 mb-2 text-center px-5">
            {t.success.title}
          </h1>
          <h5 className="text-sm sm:text-base text-center">
            {t.success.body}
          </h5>
        </div>
      </div>
    </div>
  );
}

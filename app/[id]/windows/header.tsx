"use client";
import Image from "next/image";
import Logo from "@/public/LOGO_2025.svg";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useT } from "@/lib/i18n/context";

export const Header = () => {
  const t = useT();

  return (
    <div className="bg-white flex flex-col lg:w-[30%] w-[85%] rounded-b-3xl items-center py-3 px-4 lg:px-6">
      <div className="w-full flex justify-end">
        <LanguageSwitcher />
      </div>
      {/* 96px — half the 192px the old PNG actually rendered at (the previous
          width={150} was inert, because w-auto let the intrinsic size win).
          The width is pinned in CSS on purpose: an SVG whose root carries only
          a viewBox has no intrinsic size, so `w-auto` stretches it to the full
          container. `unoptimized` because the optimizer refuses SVG without
          dangerouslyAllowSVG, and vector art gains nothing from it. */}
      <Image
        src={Logo}
        alt="Logo"
        width={96}
        height={34}
        className="w-24 h-auto"
        unoptimized
      />
      <span className="border w-full border-slate-200 mt-5" />
      <h3 className="text-xs mt-2 text-slate-500">{t.common.header}</h3>
    </div>
  );
};

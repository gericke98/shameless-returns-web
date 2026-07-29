"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";
import { useFormState } from "react-dom";

import Logo from "@/public/LOGO_2025.svg";
import { FormInput } from "@/components/formInput";
import { Button } from "@/components/button";
import { useToast } from "@/hooks/use-toast";
import { getOrder } from "@/actions/order";
import { Warning } from "@/types";
import { PRIVACY_LINKS } from "@/placeholder";
import { useT } from "@/lib/i18n/context";

/**
 * Main input component for the order search form
 */
export const InputComponent = () => {
  const { toast } = useToast();
  const t = useT();

  // Initialize with an empty warning as the initial state
  const initialState: Warning = { message: "" };
  const [state, formAction] = useFormState(getOrder, initialState);

  // Handle server action response
  useEffect(() => {
    // Only show toast notification when there's an error
    if (state && state.message) {
      toast({
        variant: "destructive",
        title: t.lookup.errorTitle,
        description: state.message,
      });
    }
  }, [toast, state, t]);

  /**
   * Renders the privacy policy links
   */
  const renderPrivacyLinks = () => (
    <div role="contentinfo" aria-label="Privacy policy links">
      <h6 className="text-xxs text-black mt-5">
        {t.lookup.consent}{" "}
        {PRIVACY_LINKS.map((link, index) => (
          <span key={link.text}>
            <Link
              href={link.href}
              className="text-blue-400 border-b border-blue-400 font-bold hover:text-blue-600 transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.text}
            </Link>
            {index < PRIVACY_LINKS.length - 1 && ", "}
          </span>
        ))}
      </h6>
    </div>
  );

  return (
    <div className="flex flex-col items-center">
      {/* 96px — half the 192px the old PNG rendered at. See header.tsx for why
          the width is pinned in CSS and why the SVG is unoptimized. */}
      <Image
        src={Logo}
        alt="Shameless Returns Logo"
        width={96}
        height={34}
        className="w-24 h-auto"
        priority
        unoptimized
      />
      <span
        className="border w-full border-slate-100 mt-5"
        aria-hidden="true"
      />
      <h3 className="text-xs mt-2 mb-10 text-slate-500">{t.common.header}</h3>
      <h5 className="lg:text-sm text-xs text-slate-600">
        {t.lookup.intro}{" "}
        <span>
          <Link
            href="https://shamelesscollective.com/pages/return-and-exchanges"
            className="text-blue-400 border-b border-blue-400 font-bold hover:text-blue-600 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t.lookup.policyLink}
          </Link>
        </span>
      </h5>
      <form
        className="mt-10 w-full flex flex-col gap-4"
        action={formAction}
        aria-label="Order search form"
        noValidate
      >
        <FormInput
          name="order"
          title={t.lookup.orderNumber}
          icon
          valueini=""
          required
          aria-required="true"
          pattern="[A-Za-z0-9-]+"
          placeholder={t.lookup.orderPlaceholder}
          minLength={3}
          maxLength={50}
        />
        <FormInput
          name="email"
          title={t.lookup.email}
          icon
          valueini=""
          required
          aria-required="true"
          type="email"
          placeholder={t.lookup.emailPlaceholder}
          pattern="[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$"
        />
        {renderPrivacyLinks()}
        <Button
          text={t.lookup.submit}
          type="submit"
          aria-label="Search order"
        />
      </form>
    </div>
  );
};

"use client";
import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";
import { useFormState } from "react-dom";

import Logo from "@/public/LOGO_black.png";
import { FormInput } from "@/components/formInput";
import { Button } from "@/components/button";
import { useToast } from "@/hooks/use-toast";
import { getOrder } from "@/actions/order";
import { Warning } from "@/types";
import { PRIVACY_LINKS } from "@/placeholder";

/**
 * Main input component for the order search form
 */
export const InputComponent = () => {
  const { toast } = useToast();

  // Initialize with an empty warning as the initial state
  const initialState: Warning = { message: "" };
  const [state, formAction] = useFormState(getOrder, initialState);

  // Handle server action response
  useEffect(() => {
    // Only show toast notification when there's an error
    if (state && state.message) {
      toast({
        variant: "destructive",
        title: "There was an error in your request",
        description: state.message,
      });
    }
  }, [toast, state]);

  /**
   * Renders the privacy policy links
   */
  const renderPrivacyLinks = () => (
    <div role="contentinfo" aria-label="Privacy policy links">
      <h6 className="text-xxs text-black mt-5">
        Al continuar, confirmas que aceptas los{" "}
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
      <Image
        src={Logo}
        alt="Shameless Returns Logo"
        width={150}
        height={150}
        className="h-auto w-auto"
        priority
      />
      <span
        className="border w-full border-slate-100 mt-5"
        aria-hidden="true"
      />
      <h3 className="text-xs mt-2 mb-10 text-slate-500">
        CAMBIOS Y DEVOLUCIONES
      </h3>
      <h5 className="lg:text-sm text-xs text-slate-600">
        Introduce los datos de tu pedido original para iniciar el proceso.{" "}
        <span>
          <Link
            href="https://shamelesscollective.com/pages/return-and-exchanges"
            className="text-blue-400 border-b border-blue-400 font-bold hover:text-blue-600 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            Ver política de devoluciones
          </Link>
        </span>
      </h5>
      <form
        className="mt-10 w-full flex flex-col gap-8"
        action={formAction}
        aria-label="Order search form"
        noValidate
      >
        <FormInput
          name="order"
          title="Número de pedido"
          icon
          valueini=""
          required
          aria-required="true"
          pattern="[A-Za-z0-9-]+"
          placeholder="Enter your order number"
          minLength={3}
          maxLength={50}
        />
        <FormInput
          name="email"
          title="Email"
          icon
          valueini=""
          required
          aria-required="true"
          type="email"
          placeholder="Enter your email"
          pattern="[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$"
        />
        {renderPrivacyLinks()}
        <Button text="Buscar pedido" type="submit" aria-label="Search order" />
      </form>
    </div>
  );
};

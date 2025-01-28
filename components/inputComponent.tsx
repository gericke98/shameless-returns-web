"use client";
import Image from "next/image";
import Link from "next/link";

import Logo from "@/public/LOGO_black.png";

import { FormInput } from "@/components/formInput";
import { Button } from "@/components/button";
import { useToast } from "@/hooks/use-toast";

import { getOrder } from "@/actions/order";
import { useFormState } from "react-dom";
import { useEffect, useState } from "react";
import { Warning } from "@/types";

export const InputComponent = () => {
  const [warning, setWarning] = useState<Warning>({
    message: "",
  });
  const { toast } = useToast();
  const initialState = warning;
  const [state, formAction] = useFormState(getOrder, initialState);
  useEffect(() => {
    if (!state?.message) return;
    if (state.message) {
      toast({
        variant: "destructive",
        title: "There was an error in your request",
        description: state.message,
      });
    }
  }, [toast, state]);
  return (
    <div className="flex flex-col items-center">
      <Image src={Logo} alt="Logo" width={150} height={150} />
      <span className="border w-full border-slate-100 mt-5" />
      <h3 className="text-xs mt-2 mb-10 text-slate-500">
        CAMBIOS Y DEVOLUCIONES
      </h3>
      <h5 className="text-sm text-slate-600">
        Introduce los datos de tu pedido original para iniciar el proceso.{" "}
        <span>
          <Link
            href="https://shamelesscollective.com/pages/return-and-exchanges"
            className="text-blue-400 border-b border-blue-400 font-bold"
          >
            Ver política de devoluciones
          </Link>
        </span>
      </h5>
      <form className="mt-10 w-full flex flex-col gap-8" action={formAction}>
        <FormInput name="order" title="Número de pedido" icon valueini="" />
        <FormInput name="email" title="Email" icon valueini="" />
        <h6 className="text-xxs text-black mt-5">
          Al continuar, confirmas que aceptas los{" "}
          <span>
            <Link
              href="https://shamelesscollective.com/pages/return-and-exchanges"
              className="text-blue-400 border-b border-blue-400 font-bold"
            >
              Términos y Condiciones
            </Link>
          </span>
          ,{" "}
          <span>
            <Link
              href="https://shamelesscollective.com/pages/return-and-exchanges"
              className="text-blue-400 border-b border-blue-400 font-bold"
            >
              Política de privacidad y
            </Link>
          </span>{" "}
          <span>
            <Link
              href="https://shamelesscollective.com/pages/return-and-exchanges"
              className="text-blue-400 border-b border-blue-400 font-bold"
            >
              la Política de cookies
            </Link>
          </span>
        </h6>
        <Button text="Buscar pedido" />
      </form>
    </div>
  );
};

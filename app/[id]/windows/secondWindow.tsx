"use client";

import { memo, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import Image from "next/image";
import { IoLocationSharp } from "react-icons/io5";
import Link from "next/link";
import { SecondWindowForm } from "../components/secondWindowForm";
import { orders, productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import CorreosLogo from "@/public/correos.webp";

type Props = {
  order: typeof orders.$inferSelect;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  id: string;
};

const SecondWindowBase = ({
  order,
  position,
  setPosition,
  items,
  onItemChange,
  id,
}: Props) => {
  // Calculate totals
  const { totalPriceDevolver, totalPriceCambio } = useMemo(() => {
    const totalPriceDevolver = items
      .filter((item) => item.action && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    const totalPriceCambio = items
      .filter((item) => item.action === "CAMBIO" && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    return { totalPriceDevolver, totalPriceCambio };
  }, [items]);

  const totalPrice = totalPriceDevolver - totalPriceCambio;
  const shippingCost = process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST;

  return (
    <div className="w-full h-full flex flex-col p-2 sm:p-4">
      {/* Progress Bar */}
      <Progress value={50} className="mb-2" />

      {/* Back Arrow */}
      <FaArrowAltCircleLeft
        size={25}
        className="mt-2 cursor-pointer"
        onClick={() => setPosition(position - 1)}
      />

      {/* Title */}
      <h3 className="font-bold text-xl sm:text-2xl text-left mt-2">
        Método de devolución
      </h3>

      {/* Subtitle */}
      <p className="mt-3 text-sm sm:text-base text-gray-700">
        Escoge el método de envío que quieres usar para devolver los productos
        seleccionados
      </p>

      <span className="border border-gray-300 w-full mt-3" />

      {/*
        On mobile, stack vertically.
        On larger screens, keep the "icon" and "info" side by side.
      */}
      <div className="w-full flex flex-col sm:flex-row rounded-lg my-5 border-2 border-black hover:cursor-pointer">
        {/* Black Icon Container */}
        <div className="bg-black flex flex-row sm:flex-col items-center justify-center p-2 sm:p-3">
          <IoLocationSharp size={30} color="white" />
        </div>

        {/* Info Container */}
        <div className="w-full flex flex-col p-2 sm:p-3">
          <div className="flex flex-row items-center gap-2">
            <Image
              src={CorreosLogo}
              alt="Logo correos"
              width={35}
              height={40}
              // Show the image on all screens, or hide on small if you want
              // className="hidden lg:block"
            />
            <h5 className="text-xs sm:text-sm font-semibold">
              Entrega en punto de recogida Correos
            </h5>
          </div>
          <div className="mt-1">
            <h5 className="text-xxs sm:text-xs">
              Coste: {totalPrice !== 0 ? `${shippingCost},00 €` : "0,00 €"}
            </h5>
          </div>
        </div>
      </div>

      <span className="border border-gray-300 w-full mt-2" />

      {/* Secondary Info Section */}
      <div className="w-full flex flex-col mt-2">
        {/* Title row */}
        <div className="flex flex-row items-center gap-2">
          <IoLocationSharp size={30} color="black" />
          <h3 className="font-bold text-base sm:text-lg">
            Entrega en punto de recogida
          </h3>
        </div>

        <p className="mt-2 text-sm sm:text-base font-light">
          Valida tu dirección de envío para poder generar la etiqueta de
          devolución que recibirás en tu email, con la que podrás llevar tu
          paquete a un punto de recogida de Correos.{" "}
          <Link
            href="https://www.correos.es/es/es/herramientas/oficinas-buzones-citypaq/detalle"
            className="text-blue-500 font-semibold"
          >
            Ver listado
          </Link>
        </p>

        {/* Form */}
        <SecondWindowForm
          order={order}
          position={position}
          setPosition={setPosition}
          items={items}
          onItemChange={onItemChange}
        />
      </div>
    </div>
  );
};

export const SecondWindow = memo(SecondWindowBase);

import { Progress } from "@/components/ui/progress";
import Image from "next/image";
import { IoLocationSharp } from "react-icons/io5";
import CorreosLogo from "@/public/correos.webp";
import Link from "next/link";
import { SecondWindowForm } from "./secondWindowForm";
import { orders, productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { FaArrowAltCircleLeft } from "react-icons/fa";

type Props = {
  order: typeof orders.$inferSelect;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
};

export const SecondWindow = ({
  order,
  position,
  setPosition,
  items,
}: Props) => {
  return (
    <div className="w-full h-full flex flex-col">
      <Progress value={50} />
      <FaArrowAltCircleLeft
        size={25}
        className="mt-4 cursor-pointer"
        onClick={() => setPosition(position - 1)}
      />
      <h3 className="font-bold text-2xl text-left mt-1">
        Método de devolución
      </h3>
      <p className="mt-5 text-sm text-gray-700">
        Escoge el método de envío que quieres usar para devolver los productos
        seleccionados
      </p>
      <span className="border w-full border-gray-300 mt-2" />
      <div className="w-full flex flex-row rounded-lg h-14 my-5 border-2 border-black hover:cursor-pointer">
        <div className="bg-black h-full flex flex-col items-center justify-center px-3">
          <IoLocationSharp size={30} color="white" />
        </div>
        <div className="w-full h-full flex flex-col">
          <div className="flex flex-row w-full py-2 px-4 gap-2">
            <Image
              src={CorreosLogo}
              alt="Logo correos"
              width={35}
              height={40}
            />
            <h5 className="text-xs font-semibold">
              Entrega en punto de recogida
            </h5>
          </div>
          <div className="flex flex-row w-full px-4">
            <h5 className="text-xxs">Coste: 4,00 €</h5>
          </div>
        </div>
      </div>
      <span className="border w-full border-gray-300 mt-2" />
      <div className="w-full h-full mt-2 flex flex-col">
        <div className="h-full flex flex-row items-center justify-start gap-2">
          <IoLocationSharp size={30} color="black" />
          <h3 className="font-bold text-base">Entrega en punto de recogida</h3>
        </div>
        <p className="mt-2 font-light text-sm">
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
        <SecondWindowForm
          order={order}
          position={position}
          setPosition={setPosition}
          items={items}
        />
      </div>
    </div>
  );
};

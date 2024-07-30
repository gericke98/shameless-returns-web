import { Progress } from "@/components/ui/progress";
import { ProductLine } from "./components/productLine";
import Image from "next/image";
import Logo from "@/public/LOGO_black.png";
import { productsOrder } from "@/db/schema";
import { AsyncButton } from "@/components/asyncButton";

type Props = {
  name: string;
  items: (typeof productsOrder.$inferSelect)[];
  id: string;
};
export const ClientOrder = ({ name, items, id }: Props) => {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black">
      <div className="bg-white flex flex-col w-[30%] rounded-3xl items-center py-5 px-10">
        <Image src={Logo} alt="Logo" width={150} height={150} />
        <span className="border w-full border-slate-100 mt-5" />
        <h3 className="text-xs mt-2 mb-10 text-slate-500">
          CAMBIOS Y DEVOLUCIONES
        </h3>
        <Progress value={33} />
        <div className="flex flex-col w-full items-start mb-5">
          <h3 className="text-2xl font-bold mt-8">Pedido {name}</h3>
          <h5 className="text-xs font-regular text-slate-600 mt-6">
            Selecciona al menos un producto para continuar
          </h5>
          <div className="w-full h-full mt-5 rounded-xl hover:cursor-pointer">
            {items.map(async (product) => (
              <ProductLine key={product.id} orderProduct={product} />
            ))}
          </div>
          <span className="mt-5 border-b border-slate-200 w-full" />
        </div>
        <AsyncButton text="Actualizar pedido" id={id} />
      </div>
    </div>
  );
};

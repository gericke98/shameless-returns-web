import Image from "next/image";
import Logo from "@/public/LOGO_black.png";
export const Header = () => {
  return (
    <div className="bg-white flex flex-col lg:w-[30%] w-[85%] rounded-b-3xl items-center py-3 px-4 lg:px-6">
      <Image
        src={Logo}
        alt="Logo"
        width={150}
        height={150}
        className="w-auto h-auto"
      />
      <span className="border w-full border-slate-200 mt-2" />
      <h3 className="text-xs mt-2 text-slate-500">CAMBIOS Y DEVOLUCIONES</h3>
    </div>
  );
};

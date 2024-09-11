import Image from "next/image";
import SuccessIcon from "@/public/check_circle.svg";
import Logo from "@/public/LOGO_black.png";
import Link from "next/link";

export default async function SuccessPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black-pattern">
      <div className="bg-white-pattern flex flex-col w-[30%] rounded-3xl items-center py-5 px-10">
        <Link href="https://shamelesscollective.com">
          <Image src={Logo} alt="Logo" width={150} height={150} />
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
          <h1 className="text-base font-semibold mt-5 mb-2 text-center px-5">
            Hemos recibido tu solicitud correctamente!
          </h1>
          <h5 className="text-sm text-center">
            Hemos recibido tu solicitud y se te ha enviado un correo electrónico
            con los siguientes pasos
          </h5>
        </div>
      </div>
    </div>
  );
}

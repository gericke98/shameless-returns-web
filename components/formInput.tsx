"use client";
import BoxIcon from "@/public/package_2_24dp_FILL0_wght400_GRAD0_opsz24.svg";
import MailIcon from "@/public/mail_24dp_FILL0_wght400_GRAD0_opsz24.svg";
import Image from "next/image";
import { useState, ChangeEvent } from "react";
import { cn } from "@/lib/utils";
import { FormInputProps } from "@/types";

/**
 * FormInput component for rendering form input fields with optional icons
 */
export const FormInput = ({
  name,
  title,
  icon,
  valueini = "",
}: FormInputProps) => {
  const [value, setValue] = useState<string>(valueini);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  };

  const renderIcon = () => {
    if (!icon) return null;

    const iconSrc = name === "order" ? BoxIcon : MailIcon;

    return (
      <Image
        src={iconSrc}
        alt={`${name} icon`}
        width={15}
        height={15}
        className="w-auto h-auto max-w-4 pt-1"
      />
    );
  };

  return (
    <div className="w-full h-8">
      <div className="w-full h-full">
        <h6 className="bg-slate-100 rounded-t-lg text-xxs pl-4 pt-2 text-slate-400">
          {title}
        </h6>
        <div
          className={cn(
            "w-full h-full pl-4 pt-1 flex bg-slate-100 border-b-2 border-[#868687] focus-within:border-[#383839]",
            icon ? "flex-row" : "flex-col"
          )}
        >
          {renderIcon()}
          <input
            type="text"
            name={name}
            className={cn(
              "h-full w-full bg-slate-100 text-base lg:text-sm text-black font-light focus:outline-none",
              icon && "pl-4"
            )}
            placeholder=""
            value={value}
            onChange={handleChange}
          />
        </div>
      </div>
    </div>
  );
};

"use client";
import BoxIcon from "@/public/package_2_24dp_FILL0_wght400_GRAD0_opsz24.svg";
import MailIcon from "@/public/mail_24dp_FILL0_wght400_GRAD0_opsz24.svg";
import Image from "next/image";
import { useState, ChangeEvent } from "react";
import { cn } from "@/lib/utils";

interface FormInputProps {
  name: string;
  title: string;
  icon?: boolean;
  valueini?: string;
  required?: boolean;
  type?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
}

/**
 * FormInput component for rendering form input fields with optional icons
 */
export const FormInput = ({
  name,
  title,
  icon,
  valueini,
  required,
  type = "text",
  pattern,
  minLength,
  maxLength,
  placeholder,
}: FormInputProps) => {
  const [value, setValue] = useState<string>(valueini || "");
  const [error, setError] = useState<string>("");

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    validateInput(newValue);
  };

  const validateInput = (inputValue: string) => {
    if (required && !inputValue) {
      setError("This field is required");
      return false;
    }

    if (pattern && !new RegExp(pattern).test(inputValue)) {
      setError("Invalid format");
      return false;
    }

    if (minLength && inputValue.length < minLength) {
      setError(`Minimum ${minLength} characters required`);
      return false;
    }

    if (maxLength && inputValue.length > maxLength) {
      setError(`Maximum ${maxLength} characters allowed`);
      return false;
    }

    setError("");
    return true;
  };

  const getIcon = () => {
    if (!icon) return null;
    return name === "order" ? BoxIcon : MailIcon;
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={name} className="text-xs text-slate-600">
        {title}
      </label>
      <div className="relative">
        <input
          type={type}
          id={name}
          name={name}
          value={value}
          className={cn(
            "w-full p-2 border rounded-md focus:outline-none focus:ring-2",
            error
              ? "border-red-500 focus:ring-red-500"
              : "border-slate-200 focus:ring-blue-500"
          )}
          required={required}
          aria-required={required}
          onChange={handleChange}
          placeholder={placeholder}
          minLength={minLength}
          maxLength={maxLength}
          pattern={pattern}
          aria-invalid={!!error}
          aria-describedby={error ? `${name}-error` : undefined}
        />
        {icon && (
          <div className="absolute right-2 top-1/2 transform -translate-y-1/2">
            <Image
              src={getIcon()}
              alt={`${name} icon`}
              width={20}
              height={20}
              className="w-5 h-5 text-gray-400"
            />
          </div>
        )}
      </div>
      {error && (
        <p id={`${name}-error`} className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

"use client";
import { useState, ChangeEvent, useEffect } from "react";
import { cn } from "@/lib/utils";

interface FormSelectSizeProps {
  name: string;
  title: string;
  options: { value: string; label: string; disabled?: boolean }[];
  valueini?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  onChange?: (value: string) => void;
}

export const FormSelectSize = ({
  name,
  title,
  options,
  valueini,
  required,
  disabled,
  className,
  onChange,
}: FormSelectSizeProps) => {
  const [value, setValue] = useState<string>(valueini || "");
  const [error, setError] = useState<string>("");

  // Update internal state when valueini prop changes
  useEffect(() => {
    if (valueini !== undefined) {
      setValue(valueini);
    }
  }, [valueini]);

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    validateInput(newValue);
    onChange?.(newValue);
  };

  const validateInput = (inputValue: string) => {
    if (required && !inputValue) {
      setError("This field is required");
      return false;
    }
    setError("");
    return true;
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={name} className="text-xs text-slate-600">
        {title}
      </label>
      <div className="relative">
        <select
          id={name}
          name={name}
          value={value}
          className={cn(
            "w-full p-2 border rounded-md focus:outline-none focus:ring-2 appearance-none bg-white",
            error
              ? "border-red-500 focus:ring-red-500"
              : "border-slate-200 focus:ring-blue-500",
            disabled && "bg-gray-100 cursor-not-allowed",
            className
          )}
          required={required}
          disabled={disabled}
          onChange={handleChange}
          aria-required={required}
          aria-invalid={!!error}
          aria-describedby={error ? `${name}-error` : undefined}
        >
          <option value="">Select a size</option>
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className={option.disabled ? "text-gray-400" : ""}
            >
              {option.label}
            </option>
          ))}
        </select>
        <div className="absolute right-2 top-1/2 transform -translate-y-1/2 pointer-events-none">
          <svg
            className="w-5 h-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </div>
      {error && (
        <p id={`${name}-error`} className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

"use client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export const FormSelect = ({
  name,
  title,
  options,
  value,
  onChange,
}: {
  name: string;
  title: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) => {
  return (
    <div className="w-full">
      <h6 className="bg-slate-200 rounded-t-lg text-xxs pl-3 pt-2 text-slate-600">
        {title}
      </h6>
      <Select name={name} value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

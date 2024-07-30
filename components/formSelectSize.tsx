"use client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export const FormSelectSize = ({
  name,
  title,
  options,
  value,
  onChange,
}: {
  name: string;
  title: string;
  options: {
    title: string;
    quantity: number;
  }[];
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
          <SelectValue
            placeholder={options[0].title}
            defaultValue={options[0].title}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.title}
              value={option.title}
              disabled={option.quantity === 0}
            >
              {option.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

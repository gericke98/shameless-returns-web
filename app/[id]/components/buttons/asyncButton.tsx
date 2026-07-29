"use client";
import { returnFunction } from "@/actions/return";
import { cn } from "@/lib/utils";

export const AsyncButton = ({
  text,
  id,
  isCredit,
  email,
}: {
  text: string;
  id: string;
  isCredit: boolean;
  email: string;
}) => {
  return (
    <button
      className={cn(
        // Matches ContinueButton — see nextButton.tsx for why the border stays.
        "bg-white text-black border border-black py-4 rounded-full hover:bg-gray-100 focus:bg-gray-100 transition-colors flex items-center justify-center w-full font-bold"
      )}
      type="submit"
      onClick={async () => {
        await returnFunction(id, isCredit, email);
      }}
    >
      {text}
    </button>
  );
};

import { memo } from "react";
import { OrderWindowContent } from "./orderWindowContent";
import { ClientOrderWindowContentProps, Product } from "@/types";

type OrderWindowProps = {
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  setCredito: React.Dispatch<React.SetStateAction<boolean>>;
  credito: boolean;
  allProducts: Product[];
} & ClientOrderWindowContentProps & {
    onItemChange?: (updatedItem: any) => void;
  };

const OrderWindowBase = ({
  position,
  onItemChange,
  ...props
}: OrderWindowProps) => {
  return (
    <OrderWindowContent
      position={position}
      name={props.name}
      items={props.items}
      order={props.order}
      id={props.id}
      setPosition={props.setPosition}
      setCredito={props.setCredito}
      credito={props.credito}
      onItemChange={onItemChange}
      allProducts={props.allProducts}
    />
  );
};

export const OrderWindow = memo(OrderWindowBase);

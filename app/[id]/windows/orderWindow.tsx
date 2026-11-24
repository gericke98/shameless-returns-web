import { memo } from "react";
import { OrderWindowContent } from "./orderWindowContent";
import type { OrderWindowContentProps } from "@/types";

const OrderWindowBase = (props: OrderWindowContentProps) => (
  <OrderWindowContent {...props} />
);

export const OrderWindow = memo(OrderWindowBase);

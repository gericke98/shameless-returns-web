"use server";

import db from "@/db/drizzle";
import { closeReturn, createRefund } from "@/db/queries";
import { productsOrder } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function validateReturn(product: any, status: string) {
  "use server";
  // For debugging purposes
  status = "Entregado";

  let result;
  let result2;
  if (status === "Entregado") {
    if (product.return_id && product.return_line_item_id) {
      result = await createRefund(
        product.return_id,
        product.return_line_item_id
      );
    }
    if (result?.success) {
      // Cierro el return
      result2 = await closeReturn(product.return_id);
      await db
        .update(productsOrder)
        .set({
          refunded: true,
        })
        .where(eq(productsOrder.variant_id, product.variant_id.toString()));
      revalidatePath("/", "layout");
    }
  }
}

import "server-only";
// The collection address and the replacement's delivery address (F1 spec §4
// `saveAddress`). Never the country: it decides the lane and the fee.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";
import { refuse, type HandlerResult } from "@/lib/actionResult";
import type { CustomerContext } from "@/lib/server/actions";

const field = z.string().max(200);

export const saveAddressInput = z
  .object({
    expectedOrderId: z.string(),
    name: field,
    address1: field,
    address2: field.optional(),
    zip: field,
    city: field,
    province: field.optional(),
    phone: field.optional(),
    delivery: z
      .object({
        name: field,
        address1: field,
        address2: field.optional(),
        zip: field,
        city: field,
        province: field.optional(),
        country: field,
      })
      .strict()
      .nullable(),
    /** Whether the form rendered the delivery block (the basket has an exchange). */
    deliveryBlockOffered: z.boolean(),
  })
  .strict();

export async function saveAddressHandler(
  ctx: CustomerContext,
  input: Omit<z.infer<typeof saveAddressInput>, "expectedOrderId">
): Promise<HandlerResult<{}, "incomplete" | "invalid-delivery" | "not-editable">> {
  const required = [input.name, input.address1, input.zip, input.city];
  if (required.some((v) => v.trim().length === 0)) return refuse("incomplete");

  // The same all-or-nothing parse the form always went through: a partial
  // block or an unsupported country rejects the whole submission.
  const d = input.delivery;
  const delivery = parseDeliveryInput({
    deliveryName: d?.name,
    deliveryAddress1: d?.address1,
    deliveryAddress2: d?.address2,
    deliveryZip: d?.zip,
    deliveryCity: d?.city,
    deliveryProvince: d?.province,
    deliveryCountry: d?.country,
  });
  if (!delivery.ok) {
    console.warn(`saveAddress: rejected the delivery address on order ${ctx.orderId} (${delivery.reason})`);
    return refuse("invalid-delivery");
  }

  const result = await ctx.order.saveAddress({
    name: input.name,
    address1: input.address1,
    address2: input.address2,
    zip: input.zip,
    city: input.city,
    province: input.province,
    phone: input.phone,
    // Only when the block was offered: a pure-return pass never rendered it,
    // and must not wipe a delivery address the customer already paid for.
    ...(input.deliveryBlockOffered ? { delivery: delivery.value } : {}),
  });
  if (result.ok) revalidatePath("/", "layout");
  return result;
}

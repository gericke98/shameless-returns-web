"use client";
import Image from "next/image";
import { FormInput } from "../../../components/formInput";
import { FormSelect } from "../../../components/formSelect";
import { FormSelectSize } from "../../../components/formSelectSize";
import { useState, useTransition, useRef, useEffect } from "react";
import { DialogFooter } from "@/components/ui/dialog";
import { Product } from "@/types";
import { productsOrder } from "@/db/schema";
import { anularOrder, updateOrder } from "@/actions/updateOrder";
import { ACTIONS, REASONS } from "@/placeholder";

type Props = {
  product: Product;
  orderProduct: typeof productsOrder.$inferSelect;
  changed: boolean;
  setChanged: React.Dispatch<React.SetStateAction<boolean>>;
  onSuccess: () => void;
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  allProducts: Product[];
};

export const FormProduct = ({
  product,
  orderProduct,
  changed,
  setChanged,
  onSuccess,
  onItemChange,
  allProducts,
}: Props) => {
  const [action, setAction] = useState<string | null>(
    orderProduct.action === "CAMBIO" ? ACTIONS.CHANGE : ACTIONS.RETURN
  );
  const [motivo, setMotivo] = useState<string>(
    orderProduct.reason || "Me queda pequeño"
  );
  const [size, setSize] = useState<string>(() => {
    // If there's an existing new_variant_title, check if it has stock
    if (orderProduct.new_variant_title && orderProduct.new_variant_id) {
      const existingProduct = allProducts.find((p) =>
        p.variants.edges.some((v) => v.node.id === orderProduct.new_variant_id)
      );

      if (existingProduct) {
        const existingVariant = existingProduct.variants.edges.find(
          (v) => v.node.id === orderProduct.new_variant_id
        );

        // Only use existing variant if it has stock
        if (existingVariant && existingVariant.node.inventoryQuantity > 0) {
          return orderProduct.new_variant_title;
        }
      }
    }

    return orderProduct.variant_title;
  });

  const [variantId, setVariantId] = useState<string>(() => {
    // If there's an existing new_variant_id, check if it has stock
    if (orderProduct.new_variant_id) {
      const existingProduct = allProducts.find((p) =>
        p.variants.edges.some((v) => v.node.id === orderProduct.new_variant_id)
      );

      if (existingProduct) {
        const existingVariant = existingProduct.variants.edges.find(
          (v) => v.node.id === orderProduct.new_variant_id
        );

        // Only use existing variant if it has stock
        if (existingVariant && existingVariant.node.inventoryQuantity > 0) {
          return orderProduct.new_variant_id;
        }
      }
    }

    return "";
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [new_product_change, setNewProductChange] = useState<Product | null>(
    () => {
      // First try to find product with existing new_variant_id
      const existingProduct = allProducts.find((p) =>
        p.variants.edges.some((v) => v.node.id === orderProduct.new_variant_id)
      );

      if (existingProduct) {
        return existingProduct;
      }

      // If no existing new_variant_id, default to the ORIGINAL product (not a random in-stock product)
      // so that when the user selects "Cambio" the dropdown starts on the same item.
      return product?.id ? product : null;
    }
  );

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Update new_product_change when orderProduct changes and set initial variantId
  useEffect(() => {
    if (orderProduct.new_variant_id) {
      const newProduct = allProducts.find((p) =>
        p.variants.edges.some((v) => v.node.id === orderProduct.new_variant_id)
      );

      if (newProduct) {
        setNewProductChange(newProduct);

        // Check if the existing variant has stock
        const existingVariant = newProduct.variants.edges.find(
          (v) => v.node.id === orderProduct.new_variant_id
        );

        if (existingVariant && existingVariant.node.inventoryQuantity > 0) {
          // Keep the existing variant if it has stock
          setVariantId(orderProduct.new_variant_id);
          setSize(orderProduct.new_variant_title || existingVariant.node.title);
        } else {
          // Find a variant with stock in the same product (in size order)
          const availableVariant = getFirstAvailableVariant(newProduct);

          if (availableVariant) {
            setVariantId(availableVariant.node.id);
            setSize(availableVariant.node.title);
          } else {
            // No variants with stock in this product, clear the selection
            setVariantId("");
            setSize("");
          }
        }
      }
    }

    // If there's no persisted new_variant_id, only seed defaults when the user is doing an exchange.
    if (action !== ACTIONS.CHANGE) {
      return;
    }

    // Always default the "Nuevo producto" dropdown to the original product.
    if (product?.id && new_product_change?.id !== product.id) {
      setNewProductChange(product);
    }

    // If the user hasn't picked a size/variant yet, default to the first in-stock size
    // within the (original) product.
    if (!variantId) {
      const baseProduct = product?.id ? product : new_product_change;
      if (!baseProduct) {
        setVariantId("");
        setSize("");
        return;
      }

      const firstAvailableVariant = getFirstAvailableVariant(baseProduct);
      if (firstAvailableVariant) {
        setVariantId(firstAvailableVariant.node.id);
        setSize(firstAvailableVariant.node.title);
      } else {
        // No variants with stock in this product, clear the selection
        setVariantId("");
        setSize("");
      }
    }
  }, [
    orderProduct,
    allProducts,
    variantId,
    new_product_change,
    action,
    product,
  ]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    const formData = new FormData(e.currentTarget);

    try {
      await updateOrder(formData);
      setChanged(!changed);
      if (onItemChange) {
        // Create a proper structure for the updated item based on console logs
        const updatedItem = {
          id: orderProduct.id,
          orderId: orderProduct.orderId,
          variant_id: orderProduct.variant_id,
          variant_title: orderProduct.variant_title,
          action: formData.get("accion") as string,
          reason: formData.get("motivo") as string,
          new_variant_id: formData.get("variantId") as string,
          new_variant_title: formData.get("newSize") as string,
          confirmed: orderProduct.confirmed,
          products: [
            {
              id: orderProduct.id,
              orderId: orderProduct.orderId,
              variant_id: orderProduct.variant_id,
              variant_title: orderProduct.variant_title,
              action: formData.get("accion") as string,
              reason: formData.get("motivo") as string,
              new_variant_id: formData.get("variantId") as string,
              new_variant_title: formData.get("newSize") as string,
              confirmed: orderProduct.confirmed,
            },
          ],
        };
        // Use type assertion to bypass TypeScript type checking
        onItemChange(updatedItem as any);
      }
      onSuccess();
    } catch (error) {
      console.error("updateOrder failed", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAnular = async () => {
    setIsSubmitting(true);
    try {
      await anularOrder(orderProduct.variant_id.toString());
      setChanged(!changed);
      if (onItemChange) {
        // Create a proper structure with products array
        const updatedItem = {
          ...orderProduct,
          products: [orderProduct],
        };
        onItemChange(updatedItem);
      }
      onSuccess();
    } catch (error) {
      console.error("anularOrder failed", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Helper function to get the first available variant with stock in size order
  const getFirstAvailableVariant = (product: Product) => {
    // Define size order based on actual size names from the API
    const sizeOrder = [
      "X-Small",
      "XS",
      "Extra Small",
      "Small",
      "S",
      "Medium",
      "M",
      "Large",
      "L",
      "Extra large",
      "XL",
      "Extra Large",
      "XXL",
      "2XL",
      "Double Extra Large",
      "XXXL",
      "3XL",
      "Triple Extra Large",
    ];

    // Sort variants by size order
    const sortedVariants = [...product.variants.edges].sort((a, b) => {
      const aIndex = sizeOrder.indexOf(a.node.title);
      const bIndex = sizeOrder.indexOf(b.node.title);

      // If both sizes are in the order, sort by their position
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }

      // If only one is in the order, prioritize it
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;

      // If neither is in the order, maintain original order
      return 0;
    });

    // Find the first variant with stock
    const firstAvailable = sortedVariants.find(
      (v) => v.node.inventoryQuantity > 0
    );

    return firstAvailable;
  };

  const handleSizeChange = (value: string) => {
    if (!new_product_change) return;

    const newVariant = new_product_change.variants.edges.find(
      (v) => v.node.title === value
    )?.node;

    if (newVariant) {
      // Store the full GraphQL ID, not just the numeric part
      setVariantId(newVariant.id);
      setSize(value);
    }
  };

  const sizeStock =
    new_product_change?.variants.edges.map((variant) => ({
      value: variant.node.title,
      label: variant.node.title,
      disabled: variant.node.inventoryQuantity === 0,
    })) || [];

  const showNewProduct = action === ACTIONS.CHANGE && motivo !== "";

  return (
    <div className="relative">
      <form
        className="mt-10 w-full flex flex-col gap-5"
        onSubmit={handleSubmit}
      >
        <input
          type="hidden"
          name="oldVariantId"
          value={orderProduct.variant_id}
          readOnly
        />
        <input type="hidden" name="id" value={orderProduct.id} readOnly />
        <input type="hidden" name="variantId" value={variantId} readOnly />

        <FormSelect
          name="accion"
          title="Acción a realizar"
          options={[
            { value: ACTIONS.CHANGE, label: "Cambio" },
            { value: ACTIONS.RETURN, label: "Devolución" },
          ]}
          valueini={action || "CAMBIO"}
          onChange={setAction}
        />

        <FormSelect
          name="motivo"
          title={
            action === ACTIONS.CHANGE
              ? "Motivo del cambio"
              : "Motivo de la devolución"
          }
          options={REASONS.map((reason) => ({ value: reason, label: reason }))}
          valueini={motivo}
          onChange={setMotivo}
        />

        <FormInput name="notas" title="Notas" icon={false} valueini="" />

        {showNewProduct && (
          <div className="w-full flex flex-col mt-8 gap-3">
            <h3 className="text-base font-bold">NUEVO PRODUCTO</h3>

            {/* Custom Dropdown with Images */}
            <div className="w-full">
              <label
                htmlFor="newProduct"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Seleccionar producto
              </label>

              <div className="relative" ref={dropdownRef}>
                {/* Dropdown Button */}
                <button
                  type="button"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 flex items-center justify-between"
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                >
                  <div className="flex items-center">
                    {new_product_change?.id ? (
                      <>
                        <div className="relative w-8 h-8 mr-2">
                          <Image
                            src={new_product_change.image.src}
                            alt={new_product_change.title}
                            fill
                            sizes="32px"
                            className="object-cover rounded-sm"
                          />
                        </div>
                        <span>{new_product_change.title}</span>
                      </>
                    ) : (
                      <span className="text-gray-500">
                        Selecciona un producto
                      </span>
                    )}
                  </div>
                  <svg
                    className={`h-5 w-5 text-gray-400 transition-transform ${
                      isDropdownOpen ? "rotate-180" : ""
                    }`}
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>

                {/* Hidden input for form submission */}
                <input
                  type="hidden"
                  name="newProduct"
                  value={new_product_change?.id || ""}
                />

                {/* Dropdown Options */}
                {isDropdownOpen && (
                  <div className="absolute z-10 mt-1 w-full bg-white shadow-lg max-h-60 rounded-md py-1 text-base overflow-auto focus:outline-none sm:text-sm">
                    {allProducts
                      .map((p) => {
                        // Calculate total stock across all variants
                        const totalStock = p.variants.edges.reduce(
                          (sum, v) => sum + v.node.inventoryQuantity,
                          0
                        );

                        // Check if product has any variants with stock
                        const hasStock = totalStock > 0;

                        // Get the first variant with stock or the first variant if none have stock
                        const firstVariant = p.variants.edges[0]?.node;
                        const price = firstVariant?.price || "";

                        return {
                          product: p,
                          totalStock,
                          hasStock,
                          price,
                        };
                      })
                      // Sort by total stock (highest first)
                      .sort((a, b) => b.totalStock - a.totalStock)
                      .map(({ product: p, hasStock, price }) => (
                        <div
                          key={p.id}
                          className={`relative py-2 pl-3 pr-9 flex items-center ${
                            new_product_change?.id === p.id ? "bg-cyan-50" : ""
                          } ${
                            hasStock
                              ? "cursor-pointer hover:bg-gray-100"
                              : "cursor-not-allowed opacity-50"
                          }`}
                          onClick={() => {
                            if (hasStock) {
                              setNewProductChange(p);

                              // Find the first variant with stock in size order
                              const firstAvailableVariant =
                                getFirstAvailableVariant(p);

                              if (firstAvailableVariant) {
                                // Set the size to the first available variant's title
                                setSize(firstAvailableVariant.node.title);
                                // Set the variant ID - store the full GraphQL ID
                                setVariantId(firstAvailableVariant.node.id);
                              } else {
                                // If no variants with stock (shouldn't happen due to hasStock check)
                                setSize("");
                                setVariantId("");
                              }

                              setIsDropdownOpen(false);
                            }
                          }}
                        >
                          <div className="flex items-center w-full">
                            <div className="relative w-8 h-8 mr-2 flex-shrink-0">
                              <Image
                                src={p.image.src}
                                alt={p.title}
                                fill
                                sizes="32px"
                                className="object-cover rounded-sm"
                              />
                            </div>
                            <div className="flex flex-col">
                              <span className="block truncate">{p.title}</span>
                              <span className="text-xs text-gray-500">
                                {price} €
                              </span>
                            </div>
                          </div>

                          {new_product_change?.id === p.id && (
                            <span className="absolute inset-y-0 right-0 flex items-center pr-4 text-cyan-800">
                              <svg
                                className="h-5 w-5"
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                  clipRule="evenodd"
                                />
                              </svg>
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* Selected Product Preview */}
              {new_product_change?.id && (
                <div className="mt-3 flex items-center p-2 border border-gray-200 rounded-md">
                  <div className="relative w-12 h-12 mr-3">
                    <Image
                      src={new_product_change.image.src}
                      alt={new_product_change.title}
                      fill
                      sizes="48px"
                      className="object-cover rounded-sm"
                    />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {new_product_change.title}
                    </p>
                    <p className="text-xs text-gray-500">
                      {new_product_change.variants.edges[0]?.node.price || ""} €
                    </p>
                  </div>
                </div>
              )}
            </div>

            {new_product_change && (
              <FormSelectSize
                name="newSize"
                title="Nueva talla"
                options={sizeStock}
                valueini={size}
                onChange={handleSizeChange}
              />
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="bg-cyan-800 text-white py-3 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full mt-8 font-bold"
        >
          Confirmar selección
        </button>

        <DialogFooter className="w-full" />
      </form>

      <button
        onClick={handleAnular}
        disabled={isSubmitting}
        className="bg-white border border-cyan-800 py-3 rounded-full hover:bg-cyan-800 focus:bg-cyan-800 flex items-center justify-center w-full -mt-2 mb-2 hover:text-white font-bold"
      >
        Anular selección
      </button>

      {isSubmitting && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white bg-opacity-80 z-10">
          <svg
            className="animate-spin h-8 w-8 text-cyan-800"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8H4z"
            ></path>
          </svg>
          <span className="mt-2 text-sm text-cyan-800">Procesando...</span>
        </div>
      )}
    </div>
  );
};

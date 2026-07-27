// The canonical dictionary. en.ts is typed against this shape, so adding a
// key here without adding it there is a compile error.
export const es = {
  common: {
    continue: "Continuar",
    processing: "Procesando...",
    updateOrder: "Actualizar pedido",
    header: "CAMBIOS Y DEVOLUCIONES",
  },
  lookup: {
    intro: "Introduce los datos de tu pedido original para iniciar el proceso.",
    policyLink: "Ver política de devoluciones",
    orderNumber: "Número de pedido",
    orderPlaceholder: "Introduce tu número de pedido",
    email: "Email",
    emailPlaceholder: "Introduce tu email",
    submit: "Buscar pedido",
    consent: "Al continuar, confirmas que aceptas los",
    errorTitle: "Ha habido un error en tu solicitud",
  },
  first: {
    orderTitle: "Pedido",
    selectPrompt: "Selecciona los productos que deseas gestionar:",
  },
  dialog: {
    actionTitle: "Acción a realizar",
    actionChange: "Cambio",
    actionReturn: "Devolución",
    reasonChange: "Motivo del cambio",
    reasonReturn: "Motivo de la devolución",
    notes: "Notas",
    newSize: "Nueva talla",
  },
  reasons: {
    TOO_BIG: "Me queda grande",
    TOO_SMALL: "Me queda pequeño",
    UNCOMFORTABLE: "Es incómodo o me hace daño",
    DISLIKE: "No me gusta",
    BOUGHT_OPTIONS: "Compré varias opciones para probar",
    DAMAGED: "El producto está dañado",
    WRONG_ITEM: "Recibí el producto equivocado",
    LATE: "El producto llegó demasiado tarde",
    OTHER: "Otro motivo",
    NOT_AS_SHOWN: "El producto no es como se mostraba",
  },
  second: {
    title: "Método de devolución",
    subtitle:
      "Escoge el método de envío que quieres usar para devolver los productos seleccionados",
    correosDropoff: "Entrega en punto de recogida Correos",
    cost: "Coste",
    dropoffTitle: "Entrega en punto de recogida",
    dropoffBody:
      "Valida tu dirección de envío para poder generar la etiqueta de devolución que recibirás en tu email, con la que podrás llevar tu paquete a un punto de recogida de Correos.",
    dropoffLink: "Ver listado",
    name: "Nombre",
    address: "Calle y número",
    address2: "Apartamento, local, etc (Opcional)",
    zip: "Código postal",
    city: "Ciudad",
    province: "Provincia",
    country: "País",
    phone: "Teléfono",
  },
  third: {
    title: "Elige tu reembolso",
    storeCredit: "Crédito en tienda",
    storeCreditBadge: "+15% extra",
    storeCreditBody:
      "Recibe, cuando se acepte tu devolución, un cheque regalo para volver a comprar en la tienda online de Shameless Collective, con hasta un +15% extra de regalo sobre tu devolución.",
    originalPayment: "Método de pago original",
    originalPaymentBody:
      "Recibe tu dinero, cuando se acepte tu devolución, en el método de pago que usaste en tu compra. Puede demorar hasta 15 días.",
    totalRefund: "Reembolso total",
  },
  summary: {
    heading: "DESGLOSE DE TU SOLICITUD",
    toReturn: "Productos a devolver",
    newProducts: "Nuevos productos",
    andLogistics: "& Logística",
    shipping: "Envío",
    bonus: "Bonificaciones - Crédito en tienda",
    totalRefund: "Total reembolso",
    totalToPay: "Total a pagar",
    provisional: "Resumen provisional. Puede cambiar a lo largo del proceso",
  },
  last: {
    title: "Resumen final",
    exchangeTitle: "Cambio de productos",
    exchangeBodyBold: "Una vez devuelvas tus productos,",
    exchangeBodyRest: "recibirás los nuevos que has seleccionado.",
    creditTitle: "Crédito en tienda",
    creditBodyStart: "Recibirás en tu correo un código por valor de",
    creditBodyMid: "con el que comprar de nuevo en Shameless Collective,",
    creditBodyEnd: "cuando se acepte tu devolución.",
    refundTitle: "Reembolso tradicional",
    refundBodyStart: "Recibirás tu reembolso de",
    refundBodyMid: "en el método de pago que usaste en tu compra original,",
    refundBodyEnd: "cuando se acepte tu devolución.",
    refundDelayStart:
      "Debido al tiempo necesario para recibir los productos, revisarlos, y procesar la devolución,",
    refundDelayBold: "pueden pasar hasta 15 días",
    refundDelayEnd: "hasta que recibas tu dinero.",
  },
  success: {
    title: "¡Hemos recibido tu solicitud correctamente!",
    body: "Hemos recibido tu solicitud y te hemos enviado un correo electrónico con los próximos pasos.",
  },
} as const;

// `es` is `as const`, so `typeof es` alone would type every leaf as its exact
// Spanish string literal (e.g. `"Continuar"`), which would make it
// impossible for en.ts to ever compile with different English text. Widen
// walks the const type and turns string/number/boolean literals back into
// their base type while leaving the object shape (and `readonly`) intact, so
// a missing or renamed key is still a compile error but a different
// translated value is not.
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : { [K in keyof T]: Widen<T[K]> };

export type Dictionary = Widen<typeof es>;

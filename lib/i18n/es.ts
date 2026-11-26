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
    sessionExpired: "Vuelve a buscar tu pedido para continuar.",
    tooManyAttempts:
      "Demasiados intentos. Espera unos minutos y vuelve a probar.",
    // The lookup's refusals (lib/server/handlers/lookup.ts), by key. One
    // message for an unknown number and one for a wrong email, as before.
    invalidInput: "Introduce un número de pedido válido.",
    notFound: "Introduce un pedido válido.",
    mismatch: "Introduce un email válido.",
    contactSupport:
      "Escríbenos a hello@shamelesscollective.com con tu número de pedido para devolver productos de este pedido.",
    notYetShipped:
      "Estamos preparando tu pedido. Escríbenos a hello@shamelesscollective.com si necesitas algún cambio.",
    outsideWindow:
      "Solo podemos gestionar cambios y devoluciones en los 60 días siguientes a la entrega, y tu pedido se entregó hace más de 60 días.",
    failed:
      "No hemos podido buscar tu pedido. Inténtalo de nuevo en unos minutos.",
  },
  first: {
    orderTitle: "Pedido",
    selectPrompt: "Selecciona los productos que deseas gestionar:",
  },
  productLine: {
    selection: "Selección",
    alreadyModified: "El producto ya ha sido modificado",
  },
  dialog: {
    actionTitle: "Acción a realizar",
    actionChange: "Cambio",
    actionReturn: "Devolución",
    reasonChange: "Motivo del cambio",
    reasonReturn: "Motivo de la devolución",
    notes: "Notas",
    newSize: "Nueva talla",
    // Rendered upper-case in the markup, so the casing lives here rather than
    // in a .toUpperCase() call: other languages may not want shouting.
    newProductHeading: "NUEVO PRODUCTO",
    selectProduct: "Seleccionar producto",
    selectProductPlaceholder: "Selecciona un producto",
    confirm: "Confirmar selección",
    clear: "Anular selección",
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
    saveError: "No hemos podido guardar la dirección. Revisa los datos e inténtalo de nuevo.",
    subtitle:
      "Escoge el método de envío que quieres usar para devolver los productos seleccionados",
    // Two different flows, not two wordings for one: a Spanish parcel is
    // dropped at a Correos point, an international one is collected from the
    // customer's address by whoever Amphora routes it to.
    pickup: "Recogida a domicilio",
    pickupTitle: "Recogida a domicilio",
    pickupBody:
      "Valida tu dirección para que podamos organizar la recogida. El transportista pasará a recoger tu paquete en esa dirección.",
    dropoff: "Entrega en punto de recogida Correos",
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
    // La dirección de entrega alternativa. Solo se muestra cuando hay un
    // cambio: una devolución pura no tiene nada que entregar.
    deliverElsewhere: "Enviar mi producto de cambio a otra dirección",
    deliverElsewhereHint:
      "Tu paquete se seguirá recogiendo en la dirección de arriba. Solo el producto de cambio se envía aquí, y el coste de envío se actualiza para ese país.",
    deliveryCountry: "País de entrega",
    deliveryCountryPlaceholder: "Selecciona un país",
    deliveryIncomplete:
      "Por favor, rellena todos los campos de entrega salvo los opcionales.",
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
    returnShipping: "Envío de devolución",
    deliveryShipping: "Envío de los nuevos productos",
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
  method: {
    title: "¿Cómo quieres enviarlo?",
    ourLabel: "Lo enviamos nosotros",
    selfLabel: "Lo envío yo",
    selfHint:
      "Tú eliges el transportista y pagas el envío. Después nos dices el número de seguimiento.",
    free: "gratis",
  },
  tracking: {
    title: "Dinos el número de seguimiento",
    intro:
      "Cuando hayas enviado el paquete, dinos con quién lo has enviado para que el almacén lo espere.",
    carrier: "Transportista",
    number: "Número de seguimiento",
    submit: "Enviar",
    permanent:
      "No podremos cambiarlo después, así que revísalo bien antes de enviarlo.",
    done: "¡Gracias! El almacén ya sabe que tu paquete está en camino.",
    error: "No hemos podido guardarlo. Revisa los datos e inténtalo de nuevo.",
    // Only for a carrier whose tracking link we cannot build ("Otro").
    link: "Enlace de seguimiento",
    linkHelp:
      "Pega el enlace de seguimiento que te dio el transportista (en su email o en el recibo). El almacén lo necesita para esperar tu paquete.",
    linkInvalid: "Eso no parece un enlace. Debe empezar por https://",
    noLink: "¿No tienes enlace? Escríbenos a hello@shamelesscollective.com con tu número de pedido.",
    orderNumber:
      "Ese es tu número de pedido. Necesitamos el número de seguimiento que te dio el transportista, en el recibo o en su email.",
    wrongFormat: "Ese número no parece de este transportista. Ejemplo:",
    pending:
      "¡Gracias! Lo hemos guardado. Vamos a comprobar el número con el transportista y avisaremos al almacén; si hay algún problema, te escribiremos.",
    notAtCarrier:
      "El transportista no reconoce este número. Revisa que esté bien copiado del recibo o de su email. Si acabas de enviar el paquete, vuelve a intentarlo en unas horas.",
    tooLong: "Es demasiado largo para un número de seguimiento. Revisa que hayas copiado solo el número.",
  },
  success: {
    title: "¡Hemos recibido tu solicitud correctamente!",
    body: "Hemos recibido tu solicitud y te hemos enviado un correo electrónico con los próximos pasos.",
    carrierLabel: "Transportista",
    trackingLabel: "Número de seguimiento",
  },
  error: {
    title: "Algo ha salido mal",
    body: "No hemos podido completar la operación. Vuelve a intentarlo. Si el problema continúa, escríbenos a hello@shamelesscollective.com con tu número de pedido.",
    retry: "Reintentar",
  },
  action: {
    // Shared answers to a server action that did not do what was asked
    // (lib/callAction.ts, F1 spec §7). Domain refusals with their own words
    // (tracking, cancel) keep them in their own sections.
    notSaved: "No se ha guardado. Comprueba tu conexión e inténtalo de nuevo.",
    failed:
      "No hemos podido completar la operación. Vuelve a intentarlo. Si el problema continúa, escríbenos a hello@shamelesscollective.com con tu número de pedido.",
    orderMismatch:
      "Has abierto otro pedido en otra pestaña. Recarga esta página para seguir con el pedido correcto.",
    notAdmin: "Tu sesión de administrador ha caducado. Vuelve a entrar.",
    invalidInput: "Revisa los datos e inténtalo de nuevo.",
    nothingSelected: "No has elegido ningún artículo. Vuelve atrás y elige qué quieres devolver o cambiar.",
    submissionInProgress: "Ya estamos procesando tu solicitud. Espera unos segundos antes de volver a intentarlo.",
    notEditable: "Este artículo ya no se puede cambiar. Recarga la página.",
    variantNotOffered: "Esa talla ya no está disponible. Elige otra.",
    incomplete: "Completa todos los campos obligatorios de la dirección.",
    invalidDelivery: "Revisa la dirección de entrega del cambio.",
  },
  cancel: {
    heading: "Tu devolución",
    trackingLabel: "Número de seguimiento",
    carrierLabel: "Transportista",
    button: "Cancelar mi devolución",
    confirmQuestion: "¿Seguro que quieres cancelar?",
    confirmDetail:
      "Te devolveremos todo lo que has pagado. La etiqueta que te enviamos dejará de ser válida.",
    confirmYes: "Sí, cancelar",
    confirmNo: "No, mantenerla",
    cancelling: "Cancelando...",
    doneTitle: "Hemos cancelado tu devolución",
    doneBody:
      "Te devolveremos el importe en el método de pago que usaste. No utilices la etiqueta que te enviamos.",
    startNew: "Empezar una nueva solicitud",
    blockedInTransit:
      "Tu paquete ya está de camino hacia nosotros, así que esta devolución ya no se puede cancelar.",
    blockedSettled:
      "Ya hemos procesado esta devolución, así que no se puede cancelar. Escríbenos si necesitas ayuda.",
    blockedUnreadable:
      "Ahora mismo no podemos comprobar el estado de tu paquete. Inténtalo de nuevo en unos minutos.",
    failed:
      "No hemos podido cancelar tu devolución. Escríbenos a hello@shamelesscollective.com con tu número de pedido.",
    emailSubject: "Hemos cancelado la devolución de tu pedido",
    emailBody:
      "Hemos cancelado tu devolución y te reembolsaremos lo que pagaste en el método de pago original.",
    emailLabelWarning:
      "IMPORTANTE: la etiqueta de envío que te enviamos ya no es válida. Si quieres devolver algo más adelante, empieza una nueva solicitud y te enviaremos una etiqueta nueva.",
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

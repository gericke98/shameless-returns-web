import type { Dictionary } from "./es";

// Typed against the Spanish dictionary: a key added to es.ts and forgotten
// here fails `npm run build` instead of rendering "undefined" to a customer.
export const en: Dictionary = {
  common: {
    continue: "Continue",
    processing: "Processing...",
    updateOrder: "Update order",
    header: "RETURNS & EXCHANGES",
  },
  lookup: {
    intro: "Enter your original order details to start the process.",
    policyLink: "See returns policy",
    orderNumber: "Order number",
    orderPlaceholder: "Enter your order number",
    email: "Email",
    emailPlaceholder: "Enter your email",
    submit: "Find order",
    consent: "By continuing, you confirm that you accept the",
    errorTitle: "There was an error in your request",
    sessionExpired: "Please look up your order to continue.",
    tooManyAttempts:
      "Too many attempts. Please wait a few minutes and try again.",
  },
  first: {
    orderTitle: "Order",
    selectPrompt: "Select the items you want to manage:",
  },
  productLine: {
    selection: "Selection",
    alreadyModified: "This item has already been updated",
  },
  dialog: {
    actionTitle: "Action",
    actionChange: "Exchange",
    actionReturn: "Return",
    reasonChange: "Reason for the exchange",
    reasonReturn: "Reason for the return",
    notes: "Notes",
    newSize: "New size",
    newProductHeading: "NEW ITEM",
    selectProduct: "Select an item",
    selectProductPlaceholder: "Choose an item",
    confirm: "Confirm selection",
    clear: "Clear selection",
  },
  reasons: {
    TOO_BIG: "Too big",
    TOO_SMALL: "Too small",
    UNCOMFORTABLE: "Uncomfortable or it hurts",
    DISLIKE: "I don't like it",
    BOUGHT_OPTIONS: "I bought several options to try",
    DAMAGED: "The item is damaged",
    WRONG_ITEM: "I received the wrong item",
    LATE: "The item arrived too late",
    OTHER: "Another reason",
    NOT_AS_SHOWN: "The item is not as shown",
  },
  second: {
    title: "Return method",
    subtitle: "Choose the shipping method you want to use to return the selected items",
    // Two different flows, not two wordings for one: a Spanish parcel is
    // dropped at a Correos point, an international one is collected from the
    // customer's address by whoever Amphora routes it to.
    pickup: "Pickup from your address",
    pickupTitle: "Pickup from your address",
    pickupBody:
      "Confirm your address so we can arrange the collection. The carrier will pick your parcel up there.",
    dropoff: "Drop off at a Correos pickup point",
    cost: "Cost",
    dropoffTitle: "Drop off at a pickup point",
    dropoffBody:
      "Confirm your shipping address so we can generate the return label you will receive by email, which you can use to drop your parcel at a Correos pickup point.",
    dropoffLink: "See locations",
    name: "Name",
    address: "Street and number",
    address2: "Apartment, unit, etc. (Optional)",
    zip: "Postcode",
    city: "City",
    province: "Province",
    country: "Country",
    phone: "Phone",
  },
  third: {
    title: "Choose your refund",
    storeCredit: "Store credit",
    storeCreditBadge: "+15% extra",
    storeCreditBody:
      "Once your return is accepted, receive a gift voucher to shop again at the Shameless Collective online store, with up to +15% extra on top of your refund.",
    originalPayment: "Original payment method",
    originalPaymentBody:
      "Once your return is accepted, receive your money back via the payment method you used for your purchase. It can take up to 15 days.",
    totalRefund: "Total refund",
  },
  summary: {
    heading: "BREAKDOWN OF YOUR REQUEST",
    toReturn: "Items to return",
    newProducts: "New items",
    andLogistics: "& Shipping",
    shipping: "Shipping",
    returnShipping: "Return shipping",
    deliveryShipping: "Delivery of new items",
    bonus: "Bonus - Store credit",
    totalRefund: "Total refund",
    totalToPay: "Total to pay",
    provisional: "Provisional summary. It may change during the process",
  },
  last: {
    title: "Final summary",
    exchangeTitle: "Item exchange",
    exchangeBodyBold: "Once you return your items,",
    exchangeBodyRest: "you will receive the new ones you selected.",
    creditTitle: "Store credit",
    creditBodyStart: "You will receive a code by email worth",
    creditBodyMid: "to shop again at Shameless Collective,",
    creditBodyEnd: "once your return is accepted.",
    refundTitle: "Standard refund",
    refundBodyStart: "You will receive your refund of",
    refundBodyMid: "via the payment method you used for your original purchase,",
    refundBodyEnd: "once your return is accepted.",
    refundDelayStart:
      "Because we need time to receive the items, inspect them and process the return,",
    refundDelayBold: "it can take up to 15 days",
    refundDelayEnd: "for you to receive your money.",
  },
  method: {
    title: "How would you like to send it?",
    ourLabel: "We ship it",
    selfLabel: "I'll ship it myself",
    selfHint:
      "You choose the carrier and pay the postage. Afterwards you tell us the tracking number.",
    free: "free",
  },
  tracking: {
    title: "Tell us the tracking number",
    intro:
      "Once you have sent the parcel, tell us who you sent it with so the warehouse can expect it.",
    carrier: "Carrier",
    number: "Tracking number",
    submit: "Send",
    permanent: "We cannot change this later, so please check it carefully.",
    done: "Thank you! The warehouse now knows your parcel is on its way.",
    error: "We could not save that. Check the details and try again.",
  },
  success: {
    title: "We have received your request!",
    body: "We have received your request and sent you an email with the next steps.",
    carrierLabel: "Carrier",
    trackingLabel: "Tracking number",
  },
  error: {
    title: "Something went wrong",
    body: "We could not complete that. Please try again. If the problem persists, email us at hello@shamelesscollective.com with your order number.",
    retry: "Try again",
  },
  cancel: {
    heading: "Your return",
    trackingLabel: "Tracking number",
    carrierLabel: "Carrier",
    button: "Cancel my return",
    confirmQuestion: "Are you sure you want to cancel?",
    confirmDetail:
      "We'll refund everything you paid. The label we sent you will stop working.",
    confirmYes: "Yes, cancel it",
    confirmNo: "No, keep it",
    cancelling: "Cancelling...",
    doneTitle: "We've cancelled your return",
    doneBody:
      "We'll refund you to the payment method you used. Please don't use the label we sent you.",
    startNew: "Start a new request",
    blockedInTransit:
      "Your parcel is already on its way to us, so this return can no longer be cancelled.",
    blockedSettled:
      "We've already processed this return, so it can't be cancelled. Get in touch if you need a hand.",
    blockedUnreadable:
      "We can't check on your parcel right now. Please try again in a few minutes.",
    failed:
      "We couldn't cancel your return. Please email hello@shamelesscollective.com with your order number.",
    emailSubject: "We've cancelled the return for your order",
    emailBody:
      "We've cancelled your return and will refund what you paid to your original payment method.",
    emailLabelWarning:
      "IMPORTANT: the shipping label we sent you is no longer valid. If you'd like to return something later, start a new request and we'll send you a fresh label.",
  },
};

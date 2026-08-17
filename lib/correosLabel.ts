// Pure — no db, no env, no network. Reading the Correos PreRegistro response.
//
// Lives here rather than in `actions/shipping.ts` because that module is
// `"use server"`, where every export must be an async function: a sync helper
// exported from it fails the Next build (tsc and vitest both pass it happily,
// so the build is the only thing that catches it).

/**
 * The label PDF from a Correos PreRegistro response, or null if it sent none.
 *
 * Correos returns the PDF exactly once, base64 in `<Fichero>`, and there is no
 * way to ask for it again — hence `return_labels`, which keeps it so a lost
 * confirmation email does not cost a whole new parcel.
 *
 * A missing `<Fichero>` is NOT the same as a failed registration:
 * `sendShippingLabel` validates `<Resultado>` and `<CodEnvio>` only, so a
 * response can describe a perfectly registered parcel and still carry no label
 * to put on it. Callers must treat null as "registered, but we have nothing to
 * send the customer".
 */
export function extractLabelPdf(soapBody: string): string | null {
  return String(soapBody ?? "").match(/<Fichero>(.*?)<\/Fichero>/)?.[1] ?? null;
}

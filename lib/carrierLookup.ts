// The network half of tracking verification: ask the carrier, hand the answer
// to the pure verdicts in lib/trackingVerification. Server-only, and NOT a
// "use server" module (every export of one is a callable endpoint).
//
// Every failure here (timeout, HTTP error, missing credentials) is
// "unreadable": a lookup that told us nothing is not evidence about the parcel,
// so it sends the number to ops rather than refusing or approving it.
import { nacexParts } from "@/lib/carriers";
import {
  bpostVerdict,
  correosVerdict,
  nacexVerdict,
  type Verdict,
  type Verifier,
} from "@/lib/trackingVerification";

const TIMEOUT_MS = 10_000;

async function get(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function correos(number: string): Promise<Verdict> {
  const username = process.env.USERNAME_CORREOS;
  const password = process.env.PASSWORD_CORREOS;
  if (!username || !password) return "unreadable";
  const auth = Buffer.from(`${username}:${password}`).toString("base64");
  const res = await get(
    `https://localizador.correos.es/canonico/eventos_envio_servicio_auth/${encodeURIComponent(number)}?codIdioma=ES&indUltEvento=S`,
    { Authorization: `Basic ${auth}` }
  );
  if (!res) return "unreadable";
  try {
    return correosVerdict(await res.json(), number);
  } catch {
    return "unreadable";
  }
}

async function nacex(number: string): Promise<Verdict> {
  const parts = nacexParts(number);
  if (!parts) return "unknown";
  const res = await get(
    `https://www.nacex.es/seguimientoDetalle.do?agencia_origen=${encodeURIComponent(parts.agency)}&numero_albaran=${encodeURIComponent(parts.note)}&externo=N`
  );
  if (!res) return "unreadable";
  // NACEX serves ISO-8859-1; the verdict only reads ASCII markers, so latin1
  // decoding is exact for everything it looks at.
  return nacexVerdict(new TextDecoder("latin1").decode(await res.arrayBuffer()), parts);
}

async function bpost(number: string): Promise<Verdict> {
  const res = await fetch(
    `https://track.bpost.cloud/track/items?itemIdentifier=${encodeURIComponent(number)}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" }
  ).catch(() => null);
  if (!res) return "unreadable";
  try {
    // bpost answers an unknown number with a JSON error body; read it whatever the status.
    return bpostVerdict(await res.json(), number);
  } catch {
    return "unreadable";
  }
}

const LOOKUPS: Record<Verifier, (number: string) => Promise<Verdict>> = { correos, nacex, bpost };

/** Never throws: anything that goes wrong, including reading the body, is "unreadable". */
export async function verifyWithCarrier(verifier: Verifier, number: string): Promise<Verdict> {
  try {
    return await LOOKUPS[verifier](number);
  } catch {
    return "unreadable";
  }
}

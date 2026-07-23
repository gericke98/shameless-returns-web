import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

// Proxy endpoint for Sendcloud return labels. The Sendcloud label URL is an
// authenticated API endpoint (401 for customers) AND the PDF renders a while
// after the return is created — so we can't email the raw URL or attach the PDF
// synchronously. Instead the confirmation email links here; this route fetches
// the label server-side with our API key at click time (by when it's rendered)
// and streams the PDF. Links are HMAC-signed so parcel ids can't be enumerated.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SENDCLOUD_API = "https://panel.sendcloud.sc/api/v3";

function isValidSignature(parcelId: string, sig: string): boolean {
  const secret = process.env.SENDCLOUD_SECRET_KEY;
  if (!secret || !sig) return false;
  const expected = crypto.createHmac("sha256", secret).update(parcelId).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(
  req: NextRequest,
  { params }: { params: { parcelId: string } }
) {
  const { parcelId } = params;
  const sig = req.nextUrl.searchParams.get("sig") ?? "";

  // Only numeric parcel ids, and the signature must match — else behave as 404.
  if (!/^\d+$/.test(parcelId) || !isValidSignature(parcelId, sig)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const pub = process.env.SENDCLOUD_PUBLIC_KEY;
  const sec = process.env.SENDCLOUD_SECRET_KEY;
  if (!pub || !sec) {
    return new NextResponse("Label service not configured", { status: 500 });
  }
  const auth = "Basic " + Buffer.from(`${pub}:${sec}`).toString("base64");
  const labelUrl = `${SENDCLOUD_API}/parcels/${parcelId}/documents/label?paper_size=a4`;

  // The PDF can 400/404 for a while after creation while it renders — retry.
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(labelUrl, { headers: { Authorization: auth } });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.subarray(0, 5).toString() === "%PDF-") {
          return new NextResponse(buf, {
            status: 200,
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": 'inline; filename="Return_label.pdf"',
              "Cache-Control": "private, no-store",
            },
          });
        }
      }
    } catch {
      // transient — retry
    }
  }

  return new NextResponse(
    "Your label is still being generated. Please try again in a minute.",
    { status: 503 }
  );
}

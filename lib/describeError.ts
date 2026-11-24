// One readable line for any thrown value, for alerts and logs that outlive the
// request. Pure.
//
// Why it exists: five alert sites each wrote their own
// `${error?.response?.data || error?.message || error}`. When an API answers
// with a JSON body, `response.data` is an object, and interpolating it prints
// "[object Object]" — which is all ops got when Amphora refused the self-booked
// approvals for #312783 and #312737 (2026-11-23), so the real reason was lost.

/** Long enough for an API's validation errors, short enough for an email. */
const MAX_LENGTH = 2000;

function serialise(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function describeError(error: unknown): string {
  const e = error as any;
  let text: string;
  if (e?.response !== undefined && e?.response !== null) {
    // An HTTP client error (axios): the status and the body the API sent are
    // the diagnosis; the client's own message ("Request failed with status
    // code 422") says less than both.
    const status = e.response.status;
    const body = e.response.data;
    const shown = body === undefined || body === null || body === "" ? e.message : serialise(body);
    text = status ? `HTTP ${status}: ${shown}` : serialise(shown);
  } else if (error instanceof Error) {
    text = error.message;
  } else {
    text = serialise(error);
  }
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}… (truncated)` : text;
}

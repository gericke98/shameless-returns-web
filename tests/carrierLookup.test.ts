import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWithCarrier } from "@/lib/carrierLookup";

// Codex review: a body that fails AFTER the headers arrived (connection drop,
// timeout during arrayBuffer) escaped the lookup and made submit throw instead
// of sending the number to ops. Every failure is "unreadable".
describe("verifyWithCarrier", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["nacex", "bpost", "correos"] as const)("is unreadable when %s's body cannot be read", async (verifier) => {
    process.env.USERNAME_CORREOS ??= "u";
    process.env.PASSWORD_CORREOS ??= "p";
    process.env.CODIGO_ETIQUETADOR_CORREOS ??= "c";
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.reject(new Error("aborted")),
      json: () => Promise.reject(new Error("aborted")),
    }));
    const number = verifier === "nacex" ? "7280/13972666" : "CE643871536BE";
    await expect(verifyWithCarrier(verifier, number)).resolves.toBe("unreadable");
  });

  it("is unreadable when the request itself fails", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNRESET")));
    await expect(verifyWithCarrier("nacex", "7280/13972666")).resolves.toBe("unreadable");
  });
});

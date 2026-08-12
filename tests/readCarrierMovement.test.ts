import { beforeEach, describe, expect, it, vi } from "vitest";

// Which carrier we are allowed to ask about a parcel.
//
// `readCarrierMovement` asks the Correos localizador. That is right for a
// Spanish return, whose `locator` holds a Correos CodEnvio. It is wrong — and
// silently fatal — for an international one, where `locator` holds Amphora's
// `carrier_number` (a UPS/DHL/GLS reference). Correos answers a code it has
// never heard of with an error block, which `carrierMovement` reads as
// "unreadable", which `cancelEligibility` turns into `carrier-unreadable`, and
// the customer is told to "try again in a few minutes" forever. The entire
// non-Spain lane could not be cancelled at all.
//
// So the query is gated on `tracksWithCorreos(carrier)`: no Correos, no call,
// and movement for those returns is carried by the Amphora `returnStatus` gate
// in `cancelEligibility` instead.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/db/queries", () => ({
  getOrderById: async () => null,
  getVariantSkusByIds: async () => ({}),
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

const requested: string[] = [];
const response = {
  value: [
    {
      codEnvio: "PQ1ES",
      eventos: [
        { desTextoResumen: "Prerregistrado", desFase: "PRE-ADMISIÓN" },
      ],
      error: { codError: "0", desError: "" },
    },
  ] as any,
};

vi.mock("axios", () => ({
  default: {
    get: async (url: string) => {
      requested.push(url);
      return { data: response.value };
    },
    post: async () => ({ status: 200, data: "" }),
  },
}));

async function readMovement(locator: string | null, carrier: string | null) {
  const { readCarrierMovement } = await import("@/actions/shipping");
  return readCarrierMovement(locator, carrier);
}

beforeEach(() => {
  requested.length = 0;
  response.value = [
    {
      codEnvio: "PQ1ES",
      eventos: [{ desTextoResumen: "Prerregistrado", desFase: "PRE-ADMISIÓN" }],
      error: { codError: "0", desError: "" },
    },
  ];
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
});

describe("readCarrierMovement on an international return", () => {
  it("never asks Correos about a UPS tracking number", async () => {
    // `1Z...` is Amphora's carrier_number, written by actions/amphoraReturn.ts.
    // Correos has no record of it and never will.
    expect(await readMovement("1Z999AA10123456784", "UPS")).toBe("not-moved");
    expect(requested).toHaveLength(0);
  });

  // Not "Correos Express": `tracksWithCorreos` matches any carrier name
  // containing "correos", because Amphora subcontracts Correos itself and
  // returns genuine Correos codes when it does. That is the dashboard's rule
  // too, and this gate deliberately reuses it rather than inventing a second
  // list of carrier names that could drift away from it.
  it.each(["DHL", "GLS", "SEUR", "UPS"])(
    "reports not-moved without a network call for %s",
    async (carrier) => {
      expect(await readMovement("XYZ123", carrier)).toBe("not-moved");
      expect(requested).toHaveLength(0);
    }
  );

  it("does not block on a missing Correos credential either", async () => {
    // The old code reached the credential check and answered "unreadable",
    // which blocks the cancellation. There is nothing to authenticate against.
    delete process.env.USERNAME_CORREOS;
    delete process.env.PASSWORD_CORREOS;

    expect(await readMovement("1Z999AA10123456784", "UPS")).toBe("not-moved");
    expect(requested).toHaveLength(0);
  });
});

describe("readCarrierMovement on a Spanish return", () => {
  it("still queries Correos when no carrier is recorded", async () => {
    // Domestic returns leave `carrier` null and store a Correos CodEnvio.
    expect(await readMovement("PQ1ES", null)).toBe("not-moved");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("localizador.correos.es");
    expect(requested[0]).toContain("PQ1ES");
  });

  it("still queries Correos when Amphora subcontracted Correos itself", async () => {
    // Amphora sets carrier="correos" for some destinations (order #310843),
    // with a genuine Correos code in `locator`.
    expect(await readMovement("PQ1ES", "correos")).toBe("not-moved");
    expect(requested).toHaveLength(1);
  });

  it("reports a parcel Correos has accepted as moved", async () => {
    response.value = [
      {
        codEnvio: "PQ1ES",
        eventos: [
          { desTextoResumen: "Prerregistrado", desFase: "PRE-ADMISIÓN" },
          { desTextoResumen: "Admitido.", desFase: "ADMISIÓN" },
        ],
        error: { codError: "0", desError: "" },
      },
    ];

    expect(await readMovement("PQ1ES", null)).toBe("moved");
  });

  it("reports unreadable when Correos holds no trace of the code", async () => {
    response.value = [
      { codEnvio: "PQ1ES", eventos: [], error: { codError: "3", desError: "Sin Trazabilidad" } },
    ];

    expect(await readMovement("PQ1ES", null)).toBe("unreadable");
  });

  it("reports unreadable when the Correos credentials are missing", async () => {
    delete process.env.USERNAME_CORREOS;
    delete process.env.PASSWORD_CORREOS;

    expect(await readMovement("PQ1ES", null)).toBe("unreadable");
    expect(requested).toHaveLength(0);
  });
});

describe("readCarrierMovement with no locator", () => {
  it("reports not-moved, whatever the carrier", async () => {
    // An international return Amphora has not assigned a carrier to has no
    // parcel in transit; a domestic one never got a label at all.
    expect(await readMovement(null, null)).toBe("not-moved");
    expect(await readMovement(null, "UPS")).toBe("not-moved");
    expect(requested).toHaveLength(0);
  });
});

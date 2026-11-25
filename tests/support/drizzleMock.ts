// The shape of @/db/drizzle for a test's vi.mock (F1 spec §11): the test's own
// handle as the read handle, and the SAME handle, with the test's `transact`,
// behind `writeDb(capability)` and `tableWriter(table)`. A test therefore
// exercises exactly the handle it built: a real PGlite / PostgreSQL 16 one
// (whose transact and readQuery are production's transactionsOver over that
// driver), or a fake chain.
//
// `module` is read lazily, so a mock whose `default` is a getter over a
// database started in beforeAll keeps working.
export function drizzleModule(module: { default: any; transact?: (s: any[]) => Promise<any[][]>; readQuery?: (s: any) => Promise<{ rows: any[] }> }) {
  const writable = () => {
    const handle = module.default;
    const transact = module.transact;
    if (!transact) return handle;
    return new Proxy(handle, {
      get: (target, key) => (key === "transact" ? transact : Reflect.get(target, key)),
    });
  };
  return {
    get default() {
      return module.default;
    },
    readQuery: (s: any) => (module.readQuery ? module.readQuery(s) : Promise.resolve({ rows: [] })),
    writeDb: (_capability: unknown) => writable(),
    tableWriter: (_table: unknown) => writable(),
  };
}

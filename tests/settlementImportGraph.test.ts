import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// S2 plan L7: nothing but the settlement ledger reaches `send`. Every export
// of a "use server" module is a public endpoint, so such a module must never
// hold a money mutation or import the module that sends them; and the
// mutation documents themselves live in exactly one file.

const ROOTS = ["app", "actions", "lib", "db", "scripts", "components"];
const SOURCE = /\.(ts|tsx)$/;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out = out.concat(walk(path));
    else if (SOURCE.test(entry)) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap(walk).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/** The module's first statement — after comments and blank lines — is the directive. */
function isUseServer(text: string): boolean {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"));
  return /^["']use server["'];?$/.test(code[0] ?? "");
}

const EFFECTS = `(@\\/lib\\/settlement\\/effects|\\.\\/effects|\\.\\.\\/settlement\\/effects)`;
const importsEffects = (_path: string, text: string) =>
  // `… from "x"`, a bare `import "x"`, and a dynamic `import("x")`.
  new RegExp(`(from|import)\\s*\\(?\\s*["']${EFFECTS}["']`).test(text);

// A mutation's field call, as written in a GraphQL document: `name(arg: $var`.
// draftOrderDelete included (finding 9): releasing a stock hold, by the
// ledger, a cancellation or a revert, has one document too.
const MONEY_MUTATION =
  /\b(returnProcess|refundCreate|giftCardCreate|orderCreate|returnRefund|returnClose|draftOrderDelete)\s*\(\s*\w+\s*:\s*\$/;

describe("settlement import graph", () => {
  it("finds the use-server modules it guards (sanity)", () => {
    expect(files.filter((f) => isUseServer(f.text)).map((f) => f.path)).toContain("actions/refund.ts");
  });

  it("no 'use server' module imports lib/settlement/effects.ts", () => {
    const bad = files.filter((f) => isUseServer(f.text) && importsEffects(f.path, f.text)).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it("no 'use server' module contains a money mutation", () => {
    const bad = files.filter((f) => isUseServer(f.text) && MONEY_MUTATION.test(f.text)).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it("only lib/settlement/* imports effects.ts", () => {
    const bad = files
      .filter((f) => importsEffects(f.path, f.text) && !f.path.startsWith("lib/settlement/"))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it("the money mutations are written in lib/settlement/effects.ts and nowhere else", () => {
    const holders = files.filter((f) => MONEY_MUTATION.test(f.text)).map((f) => f.path);
    expect(holders).toEqual(["lib/settlement/effects.ts"]);
  });

  it("effects.ts is server-only", () => {
    expect(readFileSync("lib/settlement/effects.ts", "utf8")).toMatch(/^import "server-only";$/m);
  });
});

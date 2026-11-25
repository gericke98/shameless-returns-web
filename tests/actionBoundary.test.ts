import { beforeAll, describe, expect, it } from "vitest";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// The server boundary, enforced structurally (F1 spec §Enforcement, rules 1–6,
// rule 6 as amended in §10). The TypeScript compiler API with the type
// checker: identities are resolved SYMBOLS (through import aliases), never
// text, so renaming an import or re-exporting a mint does not slip past.

const ROOT = resolve(__dirname, "..");
const rel = (file: string) => relative(ROOT, file).split("\\").join("/");

let program: ts.Program;
let checker: ts.TypeChecker;
let compilerOptions: ts.CompilerOptions;
let rootNames: readonly string[];
/** Our own source files: no tests, no declarations, no node_modules. */
let sources: ts.SourceFile[];

beforeAll(() => {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json")!;
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath));
  compilerOptions = { ...parsed.options, noEmit: true };
  rootNames = parsed.fileNames;
  program = ts.createProgram(rootNames, compilerOptions);
  checker = program.getTypeChecker();
  sources = program
    .getSourceFiles()
    .filter(
      (f) =>
        !f.isDeclarationFile &&
        !f.fileName.includes("/node_modules/") &&
        !rel(f.fileName).startsWith("tests/") &&
        !rel(f.fileName).startsWith("..")
    );
}, 120_000);

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** The declaration a name finally stands for, through any number of import/export aliases. */
function resolved(node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  while (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}
const declaredIn = (symbol: ts.Symbol | undefined) => {
  const decl = symbol?.declarations?.[0];
  return decl ? rel(decl.getSourceFile().fileName) : undefined;
};

const isDirective = (s: ts.Statement) =>
  ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use server";

/** Every `"use server"` directive in a file: at module level, or opening any function body. */
function useServerDirectives(file: ts.SourceFile): number {
  let count = 0;
  const leading = (statements: ts.NodeArray<ts.Statement>) => {
    for (const s of statements) {
      if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) break; // the prologue ends
      if (isDirective(s)) count += 1;
    }
  };
  leading(file.statements);
  walk(file, (n) => {
    if (ts.isFunctionLike(n) && "body" in n && n.body && ts.isBlock(n.body as ts.Node)) {
      leading((n.body as ts.Block).statements);
    }
  });
  return count;
}

const FACTORIES = ["customerAction", "adminAction", "publicAction", "publicFormAction"];

describe("rule 1: only actions/ declares server actions", () => {
  it("no file outside actions/ has a \"use server\" directive", () => {
    const offenders = sources
      .filter((f) => !rel(f.fileName).startsWith("actions/"))
      .filter((f) => useServerDirectives(f) > 0)
      .map((f) => rel(f.fileName));
    expect(offenders).toEqual([]);
  });
});

describe("rule 2: every action is a factory over an imported handler", () => {
  it("each actions/*.ts export is `export const X = factory(\"X\", schema, importedHandler)`", () => {
    const problems: string[] = [];
    const actionFiles = sources.filter((f) => rel(f.fileName).startsWith("actions/"));
    expect(actionFiles.length).toBeGreaterThan(0);

    for (const file of actionFiles) {
      const name = rel(file.fileName);
      if (!isDirective(file.statements[0])) problems.push(`${name}: first statement is not "use server"`);
      // Nothing in an action file may define a function: an inline function is its own endpoint.
      walk(file, (n) => {
        if (ts.isFunctionLike(n)) problems.push(`${name}:${line(file, n)}: defines a function`);
      });

      for (const s of file.statements.slice(1)) {
        if (ts.isImportDeclaration(s)) continue;
        if (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) continue;
        if (ts.isExportDeclaration(s) && s.isTypeOnly) continue;
        if (!ts.isVariableStatement(s)) {
          problems.push(`${name}:${line(file, s)}: only factory exports and types are allowed`);
          continue;
        }
        const exported = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) problems.push(`${name}:${line(file, s)}: a non-exported binding`);
        for (const d of s.declarationList.declarations) {
          const where = `${name}:${line(file, d)}`;
          const call = d.initializer;
          if (!ts.isIdentifier(d.name) || !call || !ts.isCallExpression(call)) {
            problems.push(`${where}: not \`const X = factory(…)\``);
            continue;
          }
          const factory = resolved(call.expression);
          if (declaredIn(factory) !== "lib/server/actions.ts" || !FACTORIES.includes(factory!.name)) {
            problems.push(`${where}: ${call.expression.getText()} is not an action factory`);
          }
          const [label, schema, handler, ...extra] = call.arguments;
          if (!label || !ts.isStringLiteral(label) || label.text !== d.name.text) {
            problems.push(`${where}: the name argument must be the literal "${d.name.text}"`);
          }
          if (!schema || !ts.isIdentifier(schema)) problems.push(`${where}: the schema must be an identifier`);
          if (!handler || !ts.isIdentifier(handler)) {
            problems.push(`${where}: the handler must be an imported identifier`);
          } else {
            const from = declaredIn(resolved(handler));
            if (!from?.startsWith("lib/server/handlers/")) {
              problems.push(`${where}: handler ${handler.text} resolves to ${from}, not lib/server/handlers/**`);
            }
          }
          if (extra.length) problems.push(`${where}: unexpected extra arguments`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("rule 3: lib/server is server-only", () => {
  it("every lib/server/** file starts with import \"server-only\"", () => {
    const offenders = sources
      .filter((f) => rel(f.fileName).startsWith("lib/server/"))
      .filter((f) => {
        const first = f.statements[0];
        return !(
          first &&
          ts.isImportDeclaration(first) &&
          !first.importClause &&
          ts.isStringLiteral(first.moduleSpecifier) &&
          first.moduleSpecifier.text === "server-only"
        );
      })
      .map((f) => rel(f.fileName));
    expect(offenders).toEqual([]);
  });
});

/** Mint → the only files that may reference it (spec §1 table; globs end in `/`). */
const MINT_CALLERS: Record<string, string[]> = {
  fromSession: ["lib/server/actions.ts"],
  verifiedByLookup: ["lib/server/handlers/lookup.ts"],
  verifiedByStripeSignature: ["app/api/webhooks/stripe/route.ts"],
  adminTarget: ["lib/server/handlers/admin/"],
  systemTarget: ["app/api/cron/", "lib/server/handlers/system/"],
  // The submission capability: minted only for a row the scope just read or inserted.
  boundSubmission: ["lib/server/submissionScope.ts"],
};
const allowed = (file: string, globs: string[]) =>
  globs.some((g) => (g.endsWith("/") ? file.startsWith(g) : file === g));

describe("rule 4: identities are minted only where the credential is", () => {
  it("nothing outside identity.ts asserts a Verified type", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      if (rel(file.fileName) === "lib/server/identity.ts") continue;
      walk(file, (n) => {
        if (!(ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n))) return;
        let named = false;
        walk(n.type, (t) => {
          if (ts.isTypeReferenceNode(t)) {
            const target = resolved(t.typeName);
            if (
              declaredIn(target) === "lib/server/identity.ts" &&
              ["VerifiedOrderId", "VerifiedSubmission"].includes(target!.name)
            ) {
              named = true;
            }
          }
        });
        if (named) offenders.push(`${rel(file.fileName)}:${line(file, n)}: ${n.getText()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("each mint is referenced only by its listed callers", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of sources) {
      const name = rel(file.fileName);
      if (name === "lib/server/identity.ts") continue;
      walk(file, (n) => {
        if (!ts.isIdentifier(n)) return;
        const target = resolved(n);
        if (declaredIn(target) !== "lib/server/identity.ts") return;
        const callers = MINT_CALLERS[target!.name];
        if (!callers) return; // a type, not a mint
        seen.add(target!.name);
        if (!allowed(name, callers)) offenders.push(`${target!.name} referenced from ${name}:${line(file, n)}`);
      });
    }
    expect(offenders).toEqual([]);
    // The table is not stale: every mint it lists is in use.
    expect(Array.from(seen).sort()).toEqual(Object.keys(MINT_CALLERS).sort());
  });

  it("identity.ts exports nothing but the mints and the two types", () => {
    const file = sources.find((f) => rel(f.fileName) === "lib/server/identity.ts")!;
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(file)!).map((s) => s.name).sort();
    expect(exports).toEqual([...Object.keys(MINT_CALLERS), "VerifiedOrderId", "VerifiedSubmission"].sort());
  });
});

describe("rule 5: the public factories serve exactly lookupOrder and setLocale", () => {
  it("publicAction/publicFormAction are called only for those two", () => {
    const uses: string[] = [];
    for (const file of sources) {
      walk(file, (n) => {
        if (!ts.isCallExpression(n)) return;
        const target = resolved(n.expression);
        if (declaredIn(target) !== "lib/server/actions.ts") return;
        if (target!.name !== "publicAction" && target!.name !== "publicFormAction") return;
        const label = n.arguments[0];
        uses.push(`${rel(file.fileName)} ${target!.name}(${label && ts.isStringLiteral(label) ? label.text : "?"})`);
      });
    }
    expect(uses.sort()).toEqual([
      "actions/locale.ts publicAction(setLocale)",
      "actions/order.ts publicFormAction(lookupOrder)",
    ]);
  });
});

function line(file: ts.SourceFile, node: ts.Node) {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

// ── Rule 6 (spec §10): customer handlers reach the database only through
// capabilities, checked PER FUNCTION along the call graph. ──────────────────

/**
 * Tables a customer-reachable function may write without a capability, each
 * because the row is not customer data keyed by an order:
 */
const NON_CUSTOMER_DATA: Record<string, string> = {
  // Ops' own alert outbox: a message to us, never read back into an order.
  ops_alerts: "internal alert outbox",
  // The lookup rate limiter: keyed by IP, written before any order is known.
  lookup_attempts: "rate-limit counter keyed by client IP",
};

const CAPABILITY_TYPES = new Set(["VerifiedOrderId", "VerifiedSubmission", "OrderScope"]);

/** Does a parameter's type carry a capability (directly, in an array, or as a field of a context object)? */
function carriesCapability(type: ts.Type, at: ts.Node, depth = 0): boolean {
  const named = type.aliasSymbol?.name ?? type.getSymbol()?.name;
  if (named && CAPABILITY_TYPES.has(named) && declaredIn(type.aliasSymbol ?? type.getSymbol()) === "lib/server/identity.ts") {
    return true;
  }
  if (type.isUnion() || type.isIntersection()) {
    if (type.types.some((t) => carriesCapability(t, at, depth))) return true;
  }
  if (checker.isArrayType(type)) {
    return carriesCapability(checker.getTypeArguments(type as ts.TypeReference)[0], at, depth);
  }
  if (depth >= 2 || !(type.flags & ts.TypeFlags.Object)) return false;
  return checker
    .getPropertiesOfType(type)
    .filter((p) => !p.name.startsWith("__@")) // the brand's own unique-symbol key
    .some((p) => carriesCapability(checker.getTypeOfSymbolAtLocation(p, at), at, depth + 1));
}

/** A function of OURS with a body (not a declaration file, not node_modules). */
function ours(decl: ts.Declaration | undefined): ts.SignatureDeclaration | undefined {
  if (!decl || !ts.isFunctionLike(decl)) return undefined;
  const file = decl.getSourceFile();
  if (file.isDeclarationFile || file.fileName.includes("/node_modules/")) return undefined;
  if (rel(file.fileName).startsWith("..")) return undefined;
  return (decl as ts.FunctionLikeDeclaration).body ? decl : undefined;
}

/**
 * The functions a VALUE may be, by its type: each call signature's
 * declaration. This follows any alias (`const save = writer`, a property
 * holding it, a re-export, a `cache(fn)` wrapper that returns `fn`'s type),
 * because the type checker, not the text, says what the value is.
 */
function functionsOfValue(node: ts.Node): ts.SignatureDeclaration[] {
  return checker
    .getTypeAtLocation(node)
    .getCallSignatures()
    .map((sig) => ours(sig.declaration))
    .filter((d): d is ts.SignatureDeclaration => !!d);
}

/** The declaration a call resolves to (overloads and aliases resolved by the checker). */
const resolvedCall = (call: ts.CallExpression) => checker.getResolvedSignature(call)?.declaration;

const nameOf = (fn: ts.SignatureDeclaration) => {
  const file = rel(fn.getSourceFile().fileName);
  const own = fn.name?.getText() ?? (ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent)
    ? fn.parent.name.getText()
    : fn.parent && ts.isCallExpression(fn.parent) && ts.isVariableDeclaration(fn.parent.parent)
      ? fn.parent.parent.name.getText()
      : "<anonymous>");
  return `${file}#${own}`;
};

/** The SQL table an expression names: follows local aliases to a `pgTable("name", …)` in db/schema.ts. */
function tableOf(node: ts.Expression): string | undefined {
  let decl = resolved(node)?.valueDeclaration;
  for (let hops = 0; decl && hops < 10; hops += 1) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    const init = decl.initializer;
    if (rel(decl.getSourceFile().fileName) === "db/schema.ts") {
      return ts.isCallExpression(init) && init.arguments[0] && ts.isStringLiteral(init.arguments[0])
        ? init.arguments[0].text
        : undefined;
    }
    if (!ts.isIdentifier(init) && !ts.isPropertyAccessExpression(init)) return undefined;
    decl = resolved(ts.isPropertyAccessExpression(init) ? init.name : init)?.valueDeclaration;
  }
  return undefined;
}

/** drizzle's own `PgDatabase.insert/update/delete/execute`, whatever value it is called on. */
function drizzleWrite(decl: ts.Declaration | undefined): string | undefined {
  if (!decl || !ts.isMethodDeclaration(decl) || !decl.getSourceFile().fileName.includes("/drizzle-orm/")) return undefined;
  const owner = decl.parent;
  if (!ts.isClassDeclaration(owner) || owner.name?.text !== "PgDatabase") return undefined;
  const method = decl.name.getText();
  return ["insert", "update", "delete", "execute"].includes(method) ? method : undefined;
}

/**
 * What a function writes, from its own body (nested callbacks included):
 * the tables of drizzle's `insert/update/delete(table)`, and `null` for a raw
 * write (`execute`, db/drizzle.ts `transact`) whose tables cannot be resolved.
 * Each call is identified by the declaration the type checker RESOLVES it to,
 * so an aliased database handle or an aliased `transact` is still a write.
 * A call through db/drizzle.ts `readQuery` is a READ (spec §10): it runs in a
 * Postgres READ ONLY transaction, so the database refuses any write in it.
 */
function writesOf(fn: ts.SignatureDeclaration): Array<string | null> {
  const out: Array<string | null> = [];
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return out;
  walk(body, (n) => {
    if (!ts.isCallExpression(n)) return;
    const decl = resolvedCall(n);
    const method = drizzleWrite(decl);
    if (method === "execute") out.push(null);
    else if (method) out.push(n.arguments[0] ? tableOf(n.arguments[0]) ?? null : null);
    else if (
      decl &&
      ts.isFunctionDeclaration(decl) &&
      decl.name?.text === "transact" &&
      rel(decl.getSourceFile().fileName) === "db/drizzle.ts"
    ) {
      out.push(null);
    }
  });
  return out;
}

/** True when the function, or a function it is nested in (its closure), takes a capability. */
function takesCapability(fn: ts.SignatureDeclaration): boolean {
  for (let node: ts.Node | undefined = fn; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      for (const p of node.parameters) {
        if (carriesCapability(checker.getTypeAtLocation(p), p)) return true;
      }
    }
  }
  return false;
}

/**
 * Every function of ours that `fn` calls (the declaration each call resolves
 * to) or hands on as a value (an argument whose type is one of our functions,
 * e.g. a `.map` callback).
 */
function calleesOf(fn: ts.SignatureDeclaration): ts.SignatureDeclaration[] {
  const out = new Set<ts.SignatureDeclaration>();
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return [];
  walk(body, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = ours(resolvedCall(n));
    if (callee) out.add(callee);
    for (const arg of n.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) continue; // inline: part of fn's own body
      for (const f of functionsOfValue(arg)) out.add(f);
    }
  });
  out.delete(fn);
  return Array.from(out);
}

/** Every reachable function that writes customer data without a capability, with its call chain. */
function uncapabilitatedWriters(roots: ts.SignatureDeclaration[]): string[] {
  const parent = new Map<ts.SignatureDeclaration, ts.SignatureDeclaration | null>();
  const queue = [...roots];
  for (const r of roots) parent.set(r, null);
  const offenders: string[] = [];
  while (queue.length) {
    const fn = queue.shift()!;
    const writes = writesOf(fn);
    const customerWrites = writes.filter((t) => t === null || !(t in NON_CUSTOMER_DATA));
    if (customerWrites.length && !takesCapability(fn)) {
      const chain: string[] = [];
      for (let f: ts.SignatureDeclaration | null | undefined = fn; f; f = parent.get(f)) chain.unshift(nameOf(f));
      const tables = Array.from(new Set(customerWrites.map((t) => t ?? "<raw SQL>"))).join(", ");
      offenders.push(`${chain.join(" -> ")} writes ${tables} without a capability`);
    }
    for (const callee of calleesOf(fn)) {
      if (parent.has(callee)) continue;
      parent.set(callee, fn);
      queue.push(callee);
    }
  }
  return offenders.sort();
}

/** The functions a module exports, by the type of each export (so aliases and wrappers resolve). */
function exportedFunctions(file: ts.SourceFile): ts.SignatureDeclaration[] {
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .flatMap((sym) =>
      checker
        .getTypeOfSymbolAtLocation(sym, file)
        .getCallSignatures()
        .map((sig) => ours(sig.declaration))
    )
    .filter((d): d is ts.SignatureDeclaration => !!d);
}

function customerHandlerRoots(): ts.SignatureDeclaration[] {
  return sources
    .filter((f) => rel(f.fileName).startsWith("lib/server/handlers/customer/"))
    .flatMap(exportedFunctions);
}

/**
 * Run `check` against the repo's program plus virtual `overlay` files (path →
 * source), with the module-level checker swapped for that program's. The
 * fixtures never touch the source tree.
 */
function withOverlay<T>(overlay: Record<string, string>, check: (files: ts.SourceFile[]) => T): T {
  const virtual = new Map(Object.entries(overlay).map(([p, text]) => [resolve(ROOT, p), text]));
  const host = ts.createCompilerHost(compilerOptions);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, lang, ...rest) =>
    virtual.has(f) ? ts.createSourceFile(f, virtual.get(f)!, lang, true) : getSourceFile.call(host, f, lang, ...rest);
  const fixtureProgram = ts.createProgram([...rootNames, ...Array.from(virtual.keys())], compilerOptions, host, program);
  const saved = checker;
  checker = fixtureProgram.getTypeChecker();
  try {
    return check(Array.from(virtual.keys()).map((f) => fixtureProgram.getSourceFile(f)!));
  } finally {
    checker = saved;
  }
}

const WRITER = `
import { eq } from "drizzle-orm";
import db, { transact } from "@/db/drizzle";
import { orders } from "@/db/schema";
import type { VerifiedOrderId } from "@/lib/server/identity";
export async function unbrandedWrite(id: string) {
  await db.update(orders).set({ locale: "es" }).where(eq(orders.id, id));
}
const handle = db;
const table = orders;
export async function writeThroughAliasedDb(id: string) {
  await handle.update(table).set({ locale: "es" }).where(eq(orders.id, id));
}
const run = transact;
export async function rawThroughAliasedTransact(id: string) {
  await run([]);
  void id;
}
export async function brandedWrite(id: VerifiedOrderId) {
  await db.update(orders).set({ locale: "es" }).where(eq(orders.id, id));
}
`;
const handler = (body: string) => `
import type { CustomerContext } from "@/lib/server/actions";
import { unbrandedWrite, writeThroughAliasedDb, rawThroughAliasedTransact, brandedWrite } from "@/lib/server/__rule6Writer";
void unbrandedWrite; void writeThroughAliasedDb; void rawThroughAliasedTransact; void brandedWrite;
${body}
`;
const fixtureOffenders = (body: string) =>
  withOverlay(
    {
      "lib/server/__rule6Writer.ts": WRITER,
      "lib/server/handlers/customer/__rule6.ts": handler(body),
    },
    ([, h]) => uncapabilitatedWriters(exportedFunctions(h))
  );
const H = "lib/server/handlers/customer/__rule6.ts";
const W = "lib/server/__rule6Writer.ts";

describe("rule 6: customer handlers write customer data only through capabilities", () => {
  it("finds the handlers it starts from, and walks into the order scope", () => {
    const roots = customerHandlerRoots();
    expect(roots.map(nameOf)).toEqual(
      expect.arrayContaining([
        "lib/server/handlers/customer/submitReturn.ts#submitReturnHandler",
        "lib/server/handlers/customer/cancelReturn.ts#cancelReturnHandler",
        "lib/server/handlers/customer/lines.ts#setLineSelectionHandler",
        "lib/server/handlers/customer/address.ts#saveAddressHandler",
        "lib/server/handlers/customer/submitTracking.ts#submitTrackingHandler",
      ])
    );
  });

  it("every reached function that writes customer data takes a VerifiedOrderId, VerifiedSubmission or OrderScope", () => {
    expect(uncapabilitatedWriters(customerHandlerRoots())).toEqual([]);
  });

  // Negative fixtures (Codex review, finding 2): virtual files compiled with
  // the real program, so the walk is exercised on code that must fail.
  it.each([
    [
      "a direct call",
      `export async function h(ctx: CustomerContext) { await unbrandedWrite(ctx.orderId); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through a local alias",
      `const save = unbrandedWrite;
       export async function h(ctx: CustomerContext) { await save(ctx.orderId); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through an object property",
      `const ops = { save: unbrandedWrite };
       export async function h(ctx: CustomerContext) { await ops.save(ctx.orderId); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a function handed on as a callback",
      `export async function h(ctx: CustomerContext) { await Promise.all([ctx.orderId].map(unbrandedWrite)); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "an aliased database handle and table",
      `export async function h(ctx: CustomerContext) { await writeThroughAliasedDb(ctx.orderId); }`,
      `${H}#h -> ${W}#writeThroughAliasedDb writes orders without a capability`,
    ],
    [
      "an aliased transact",
      `export async function h(ctx: CustomerContext) { await rawThroughAliasedTransact(ctx.orderId); }`,
      `${H}#h -> ${W}#rawThroughAliasedTransact writes <raw SQL> without a capability`,
    ],
  ])("fails %s to an unbranded writer, naming the chain", (_label, body, expected) => {
    expect(fixtureOffenders(body)).toEqual([expected]);
  }, 60_000);

  it("passes the same handler calling a branded writer (the control)", () => {
    expect(
      fixtureOffenders(`export async function h(ctx: CustomerContext) { await brandedWrite(ctx.orderId); }`)
    ).toEqual([]);
  }, 60_000);
});

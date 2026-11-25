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
  indexStores();
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

/** Declared outside our source (a library, the DOM, Node, a .d.ts): not ours to walk. */
function isExternal(decl: ts.Declaration): boolean {
  const file = decl.getSourceFile();
  return file.isDeclarationFile || file.fileName.includes("/node_modules/") || rel(file.fileName).startsWith("..");
}

/** A function of OURS with a body. */
function ours(decl: ts.Node | undefined): ts.SignatureDeclaration | undefined {
  if (!decl || !ts.isFunctionLike(decl) || isExternal(decl as ts.Declaration)) return undefined;
  return (decl as ts.FunctionLikeDeclaration).body ? decl : undefined;
}

const where = (node: ts.Node) => {
  const file = node.getSourceFile();
  return `${rel(file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};

/** The value symbol a name finally stands for, through import/export aliases. */
function valueSymbol(node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  while (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol && symbol.flags & ts.SymbolFlags.Value ? symbol : undefined;
}

const inDrizzle = (symbol: ts.Symbol, name: string) =>
  symbol.name === name && !!symbol.declarations?.some((d) => rel(d.getSourceFile().fileName) === "db/drizzle.ts");
/** db/drizzle.ts `transact`: raw SQL, tables unknown. */
const isTransact = (symbol: ts.Symbol) => inDrizzle(symbol, "transact");
/** db/drizzle.ts's database handle. */
const isDbHandle = (symbol: ts.Symbol) => inDrizzle(symbol, "db");

/** drizzle's own `PgDatabase.insert/update/delete/execute`, whatever handle it is called on. */
function drizzleWrite(decl: ts.Declaration | undefined): string | undefined {
  if (!decl || !ts.isMethodDeclaration(decl) || !decl.getSourceFile().fileName.includes("/drizzle-orm/")) return undefined;
  const owner = decl.parent;
  if (!ts.isClassDeclaration(owner) || owner.name?.text !== "PgDatabase") return undefined;
  const method = decl.name.getText();
  return ["insert", "update", "delete", "execute"].includes(method) ? method : undefined;
}

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

/** Is `node` a name being declared (not a reference to a value)? */
function isDeclarationName(node: ts.Node): boolean {
  const p = node.parent;
  return !!p && (p as any).name === node && (ts.isDeclarationStatement(p) || ts.isVariableDeclaration(p) ||
    ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertySignature(p) ||
    ts.isMethodDeclaration(p) || ts.isBindingElement(p) || ts.isFunctionExpression(p) || ts.isClassExpression(p) ||
    ts.isEnumMember(p));
  // A shorthand `{ save }` is NOT a declaration name here: it references the value `save`.
}

/**
 * What one reference hands the code that holds it. Reachability is by
 * REFERENCE, not by resolving calls: a function can only run if its value
 * was reached from running code, whatever the static type says (an
 * annotation, an interface, `any`). So a reference to:
 * - one of our functions makes it reachable;
 * - a class of ours makes every method and member function reachable;
 * - a variable or property of ours hands over everything its initializer and
 *   every assignment to it anywhere in the program hold (`stores`);
 * - db/drizzle.ts `transact`, or the database handle used other than as the
 *   receiver of a drizzle method, is a raw write by the holder.
 * Parameters hand over nothing new: their values are references in the
 * caller, which is itself reachable.
 */
type Holdings = { fns: Set<ts.SignatureDeclaration>; raw: boolean };

let stores: Map<ts.Symbol, ts.Expression[]>;
let escapes: string[];
const holdingsMemo = new Map<ts.Symbol, Holdings>();

/** Program-wide: everything written into each symbol, and every write of ours into a place with no symbol. */
function indexStores() {
  stores = new Map();
  escapes = [];
  holdingsMemo.clear();
  const add = (sym: ts.Symbol | undefined, value: ts.Expression, at: ts.Node) => {
    if (sym) stores.set(sym, [...(stores.get(sym) ?? []), value]);
    else {
      if (holdsValue(value)) escapes.push(`${where(at)} stores \`${value.getText().slice(0, 50)}\` where no symbol can find it`);
    }
  };
  // The app's own modules: not tests, not scripts/ (separate processes, never
  // loaded by the server).
  for (const file of program.getSourceFiles()) {
    const path = rel(file.fileName);
    if (file.isDeclarationFile || file.fileName.includes("/node_modules/") || path.startsWith("..")) continue;
    if (path.startsWith("tests/") || path.startsWith("scripts/")) continue;
    walk(file, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const lhs = n.left;
        const target = ts.isIdentifier(lhs)
          ? valueSymbol(lhs)
          : ts.isPropertyAccessExpression(lhs)
            ? valueSymbol(lhs.name)
            : ts.isElementAccessExpression(lhs)
              ? valueSymbol(ts.isPropertyAccessExpression(lhs.expression) ? lhs.expression.name : lhs.expression)
              : undefined;
        add(target, n.right, n);
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        // A method call can store its arguments in its receiver (`m.set(k, f)`, `a.push(f)`):
        // whatever is handed to it, the receiver may hold.
        const receiver = n.expression.expression;
        const sym = valueSymbol(ts.isPropertyAccessExpression(receiver) ? receiver.name : receiver);
        for (const arg of n.arguments) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) continue;
          if (!holdsValue(arg)) continue;
          if (sym) stores.set(sym, [...(stores.get(sym) ?? []), arg]);
          else if (checker.getTypeAtLocation(receiver).flags & ts.TypeFlags.Any) {
            escapes.push(`${where(n)} hands \`${arg.getText().slice(0, 50)}\` to an untyped receiver`);
          }
        }
      }
    });
  }
}

const isCallee = (n: ts.Node) => {
  const p = n.parent;
  if (ts.isCallExpression(p) && p.expression === n) return true;
  return ts.isPropertyAccessExpression(p) && p.name === n && ts.isCallExpression(p.parent) && p.parent.expression === p;
};

/**
 * Does the VALUE of `expr` carry one of our functions or raw SQL? An inline
 * function, or a reference outside callee position that holds one (a call's
 * callee hands over its result, which the callee's own body accounts for).
 */
function holdsValue(expr: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ours(n)) {
      found = true;
      return;
    }
    if (!isCallee(n)) {
      const h = holdingsOfReference(n, new Set());
      if (h.fns.size || h.raw) {
        found = true;
        return;
      }
    }
    n.forEachChild(visit);
  };
  visit(expr);
  return found;
}

/** What a symbol, once referenced, hands its holder. */
function holdingsOfSymbol(symbol: ts.Symbol, seen: Set<ts.Symbol>): Holdings {
  const memo = holdingsMemo.get(symbol);
  if (memo) return memo;
  const out: Holdings = { fns: new Set(), raw: false };
  if (seen.has(symbol)) return out;
  seen.add(symbol);
  const decls = symbol.declarations ?? [];
  if (isTransact(symbol)) out.raw = true;
  else if (decls.every((d) => isExternal(d))) {
    // a library's value: nothing of ours in it
  } else {
    for (const d of decls) {
      const fn = ours(d);
      if (fn) out.fns.add(fn);
      else if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) {
        for (const m of d.members) merge(out, holdingsOfNode(m, seen));
      } else if (
        (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) &&
        d.initializer
      ) {
        merge(out, holdingsOfNode(d.initializer, seen));
      } else if (ts.isShorthandPropertyAssignment(d)) {
        const v = checker.getShorthandAssignmentValueSymbol(d);
        if (v) merge(out, holdingsOfSymbol(v, seen));
      } else if (ts.isExportAssignment(d)) {
        merge(out, holdingsOfNode(d.expression, seen));
      }
    }
    for (const v of stores.get(symbol) ?? []) merge(out, holdingsOfNode(v, seen));
  }
  seen.delete(symbol);
  if (seen.size === 0) holdingsMemo.set(symbol, out);
  return out;
}

function merge(into: Holdings, from: Holdings) {
  from.fns.forEach((f) => into.fns.add(f));
  into.raw ||= from.raw;
}

/** What evaluating an expression (or a class member) can hand over: inline functions, and every reference in it. */
function holdingsOfNode(node: ts.Node, seen: Set<ts.Symbol>): Holdings {
  const out: Holdings = { fns: new Set(), raw: false };
  const visit = (n: ts.Node) => {
    const fn = ours(n);
    if (fn) {
      out.fns.add(fn); // its body is walked when it is reached, not here
      return;
    }
    merge(out, holdingsOfReference(n, seen));
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

/** What one node hands over if it is a reference to a value. */
function holdingsOfReference(n: ts.Node, seen: Set<ts.Symbol>): Holdings {
  const none: Holdings = { fns: new Set(), raw: false };
  if (!ts.isIdentifier(n) && !ts.isPrivateIdentifier(n)) return none;
  if (isDeclarationName(n)) return none;
  const symbol = valueSymbol(n);
  if (!symbol) return none;
  if (isDbHandle(symbol)) {
    // The handle as the receiver of a drizzle method is judged by that
    // method (writesOf); anywhere else it escapes, and may write anything.
    const p = n.parent;
    const receiver = ts.isPropertyAccessExpression(p) && p.expression === n;
    return { fns: new Set(), raw: !receiver };
  }
  return holdingsOfSymbol(symbol, seen);
}

/**
 * What a function writes, from its own body (nested callbacks included): the
 * tables of drizzle's `insert/update/delete(table)` on any handle (by the
 * method the checker resolves), `null` for raw SQL (`execute`, and any
 * reference that hands over db/drizzle.ts `transact` or the bare handle).
 * A call through db/drizzle.ts `readQuery` is a READ (spec §10): it runs in a
 * Postgres READ ONLY transaction, so the database refuses any write in it.
 */
function writesOf(fn: ts.SignatureDeclaration): Array<string | null> {
  const out: Array<string | null> = [];
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return out;
  walk(body, (n) => {
    if (ts.isCallExpression(n)) {
      const method = drizzleWrite(checker.getResolvedSignature(n)?.declaration);
      if (method === "execute") out.push(null);
      else if (method) out.push(n.arguments[0] ? tableOf(n.arguments[0]) ?? null : null);
    }
    if (holdingsOfReference(n, new Set()).raw) out.push(null);
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

/** Every function of ours that `fn`'s body hands to running code, by reference. */
function calleesOf(fn: ts.SignatureDeclaration): ts.SignatureDeclaration[] {
  const out = new Set<ts.SignatureDeclaration>();
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return [];
  // Nested functions are part of fn's body (walked here); references in them count.
  walk(body, (n) => holdingsOfReference(n, new Set()).fns.forEach((f) => out.add(f)));
  out.delete(fn);
  // A nested function of fn is fn itself.
  return Array.from(out).filter((f) => !isWithin(f, fn));
}
const isWithin = (inner: ts.Node, outer: ts.Node) => {
  for (let n: ts.Node | undefined = inner.parent; n; n = n.parent) if (n === outer) return true;
  return false;
};

/** A root: a function to start from, or an export whose implementation cannot be found. */
type Root = ts.SignatureDeclaration | { unresolved: string };

/**
 * Every reachable function that writes customer data without a capability,
 * with its chain; and every place in the program that stores one of our
 * functions (or raw SQL) where no symbol can find it (the walk fails closed).
 */
function uncapabilitatedWriters(roots: Root[]): string[] {
  const parent = new Map<ts.SignatureDeclaration, ts.SignatureDeclaration | null>();
  const offenders: string[] = [...escapes];
  const queue: ts.SignatureDeclaration[] = [];
  for (const r of roots) {
    if ("unresolved" in r) offenders.push(`${r.unresolved} is exported, but its implementation cannot be found`);
    else if (!parent.has(r)) {
      parent.set(r, null);
      queue.push(r);
    }
  }
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

/** Every exported VALUE of a module that holds a function, typed or not, by what it holds. */
function exportedFunctions(file: ts.SourceFile): Root[] {
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (!moduleSymbol) return [];
  const roots: Root[] = [];
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    let value = sym;
    while (value.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    if (!(value.flags & ts.SymbolFlags.Value)) continue; // a type
    const held = holdingsOfSymbol(value, new Set());
    held.fns.forEach((f) => roots.push(f));
    if (!held.fns.size && checker.getTypeOfSymbolAtLocation(value, file).getCallSignatures().length) {
      roots.push({ unresolved: `${rel(file.fileName)}#${sym.name}` });
    }
  }
  return roots;
}

function customerHandlerRoots(): Root[] {
  return sources
    .filter((f) => rel(f.fileName).startsWith("lib/server/handlers/customer/"))
    .flatMap(exportedFunctions);
}

const nameOf = (fn: ts.SignatureDeclaration) => {
  const file = rel(fn.getSourceFile().fileName);
  const own = fn.name?.getText() ?? (ts.isVariableDeclaration(fn.parent) || ts.isPropertyAssignment(fn.parent)
    ? fn.parent.name.getText()
    : fn.parent && ts.isCallExpression(fn.parent) && ts.isVariableDeclaration(fn.parent.parent)
      ? fn.parent.parent.name.getText()
      : "<anonymous>");
  return `${file}#${own}`;
};

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
  const saved = { program, checker, stores, escapes };
  program = fixtureProgram;
  checker = fixtureProgram.getTypeChecker();
  indexStores();
  try {
    return check(Array.from(virtual.keys()).map((f) => fixtureProgram.getSourceFile(f)!));
  } finally {
    ({ program, checker, stores, escapes } = saved);
    holdingsMemo.clear();
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
    expect(roots.map((r) => ("unresolved" in r ? r.unresolved : nameOf(r)))).toEqual(
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
      // The handle used other than as a drizzle receiver (aliased) is opaque: raw.
      `${H}#h -> ${W}#writeThroughAliasedDb writes orders, <raw SQL> without a capability`,
    ],
    [
      "an aliased transact",
      `export async function h(ctx: CustomerContext) { await rawThroughAliasedTransact(ctx.orderId); }`,
      `${H}#h -> ${W}#rawThroughAliasedTransact writes <raw SQL> without a capability`,
    ],
    // Codex fix-check, finding 2: annotations must not hide an implementation.
    [
      "a call through an explicitly typed const alias",
      `const save: (id: string) => Promise<void> = unbrandedWrite;
       export async function h(ctx: CustomerContext) { await save(ctx.orderId); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through a typed arrow wrapper",
      `const wrap: (id: string) => Promise<void> = async (id) => { await unbrandedWrite(id); };
       export async function h(ctx: CustomerContext) { await wrap(ctx.orderId); }`,
      `${H}#h -> ${H}#wrap -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a typed exported handler",
      `export const h: (ctx: CustomerContext) => Promise<void> = async (ctx) => { await unbrandedWrite(ctx.orderId); };`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through a cast that lies about the type",
      `const save = unbrandedWrite as unknown as typeof brandedWrite;
       export async function h(ctx: CustomerContext) { await save(ctx.orderId as never); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through an interface-typed dependency",
      `type Deps = { save(id: string): Promise<void> };
       async function run(deps: Deps, id: string) { await deps.save(id); }
       export async function h(ctx: CustomerContext) { await run({ save: unbrandedWrite }, ctx.orderId); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through a typed lookup table",
      `const LOOKUP: Record<string, (id: string) => Promise<void>> = { a: unbrandedWrite };
       export async function h(ctx: CustomerContext) { await LOOKUP["a"](ctx.orderId); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through a registry filled elsewhere",
      `const registry = new Map<string, (id: string) => Promise<void>>();
       function register() { registry.set("x", unbrandedWrite); }
       void register;
       export async function h(ctx: CustomerContext) { await registry.get("x")!(ctx.orderId); }`,
      `${H}#h -> ${W}#unbrandedWrite writes orders without a capability`,
    ],
    [
      "a call through an untyped global (fails closed at the store)",
      `(globalThis as any).save = unbrandedWrite;
       export async function h(ctx: CustomerContext) { await (globalThis as any).save(ctx.orderId); }`,
      `${H}:5 stores \`unbrandedWrite\` where no symbol can find it`,
    ],
    [
      "an exported handler with no implementation (fails closed)",
      `export declare const h: (ctx: CustomerContext) => Promise<void>;`,
      `${H}#h is exported, but its implementation cannot be found`,
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

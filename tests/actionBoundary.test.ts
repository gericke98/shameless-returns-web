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
  // Handlers never mint (spec §11 threat model): the admin factory mints from the session.
  adminTarget: ["lib/server/actions.ts"],
  systemTarget: ["app/api/cron/", "scripts/"],
  verifiedByAmphoraSecret: ["app/api/webhooks/amphora/route.ts"],
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
              ["VerifiedOrderId", "VerifiedSubmission", "AdminTarget", "SystemTarget", "WriteCapability"].includes(target!.name)
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

  it("identity.ts exports nothing but the mints and the capability types", () => {
    const file = sources.find((f) => rel(f.fileName) === "lib/server/identity.ts")!;
    const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(file)!).map((s) => s.name).sort();
    expect(exports).toEqual(
      [...Object.keys(MINT_CALLERS), "VerifiedOrderId", "VerifiedSubmission", "AdminTarget", "SystemTarget", "WriteCapability"].sort()
    );
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

// ── Rule 6 (spec §11): writing is a capability, enforced by the TYPE of the
// database handle. db/drizzle.ts exports a read handle; the write handle comes
// only from writeDb(capability) or, for the two non-customer tables,
// their table-bound writers. There is nothing left to analyse: tsc refuses a write
// without a capability anywhere in the program. ────────────────────────────

describe("rule 6: a write handle needs a capability", () => {
  it("the type tests hold: every @ts-expect-error in tests/writeCapability.typecheck.ts is still an error", () => {
    const file = program.getSourceFile(resolve(ROOT, "tests/writeCapability.typecheck.ts"));
    expect(file, "tests/writeCapability.typecheck.ts must be in the program").toBeDefined();
    const diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
      (d) => `${line(file!, { getStart: () => d.start ?? 0 } as any)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`
    );
    expect(diagnostics).toEqual([]);
  });

  it("each table-bound writer is referenced only from its own table's module", () => {
    const from: Record<string, Set<string>> = { opsAlertsWriter: new Set(), lookupAttemptsWriter: new Set() };
    for (const file of sources) {
      const name = rel(file.fileName);
      if (name === "db/drizzle.ts") continue;
      walk(file, (n) => {
        if (!ts.isIdentifier(n)) return;
        const target = resolved(n);
        if (target && target.name in from && declaredIn(target) === "db/drizzle.ts") from[target.name].add(name);
      });
    }
    expect({
      opsAlertsWriter: Array.from(from.opsAlertsWriter),
      lookupAttemptsWriter: Array.from(from.lookupAttemptsWriter),
    }).toEqual({ opsAlertsWriter: ["db/opsAlerts.ts"], lookupAttemptsWriter: ["db/lookupAttempts.ts"] });
  });

  it("nothing outside scripts/ and tests/ imports from scripts/ (scripts may mint systemTarget)", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const name = rel(file.fileName);
      if (name.startsWith("scripts/")) continue;
      walk(file, (n) => {
        let specifier: ts.Expression | undefined;
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) specifier = n.moduleSpecifier;
        else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = n.arguments[0];
        else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) specifier = n.argument.literal as ts.Expression;
        if (!specifier) return;
        if (!ts.isStringLiteralLike(specifier)) {
          offenders.push(`${name}:${line(file, n)}: a computed import`);
          return;
        }
        const target = ts.resolveModuleName(specifier.text, file.fileName, compilerOptions, ts.sys).resolvedModule;
        if (target && rel(target.resolvedFileName).startsWith("scripts/")) {
          offenders.push(`${name}:${line(file, n)} imports ${specifier.text}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

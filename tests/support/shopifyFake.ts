// A fake Shopify Admin GraphQL endpoint for adapter tests: it answers a query
// from a fixture with ONLY the fields the query selects (aliases included),
// the way GraphQL does. So a reader that forgets to select a field gets it
// back missing, exactly as in production, instead of a fixture hiding it.
//
// It understands the subset our queries use: one operation, nested selection
// sets, `alias: field`, arguments (ignored; the fixture is already the
// answer), and `#` comments. It is not a GraphQL implementation.

type Token = string;

function tokenize(query: string): Token[] {
  const text = query.replace(/#[^\n]*/g, "");
  return text.match(/"(?:[^"\\]|\\.)*"|\$?[A-Za-z_][A-Za-z0-9_]*|[{}():!,=\[\]]|-?\d+/g) ?? [];
}

type Field = { key: string; name: string; selection?: Field[] };

function parse(tokens: Token[]): Field[] {
  let i = 0;
  const skipParens = () => {
    let depth = 0;
    do {
      if (tokens[i] === "(") depth += 1;
      if (tokens[i] === ")") depth -= 1;
      i += 1;
    } while (depth > 0 && i < tokens.length);
  };
  const selectionSet = (): Field[] => {
    const fields: Field[] = [];
    i += 1; // "{"
    while (i < tokens.length && tokens[i] !== "}") {
      let key = tokens[i++];
      let name = key;
      if (tokens[i] === ":") {
        name = tokens[i + 1];
        i += 2;
      }
      if (tokens[i] === "(") skipParens();
      const field: Field = { key, name };
      if (tokens[i] === "{") field.selection = selectionSet();
      fields.push(field);
    }
    i += 1; // "}"
    return fields;
  };
  // Skip the operation header (`query name($id: ID!)`) up to its selection set.
  while (i < tokens.length && tokens[i] !== "{") {
    if (tokens[i] === "(") skipParens();
    else i += 1;
  }
  return selectionSet();
}

function project(value: any, selection: Field[] | undefined): any {
  if (value === null || value === undefined || !selection) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, selection));
  const out: Record<string, unknown> = {};
  for (const f of selection) {
    if (f.name in value) out[f.key] = project(value[f.name], f.selection);
  }
  return out;
}

/** The `data` a GraphQL server would return for `query` over `root`. */
export function answerQuery(query: string, root: Record<string, unknown>) {
  return project(root, parse(tokenize(query)));
}

/** A `fetch` stand-in for the Admin API: `{ data }` projected from `root`. */
export function fakeShopifyFetch(root: Record<string, unknown>) {
  return async (_url: unknown, init?: { body?: string }) => {
    const { query } = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ data: answerQuery(query, root) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

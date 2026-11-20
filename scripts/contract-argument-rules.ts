/**
 * Argument schema rules the contract tooling enforces
 * (docs/architecture/version-compatibility.md, "Schema rules").
 *
 * The manifest and the release snapshots keep each command's arguments as a
 * JSON Schema export (`Schema.toJsonSchemaDocument`), and the contract CI job
 * generates fixtures from an older release's export to decode with the
 * current parser (`scripts/contract-ci-schemas.ts`). Two Effect constructs
 * export a value their own decoder refuses, so a fixture built from them is
 * evidence of nothing:
 *
 * - `Schema.Number` exports `anyOf [number, "Infinity" | "-Infinity" | "NaN"]`.
 *   The string branch is the encoding Effect's JSON serializer would use; the
 *   decode the registry runs (`decodeCommandArgs`) refuses those strings, and
 *   JSON cannot carry a non-finite number at all. {@link withoutNonFiniteNumberBranch}
 *   removes that branch before fixtures are generated, which is exact.
 * - `Schema.optional(T)` (and `Schema.UndefinedOr(T)`) exports
 *   `anyOf [T, null]`, the same export as `Schema.optionalKey(Schema.NullOr(T))`,
 *   but refuses `null`. The stored schema cannot tell the two apart, so
 *   {@link argumentSchemaProblems} refuses `undefined` in a command's arguments
 *   when the manifest is generated: every `anyOf [T, null]` an argument schema
 *   exports then really accepts `null`.
 *
 * {@link argumentSchemaProblems} also refuses `Schema.Number`, so new
 * arguments use `Schema.Finite` as the rules ask.
 *
 * No `effect` import: the repository root does not depend on it, so the AST is
 * read by its `_tag`s.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

const NON_FINITE_NUMBER_STRINGS = ["Infinity", "-Infinity", "NaN"] as const;

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The branch `Schema.Number` adds to its export for non-finite numbers:
 * exactly `{ type: "string", enum: ["Infinity", "-Infinity", "NaN"] }`.
 */
export function isNonFiniteNumberBranch(node: Json | undefined): boolean {
  if (!isObject(node)) return false;
  const keys = Object.keys(node);
  if (keys.length !== 2 || node.type !== "string") return false;
  const values = node.enum;
  return (
    Array.isArray(values) &&
    values.length === NON_FINITE_NUMBER_STRINGS.length &&
    NON_FINITE_NUMBER_STRINGS.every((value, index) => values[index] === value)
  );
}

/** Whether `node` is `Schema.Number`'s export: `anyOf` a number and the non-finite strings. */
function isNumberWithNonFiniteBranch(node: JsonObject): boolean {
  const anyOf = node.anyOf;
  return (
    Array.isArray(anyOf) &&
    anyOf.some(isNonFiniteNumberBranch) &&
    anyOf.some((branch) => isObject(branch) && branch.type === "number")
  );
}

/**
 * `node` without `Schema.Number`'s non-finite string branch. Only an `anyOf`
 * that also has a `{ type: "number" }` branch is rewritten; a lone remaining
 * branch replaces the `anyOf` when the node has no other keys.
 */
export function withoutNonFiniteNumberBranch<T extends JsonObject>(node: T): T | JsonObject {
  if (!isNumberWithNonFiniteBranch(node)) return node;
  const kept = (node.anyOf as readonly Json[]).filter((branch) => !isNonFiniteNumberBranch(branch));
  const { anyOf: _anyOf, ...rest } = node;
  if (kept.length === 1 && Object.keys(rest).length === 0) return kept[0] as JsonObject;
  return { ...rest, anyOf: kept };
}

/** Paths, from the root of `schema`, of every `Schema.Number` export in it. */
export function nonFiniteNumberPaths(schema: Json, path = "", depth = 0): string[] {
  if (depth > 64) return [];
  if (Array.isArray(schema)) {
    return schema.flatMap((child, index) =>
      nonFiniteNumberPaths(child, `${path}[${index}]`, depth + 1),
    );
  }
  if (!isObject(schema)) return [];
  const found = isNumberWithNonFiniteBranch(schema) ? [path] : [];
  for (const [key, child] of Object.entries(schema)) {
    if (key === "anyOf" && found.length > 0) continue;
    found.push(...nonFiniteNumberPaths(child, `${path}/${key}`, depth + 1));
  }
  return found;
}

/** The part of an Effect `SchemaAST.AST` node this module reads. */
interface AstNode {
  readonly _tag: string;
  readonly types?: readonly AstNode[];
  readonly elements?: readonly AstNode[];
  readonly rest?: readonly AstNode[];
  readonly propertySignatures?: readonly { readonly name: PropertyKey; readonly type: AstNode }[];
  readonly indexSignatures?: readonly { readonly type: AstNode }[];
  readonly typeParameters?: readonly AstNode[];
  readonly thunk?: () => AstNode;
}

/** Paths, as `.key` and `[]` steps, where `ast` admits `undefined` (`Schema.optional`, `UndefinedOr`). */
export function undefinedMemberPaths(ast: AstNode): string[] {
  const found = new Set<string>();
  // Only a `Suspend` can close a cycle. Leaves such as `Undefined` are shared
  // singletons, and a shared sub-schema is reported at every path it is used.
  const suspended = new Set<AstNode>();
  const walk = (node: AstNode | undefined, path: string, depth: number): void => {
    if (node === undefined || depth > 64) return;
    if (node._tag === "Undefined") found.add(path || "(root)");
    if (node._tag === "Suspend" && node.thunk) {
      if (suspended.has(node)) return;
      suspended.add(node);
      walk(node.thunk(), path, depth + 1);
    }
    for (const child of node.types ?? []) walk(child, path, depth + 1);
    for (const child of node.typeParameters ?? []) walk(child, path, depth + 1);
    for (const child of [...(node.elements ?? []), ...(node.rest ?? [])]) {
      walk(child, `${path}[]`, depth + 1);
    }
    for (const signature of node.propertySignatures ?? []) {
      walk(signature.type, `${path}.${String(signature.name)}`, depth + 1);
    }
    for (const signature of node.indexSignatures ?? [])
      walk(signature.type, `${path}{}`, depth + 1);
  };
  walk(ast, "", 0);
  return [...found].sort();
}

/**
 * Every rule a command's argument schema breaks, as manifest problems.
 * `exported` is its JSON Schema export (`canonicalJsonSchema(def.args)`, parsed).
 */
export function argumentSchemaProblems(
  command: string,
  args: { readonly ast: unknown },
  exported: { readonly schema: Json; readonly definitions?: Json },
): string[] {
  const problems: string[] = [];
  const undefinedPaths = undefinedMemberPaths(args.ast as AstNode);
  if (undefinedPaths.length > 0) {
    problems.push(
      `${command} arguments admit undefined at ${undefinedPaths.join(", ")}: use Schema.optionalKey(...) (or optionalKey(Schema.NullOr(...)) where null must be accepted). Schema.optional exports anyOf [T, null] but refuses null.`,
    );
  }
  const numberPaths = [
    ...nonFiniteNumberPaths(exported.schema, "#"),
    ...nonFiniteNumberPaths(exported.definitions ?? null, "#/definitions"),
  ];
  if (numberPaths.length > 0) {
    problems.push(
      `${command} arguments use Schema.Number at ${numberPaths.join(", ")}: use Schema.Finite (or Schema.Int). Schema.Number exports "Infinity", "-Infinity" and "NaN" strings its decoder refuses.`,
    );
  }
  return problems;
}

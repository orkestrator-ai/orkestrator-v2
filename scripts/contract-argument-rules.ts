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
 *   JSON cannot carry a non-finite number at all. The fixture importer handles
 *   the two known mis-exported pagination fields by their release digest.
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

interface AstCheck {
  readonly annotations?: { readonly representation?: { readonly id?: string } };
  readonly checks?: readonly AstCheck[];
}

function hasFiniteWireCheck(checks: readonly AstCheck[]): boolean {
  return checks.some((check) => {
    const id = check.annotations?.representation?.id;
    return (
      id === "effect/schema/isFinite" ||
      id === "effect/schema/isInt" ||
      hasFiniteWireCheck(check.checks ?? [])
    );
  });
}

/** The part of an Effect `SchemaAST.AST` node this module reads. */
interface AstNode {
  readonly _tag: string;
  readonly checks?: readonly AstCheck[];
  readonly encoding?: readonly { readonly to: AstNode }[];
  readonly types?: readonly AstNode[];
  readonly elements?: readonly AstNode[];
  readonly rest?: readonly AstNode[];
  readonly propertySignatures?: readonly { readonly name: PropertyKey; readonly type: AstNode }[];
  readonly indexSignatures?: readonly { readonly type: AstNode }[];
  readonly typeParameters?: readonly AstNode[];
  readonly thunk?: () => AstNode;
}

/** Walk the wire AST, ignoring annotations and stopping at recursive edges. */
function argumentMemberPaths(ast: AstNode) {
  const undefinedPaths = new Set<string>();
  const numberPaths = new Set<string>();
  const ancestors = new Set<AstNode>();
  const walk = (node: AstNode, path: string): void => {
    if (ancestors.has(node)) return;
    ancestors.add(node);
    const encoded = node.encoding?.at(-1)?.to;
    if (encoded) {
      walk(encoded, path);
    } else {
      if (node._tag === "Undefined") undefinedPaths.add(path || "(root)");
      if (node._tag === "Number" && !hasFiniteWireCheck(node.checks ?? [])) {
        numberPaths.add(path || "(root)");
      }
      if (node.thunk) walk(node.thunk(), path);
      for (const child of node.types ?? []) walk(child, path);
      for (const child of node.typeParameters ?? []) walk(child, path);
      for (const child of [...(node.elements ?? []), ...(node.rest ?? [])]) {
        walk(child, `${path}[]`);
      }
      for (const signature of node.propertySignatures ?? []) {
        walk(signature.type, `${path}.${String(signature.name)}`);
      }
      for (const signature of node.indexSignatures ?? []) walk(signature.type, `${path}{}`);
    }
    ancestors.delete(node);
  };
  walk(ast, "");
  return {
    undefinedPaths: [...undefinedPaths].sort(),
    numberPaths: [...numberPaths].sort(),
  };
}

/** Every rule a command's argument schema breaks, as manifest problems. */
export function argumentSchemaProblems(command: string, args: { readonly ast: unknown }): string[] {
  const problems: string[] = [];
  const { undefinedPaths, numberPaths } = argumentMemberPaths(args.ast as AstNode);
  if (undefinedPaths.length > 0) {
    problems.push(
      `${command} arguments admit undefined at ${undefinedPaths.join(", ")}: use Schema.optionalKey(...) (or optionalKey(Schema.NullOr(...)) where null must be accepted). Schema.optional exports anyOf [T, null] but refuses null.`,
    );
  }
  if (numberPaths.length > 0) {
    problems.push(
      `${command} arguments use Schema.Number at ${numberPaths.join(", ")}: use Schema.Finite (or Schema.Int). Schema.Number exports "Infinity", "-Infinity" and "NaN" strings its decoder refuses.`,
    );
  }
  return problems;
}

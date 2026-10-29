import { FieldErrorCollector, type FieldError } from "@orkestrator/protocol/field-validation";
import {
  checkArtifactTypeDef,
  type ArtifactTypeDef,
  type GraphJsonSchema,
} from "@orkestrator/protocol/graphs/artifact-type-def";
import type { GraphNodeSpec, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { isGraphBuiltInTypeName } from "@orkestrator/protocol/graphs/types";
import { uniqueGraphId } from "./graph-designer-edits";

/**
 * Pure helpers for the designer's custom-type editor (item 212, report
 * §5.3): a fresh type, renaming a type reference everywhere a port names it,
 * and the live issues of one type (the template guard's own check, plus
 * conflicts with built-ins and the template's other types).
 */

/** Issues listed per type; the rest are counted. */
export const GRAPH_TYPE_EDITOR_MAX_ISSUES = 50;

export function graphTypeRef(def: Pick<ArtifactTypeDef, "name" | "version">): string {
  return `${def.name}@${def.version}`;
}

/** A small, valid custom type under a free name. */
export function blankGraphCustomType(taken: readonly string[]): ArtifactTypeDef {
  return {
    name: uniqueGraphId("custom-type", taken),
    version: 1,
    schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
    storage: "value",
    budgets: { maxBytes: 65_536, maxStringBytes: 16_384, maxItems: 100 },
    example: { summary: "…" },
  };
}

/** `ref` with its `list<…>` wrappers replaced when the inner reference is `from`. */
function renameRef(ref: string, from: string, to: string): string {
  let depth = 0;
  let inner = ref;
  while (inner.startsWith("list<") && inner.endsWith(">")) {
    inner = inner.slice(5, -1);
    depth++;
  }
  if (inner !== from) return ref;
  return `${"list<".repeat(depth)}${to}${">".repeat(depth)}`;
}

function renamePorts<P extends { type: string }>(ports: P[] | undefined, from: string, to: string) {
  if (!ports) return { ports, changed: false };
  let changed = false;
  const next = ports.map((port) => {
    const type = renameRef(port.type, from, to);
    if (type === port.type) return port;
    changed = true;
    return { ...port, type };
  });
  return { ports: changed ? next : ports, changed };
}

/** Rewrites every port, run input and run output that names `fromRef` (also inside `list<…>`). */
export function renameGraphTypeRef(
  template: GraphTemplateV1,
  fromRef: string,
  toRef: string,
): GraphTemplateV1 {
  if (fromRef === toRef) return template;
  const nodes = template.nodes.map((node) => {
    const inputs = renamePorts(node.inputs, fromRef, toRef);
    const outputs = "outputs" in node ? renamePorts(node.outputs, fromRef, toRef) : undefined;
    if (!inputs.changed && !outputs?.changed) return node;
    return {
      ...node,
      ...(inputs.changed ? { inputs: inputs.ports } : {}),
      ...(outputs?.changed ? { outputs: outputs.ports } : {}),
    } as GraphNodeSpec;
  });
  const inputs = renamePorts(template.inputs, fromRef, toRef);
  const outputs = renamePorts(template.outputs, fromRef, toRef);
  return {
    ...template,
    nodes,
    inputs: inputs.ports ?? template.inputs,
    ...(template.outputs ? { outputs: outputs.ports } : {}),
  };
}

/** Where a type is used: `node.port`, `run input x`, `run output y`. */
export function graphTypeUses(template: GraphTemplateV1, ref: string): string[] {
  const uses: string[] = [];
  const named = (type: string) => renameRef(type, ref, "\u0000") !== type;
  for (const node of template.nodes) {
    for (const port of node.inputs ?? [])
      if (named(port.type)) uses.push(`${node.id}.${port.name}`);
    if ("outputs" in node) {
      for (const port of node.outputs ?? []) {
        if (named(port.type)) uses.push(`${node.id}.${port.name}`);
      }
    }
  }
  for (const input of template.inputs) if (named(input.type)) uses.push(`run input ${input.name}`);
  for (const output of template.outputs ?? []) {
    if (named(output.type)) uses.push(`run output ${output.name}`);
  }
  return uses;
}

/**
 * The type's problems as the template guard reports them (schema subset,
 * budgets, field paths, the example against the schema), with paths from
 * the type itself, plus a reference another custom type already uses.
 */
export function graphCustomTypeIssues(
  def: ArtifactTypeDef,
  template: Pick<GraphTemplateV1, "types">,
): { issues: FieldError[]; omitted: number } {
  const errors = new FieldErrorCollector(GRAPH_TYPE_EDITOR_MAX_ISSUES);
  if (isGraphBuiltInTypeName(def.name)) {
    errors.add("name", "built_in_type", `"${def.name}" is a built-in type; choose another name`);
  }
  const ref = graphTypeRef(def);
  const same = (template.types ?? []).filter((entry) => graphTypeRef(entry) === ref);
  if (same.length > 1) {
    errors.add("name", "duplicate", `Another custom type is already ${ref}`);
  }
  const guard = new FieldErrorCollector(GRAPH_TYPE_EDITOR_MAX_ISSUES);
  checkArtifactTypeDef(def, "", guard);
  for (const error of guard.errors) {
    // The built-in clash is reported once, above.
    if (error.code === "built_in_type") continue;
    errors.add(error.path, error.code, error.message);
  }
  return { issues: errors.errors, omitted: errors.omitted + guard.omitted };
}

/** Dotted paths of array fields (outside arrays), for `items.path`. */
export function graphSchemaArrayPaths(schema: GraphJsonSchema): string[] {
  return graphSchemaFieldPaths(schema)
    .filter((entry) => entry.type === "array")
    .map((entry) => entry.path);
}

/** Dotted paths of every field reachable without entering arrays, with its type. */
export function graphSchemaFieldPaths(
  schema: GraphJsonSchema,
  prefix = "",
  depth = 0,
): Array<{ path: string; type: string }> {
  if (depth > 10) return [];
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const paths: Array<{ path: string; type: string }> = [];
  for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const inner = nonNullSchema(child as GraphJsonSchema);
    const path = prefix ? `${prefix}.${name}` : name;
    const type = typeof inner.type === "string" ? inner.type : "unknown";
    paths.push({ path, type });
    if (type === "object") paths.push(...graphSchemaFieldPaths(inner, path, depth + 1));
  }
  return paths;
}

/** The non-null branch of a nullable `anyOf`, or the schema itself. */
export function nonNullSchema(schema: GraphJsonSchema): GraphJsonSchema {
  if (!Array.isArray(schema.anyOf)) return schema;
  const branches = schema.anyOf.filter(
    (branch) =>
      !(branch && typeof branch === "object" && (branch as GraphJsonSchema).type === "null"),
  );
  return branches.length === 1 && branches[0] && typeof branches[0] === "object"
    ? (branches[0] as GraphJsonSchema)
    : schema;
}

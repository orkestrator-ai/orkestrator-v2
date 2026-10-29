/**
 * "Schema from example" (plan P1.2): draft a subset schema from a sample value.
 *
 * The designer's type editor starts here, so the draft must already be inside
 * the portable subset and must accept the example it came from. Inference is
 * deliberately plain: every field becomes required, numbers that are all
 * integers become `integer`, a field seen as null somewhere becomes nullable,
 * and arrays merge their elements into one item schema. Where the sample does
 * not say enough (an empty array, a field that is only ever null) the draft
 * guesses `string` and says so in `notes`, so the author can correct it.
 */
import {
  FieldErrorCollector,
  type FieldError,
  isPlainRecord,
  joinPath,
} from "../field-validation.js";
import type { GraphJsonSchema } from "./artifact-type-def.js";
import { GRAPH_PATH_SEGMENT_PATTERN, GRAPH_TEMPLATE_BOUNDS, checkBoundedJson } from "./grammar.js";
import {
  GRAPH_SCHEMA_SUBSET_BOUNDS,
  checkGraphSchemaSubset,
  validateGraphSchemaValue,
} from "./schema-subset.js";

type Primitive = "string" | "integer" | "number" | "boolean";

/** What the sample says about one position. `unknown` comes from empty arrays. */
type Shape =
  | { kind: Primitive }
  | { kind: "null" }
  | { kind: "unknown" }
  | { kind: "object"; properties: Map<string, Shape> }
  | { kind: "array"; items: Shape }
  | { kind: "union"; members: Shape[] };

export interface GraphSchemaDraft {
  schema: GraphJsonSchema;
  /** Guesses the author should check, with the JSON path they concern. */
  notes: Array<{ path: string; message: string }>;
}

export type GraphSchemaDraftResult =
  | { ok: true; value: GraphSchemaDraft }
  | { ok: false; errors: FieldError[]; omittedErrors: number };

class DraftError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function infer(value: unknown, path: string, objectDepth: number): Shape {
  if (value === null) return { kind: "null" };
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "number")
    return { kind: Number.isSafeInteger(value) ? "integer" : "number" };
  if (Array.isArray(value)) {
    let items: Shape = { kind: "unknown" };
    value.forEach((entry, index) => {
      items = merge(items, infer(entry, joinPath(path, index), objectDepth), `${path}[]`);
    });
    return { kind: "array", items };
  }
  if (isPlainRecord(value)) {
    if (objectDepth >= GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth) {
      throw new DraftError(
        path,
        "too_deep",
        `Objects may be nested at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth} deep`,
      );
    }
    const properties = new Map<string, Shape>();
    for (const [key, entry] of Object.entries(value)) {
      if (key.length > GRAPH_TEMPLATE_BOUNDS.maxKeyChars || !GRAPH_PATH_SEGMENT_PATTERN.test(key)) {
        throw new DraftError(
          joinPath(path, key),
          "pattern",
          "Field names must be letters, digits, '_' or '-', starting with a letter or '_'",
        );
      }
      properties.set(key, infer(entry, joinPath(path, key), objectDepth + 1));
    }
    if (properties.size > GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesPerObject) {
      throw new DraftError(
        path,
        "too_many",
        `An object may have at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesPerObject} fields`,
      );
    }
    return { kind: "object", properties };
  }
  throw new DraftError(path, "not_json", "The example must be JSON");
}

function members(shape: Shape): Shape[] {
  return shape.kind === "union" ? shape.members : [shape];
}

function sameKind(left: Shape, right: Shape): boolean {
  const numeric = (shape: Shape) => shape.kind === "integer" || shape.kind === "number";
  return left.kind === right.kind || (numeric(left) && numeric(right));
}

/** One shape that accepts everything either shape accepts. */
function merge(left: Shape, right: Shape, path: string): Shape {
  if (left.kind === "unknown") return right;
  if (right.kind === "unknown") return left;
  if (left.kind !== "union" && right.kind !== "union" && sameKind(left, right)) {
    if (left.kind === "object" && right.kind === "object") {
      const leftKeys = [...left.properties.keys()];
      const rightKeys = [...right.properties.keys()];
      const missing = [
        ...leftKeys.filter((key) => !right.properties.has(key)),
        ...rightKeys.filter((key) => !left.properties.has(key)),
      ];
      if (missing.length > 0) {
        throw new DraftError(
          path,
          "inconsistent_fields",
          `Elements disagree on fields (${missing.slice(0, 5).join(", ")}); every field is required, so give every element the same fields and use null for a missing value`,
        );
      }
      const properties = new Map<string, Shape>();
      for (const key of leftKeys) {
        properties.set(
          key,
          merge(left.properties.get(key)!, right.properties.get(key)!, joinPath(path, key)),
        );
      }
      return { kind: "object", properties };
    }
    if (left.kind === "array" && right.kind === "array") {
      return { kind: "array", items: merge(left.items, right.items, `${path}[]`) };
    }
    if (left.kind === "number" || right.kind === "number") return { kind: "number" };
    return left;
  }
  const result: Shape[] = [];
  for (const member of [...members(left), ...members(right)]) {
    const index = result.findIndex((existing) => sameKind(existing, member));
    if (index === -1) result.push(member);
    else result[index] = merge(result[index]!, member, path);
  }
  if (result.length === 1) return result[0]!;
  if (result.length > GRAPH_SCHEMA_SUBSET_BOUNDS.maxAnyOfBranches) {
    throw new DraftError(path, "too_many", "Values at this position have too many different types");
  }
  return { kind: "union", members: result };
}

function emit(shape: Shape, path: string, notes: GraphSchemaDraft["notes"]): GraphJsonSchema {
  switch (shape.kind) {
    case "unknown":
      notes.push({ path, message: "No sample value; guessed string" });
      return { type: "string" };
    case "null":
      notes.push({ path, message: "Only null in the sample; guessed a nullable string" });
      return { anyOf: [{ type: "string" }, { type: "null" }] };
    case "object": {
      const properties: Record<string, GraphJsonSchema> = {};
      for (const [key, child] of shape.properties) {
        properties[key] = emit(child, joinPath(path, key), notes);
      }
      return {
        type: "object",
        properties,
        required: [...shape.properties.keys()],
        additionalProperties: false,
      };
    }
    case "array":
      return { type: "array", items: emit(shape.items, `${path}[]`, notes) };
    case "union": {
      // The subset forbids nested anyOf, so a null member joins the branch list.
      const branches = shape.members
        .filter((member) => member.kind !== "null")
        .map((member) => emit(member, path, notes));
      if (shape.members.some((member) => member.kind === "null")) branches.push({ type: "null" });
      return { anyOf: branches };
    }
    default:
      return { type: shape.kind };
  }
}

/**
 * Draft a subset schema from `example`, which must be a JSON object. The
 * result passes the subset checker and accepts `example`.
 */
export function draftGraphSchemaFromExample(example: unknown): GraphSchemaDraftResult {
  const errors = new FieldErrorCollector(50);
  if (
    !checkBoundedJson(example, "$", errors, {
      maxBytes: GRAPH_TEMPLATE_BOUNDS.maxTypeExampleBytes,
      maxDepth: GRAPH_TEMPLATE_BOUNDS.maxTypeSchemaDepth,
      requireObject: true,
    })
  ) {
    return { ok: false, errors: errors.errors, omittedErrors: errors.omitted };
  }
  const notes: GraphSchemaDraft["notes"] = [];
  let schema: GraphJsonSchema;
  try {
    schema = emit(infer(example, "$", 0), "$", notes);
  } catch (error) {
    if (!(error instanceof DraftError)) throw error;
    errors.add(error.path, error.code, error.message);
    return { ok: false, errors: errors.errors, omittedErrors: errors.omitted };
  }
  // The draft must be usable as it stands: inside the subset (size, property
  // and enum totals included) and satisfied by its own example.
  if (!checkGraphSchemaSubset(schema, "$", errors)) {
    return { ok: false, errors: errors.errors, omittedErrors: errors.omitted };
  }
  const issues = validateGraphSchemaValue(schema, example);
  if (issues.length > 0) {
    for (const issue of issues) errors.add(issue.path, issue.code, issue.message);
    return { ok: false, errors: errors.errors, omittedErrors: errors.omitted };
  }
  return { ok: true, value: { schema, notes: notes.slice(0, 50) } };
}

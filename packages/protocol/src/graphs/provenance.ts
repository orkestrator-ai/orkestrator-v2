/**
 * Provenance of a consolidating node's output (plan P1.3, report §5.9, D11).
 *
 * A node that merges `list<T>` must say what it did with each source item. Its
 * output type marks the arrays of source IDs with `x-orkestrator-sources`
 * (`schema-subset.ts` records them), and the port declares a mode:
 *
 * - `cite`: every ID the output cites names an item of the node's inputs;
 * - `accountForAll`: additionally, every source item is cited somewhere or
 *   listed in the output's top-level `dropped` list with a reason. A type
 *   without that list must cite every source.
 *
 * {@link validateGraphProvenance} is the submit-time check. It is today's
 * Multi Review consolidation check (`validateConsolidationContext` in the
 * backend) without the review types: that check now runs through it with
 * {@link GraphProvenanceField} rules and wording of its own, and produces the
 * same diagnostics it always did.
 *
 * Pure and bounded, so the backend, mock runs and the designer agree.
 */
import { isPlainRecord } from "../field-validation.js";
import type { WorkflowResultValidationIssue } from "../workflow-results.js";
import type { GraphJsonSchema } from "./artifact-type-def.js";
import type { GraphSchemaSourcesField } from "./schema-subset.js";
import { validateGraphSchemaSubset } from "./schema-subset.js";
import type { GraphProvenanceMode } from "./template-model.js";

/** The top-level list where an `accountForAll` output names what it dropped. */
export const GRAPH_PROVENANCE_DROPPED_FIELD = "dropped";

/** Bounds on a provenance plan and the sources it checks against. */
export const GRAPH_PROVENANCE_BOUNDS = Object.freeze({
  /** Source items one check knows about; the consolidation context's bound. */
  maxSources: 4_096,
  maxSourceIdChars: 256,
  maxSourceClassChars: 64,
  /** `x-orkestrator-sources` fields per schema (`GRAPH_SCHEMA_SUBSET_BOUNDS`). */
  maxFields: 16,
  maxSegments: 32,
  maxDerivedFields: 8,
  maxMinCitations: 64,
  /** Issues one check reports, the workflow-result cap. */
  maxIssues: 32,
});

/** One provenance field and the rules for the IDs it holds. */
export interface GraphProvenanceField {
  /** Property names from the root, `[]` for each element of an array. */
  segments: string[];
  /** Every cited ID must name a source of this class (`issue`, `finding@1`). Any class when absent. */
  sourceClass?: string;
  /** Each object holding the field must cite at least this many sources (default 0). */
  minCitations?: number;
  /**
   * Sibling fields the backend derives from the citations. A model that fills
   * one in is told to cite instead (review: `reviewModels`).
   */
  derivedFields?: string[];
}

export interface GraphProvenancePlan {
  mode: GraphProvenanceMode;
  fields: GraphProvenanceField[];
  /**
   * `accountForAll` only: the top-level list of `{ id, reason }` naming the
   * sources the output leaves out. Absent when the type has no such list; then
   * every source must be cited.
   */
  droppedField?: string;
}

/**
 * Text that differs per caller. Not part of the plan (which is persisted):
 * a caller passes it in-process. The defaults read naturally for any graph.
 */
export interface GraphProvenanceWording {
  /** One output entry holding a provenance field: "entry". */
  item?: string;
  /** One source item, as in "cite at least one source ID": "source". */
  sourceItem?: string;
  /** Where the sources come from: "the node's inputs". */
  inputs?: string;
  /** Message per derived field; default "Cite source IDs; the backend derives <field>." */
  derived?: Readonly<Record<string, string>>;
}

/** Source item ID → class. Built from the node's input artifacts by the runtime. */
export type GraphProvenanceSources = Readonly<Record<string, string>>;

/** Any non-array object, as the workflow-result contracts read values. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

function sourceClassOf(sources: GraphProvenanceSources, id: unknown): string | undefined {
  return typeof id === "string" && Object.hasOwn(sources, id) ? sources[id] : undefined;
}

function citationRequirement(count: number, wording: Required<GraphProvenanceWording>): string {
  return count === 1
    ? `Every ${wording.item} must cite at least one ${wording.sourceItem} ID.`
    : `Every ${wording.item} must cite at least ${count} ${wording.sourceItem} IDs.`;
}

/**
 * Checks a value's citations against the sources its node received. Issues
 * come in field order, then element order, and stop at
 * `GRAPH_PROVENANCE_BOUNDS.maxIssues`. A value that is not an object yields
 * nothing: the schema check reports it.
 */
export function validateGraphProvenance(
  value: unknown,
  plan: GraphProvenancePlan,
  sources: GraphProvenanceSources,
  wording: GraphProvenanceWording = {},
): WorkflowResultValidationIssue[] {
  if (!record(value)) return [];
  const words: Required<GraphProvenanceWording> = {
    item: wording.item ?? "entry",
    sourceItem: wording.sourceItem ?? "source",
    inputs: wording.inputs ?? "the node's inputs",
    derived: wording.derived ?? {},
  };
  const max = GRAPH_PROVENANCE_BOUNDS.maxIssues;
  const issues: WorkflowResultValidationIssue[] = [];
  const cited = new Set<string>();

  const inspectHolder = (
    holder: Record<string, unknown>,
    path: string,
    field: GraphProvenanceField,
    name: string,
  ): void => {
    for (const derived of field.derivedFields ?? []) {
      const candidate = holder[derived];
      if (Array.isArray(candidate) && candidate.length > 0) {
        issues.push(
          issue(
            `${path}.${derived}`,
            "invalid_value",
            words.derived[derived] ?? `Cite source IDs; the backend derives ${derived}.`,
          ),
        );
      }
    }
    const ids = holder[name];
    const minimum = field.minCitations ?? 0;
    if (!Array.isArray(ids) || ids.length < minimum) {
      if (minimum > 0) {
        issues.push(issue(`${path}.${name}`, "missing_field", citationRequirement(minimum, words)));
      }
      return;
    }
    ids.forEach((id, index) => {
      const known = sourceClassOf(sources, id);
      if (known === undefined || (field.sourceClass !== undefined && known !== field.sourceClass)) {
        issues.push(
          issue(
            `${path}.${name}[${index}]`,
            "invalid_value",
            field.sourceClass === undefined
              ? `The source does not identify an item in ${words.inputs}.`
              : `The source does not identify a ${field.sourceClass} in ${words.inputs}.`,
          ),
        );
        return;
      }
      cited.add(id as string);
    });
  };

  const walk = (node: unknown, path: string, field: GraphProvenanceField, index: number): void => {
    if (issues.length >= max) return;
    const segment = field.segments[index]!;
    if (index === field.segments.length - 1) {
      if (record(node)) inspectHolder(node, path, field, segment);
      return;
    }
    if (segment === "[]") {
      if (!Array.isArray(node)) return;
      node.forEach((entry, position) => walk(entry, `${path}[${position}]`, field, index + 1));
      return;
    }
    if (!record(node)) return;
    walk(node[segment], `${path}.${segment}`, field, index + 1);
  };

  for (const field of plan.fields) {
    if (field.segments.length === 0 || field.segments.at(-1) === "[]") continue;
    walk(value, "$", field, 0);
  }

  if (plan.mode === "accountForAll") {
    const dropped = new Set<string>();
    const droppedField = plan.droppedField;
    const listed = droppedField === undefined ? undefined : value[droppedField];
    if (droppedField !== undefined && Array.isArray(listed)) {
      listed.forEach((entry, index) => {
        const path = `$.${droppedField}[${index}]`;
        if (!record(entry)) return;
        const id = entry.id;
        if (sourceClassOf(sources, id) === undefined) {
          issues.push(
            issue(
              `${path}.id`,
              "invalid_value",
              `The dropped source does not identify an item in ${words.inputs}.`,
            ),
          );
        } else if (dropped.has(id as string)) {
          issues.push(issue(`${path}.id`, "duplicate", "List each dropped source once."));
        } else if (cited.has(id as string)) {
          issues.push(
            issue(`${path}.id`, "conflict", "A source that is cited cannot also be dropped."),
          );
        } else {
          dropped.add(id as string);
        }
        if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
          issues.push(issue(`${path}.reason`, "missing_field", "Say why the source was dropped."));
        }
      });
    }
    for (const id of Object.keys(sources)) {
      if (issues.length >= max) break;
      if (cited.has(id) || dropped.has(id)) continue;
      issues.push(
        droppedField === undefined
          ? issue("$", "unaccounted_source", `Cite source ${id}; every source must be cited.`)
          : issue(
              `$.${droppedField}`,
              "unaccounted_source",
              `Cite source ${id}, or list it in ${droppedField} with a reason.`,
            ),
      );
    }
  }
  return issues.slice(0, max);
}

/** The schema of an `accountForAll` output's `dropped` list. */
export function graphProvenanceDroppedSchema(): GraphJsonSchema {
  return {
    type: "array",
    description: "Source IDs this output leaves out, each with the reason.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "reason"],
      properties: {
        id: { type: "string", description: "The source ID." },
        reason: { type: "string", description: "Why the source was left out." },
      },
    },
  };
}

function isDroppedListSchema(schema: unknown): boolean {
  if (!isPlainRecord(schema) || schema.type !== "array" || !isPlainRecord(schema.items))
    return false;
  const items = schema.items;
  const properties = items.properties;
  return (
    items.type === "object" &&
    isPlainRecord(properties) &&
    isPlainRecord(properties.id) &&
    properties.id.type === "string" &&
    isPlainRecord(properties.reason) &&
    properties.reason.type === "string" &&
    Array.isArray(items.required) &&
    items.required.includes("id") &&
    items.required.includes("reason")
  );
}

/**
 * The plan for an output port: its schema's `x-orkestrator-sources` fields
 * under `mode`, with the `dropped` list when the schema has one. `sourceFields`
 * overrides the fields read from the schema (built-in types list theirs in the
 * type library). Null when the schema is outside the subset.
 */
export function graphProvenancePlanForSchema(
  mode: GraphProvenanceMode,
  schema: GraphJsonSchema,
  sourceFields?: readonly GraphSchemaSourcesField[],
): GraphProvenancePlan | null {
  let fields = sourceFields;
  if (!fields) {
    const subset = validateGraphSchemaSubset(schema);
    if (!subset.ok) return null;
    fields = subset.value.sources;
  }
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const hasDropped =
    mode === "accountForAll" &&
    Object.hasOwn(properties, GRAPH_PROVENANCE_DROPPED_FIELD) &&
    isDroppedListSchema(properties[GRAPH_PROVENANCE_DROPPED_FIELD]);
  return {
    mode,
    fields: fields.map((field) => ({ segments: [...field.segments] })),
    ...(hasDropped ? { droppedField: GRAPH_PROVENANCE_DROPPED_FIELD } : {}),
  };
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Structural guard for a persisted plan; a message naming the problem, or null. */
export function graphProvenancePlanProblem(value: unknown): string | null {
  const B = GRAPH_PROVENANCE_BOUNDS;
  if (!isPlainRecord(value)) return "provenance must be an object";
  if (value.mode !== "cite" && value.mode !== "accountForAll")
    return "provenance.mode must be cite or accountForAll";
  if (
    value.droppedField !== undefined &&
    (value.mode !== "accountForAll" || !boundedText(value.droppedField, 48))
  )
    return "provenance.droppedField is invalid";
  if (!Array.isArray(value.fields) || value.fields.length > B.maxFields)
    return "provenance.fields must be a bounded list";
  for (const field of value.fields) {
    if (!isPlainRecord(field)) return "a provenance field must be an object";
    const segments = field.segments;
    if (
      !Array.isArray(segments) ||
      segments.length === 0 ||
      segments.length > B.maxSegments ||
      !segments.every((segment) => boundedText(segment, 64)) ||
      segments.at(-1) === "[]"
    )
      return "a provenance field needs segments ending in a property name";
    if (field.sourceClass !== undefined && !boundedText(field.sourceClass, B.maxSourceClassChars))
      return "a provenance sourceClass is invalid";
    if (
      field.minCitations !== undefined &&
      (!Number.isSafeInteger(field.minCitations) ||
        (field.minCitations as number) < 0 ||
        (field.minCitations as number) > B.maxMinCitations)
    )
      return "a provenance minCitations is invalid";
    if (
      field.derivedFields !== undefined &&
      (!Array.isArray(field.derivedFields) ||
        field.derivedFields.length > B.maxDerivedFields ||
        !field.derivedFields.every((name) => boundedText(name, 64)))
    )
      return "a provenance derivedFields list is invalid";
  }
  return null;
}

/** Structural guard for a persisted source map; a message naming the problem, or null. */
export function graphProvenanceSourcesProblem(value: unknown): string | null {
  const B = GRAPH_PROVENANCE_BOUNDS;
  if (!isPlainRecord(value)) return "sources must be an object";
  const entries = Object.entries(value);
  if (entries.length > B.maxSources) return `at most ${B.maxSources} sources`;
  for (const [id, sourceClass] of entries) {
    if (id.length === 0 || id.length > B.maxSourceIdChars) return "a source ID is invalid";
    if (!boundedText(sourceClass, B.maxSourceClassChars)) return "a source class is invalid";
  }
  return null;
}

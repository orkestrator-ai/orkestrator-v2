/**
 * Result slots for graph output ports (plan P1.3, report §5.5).
 *
 * When an agent activation is dispatched, the runtime opens one workflow
 * result slot of kind `graph-output` per output port. The slot carries the
 * port's own submission tool, `submit_<port>`, and the port's type, so the
 * model sees one meaningful tool per output (`submit_brief`,
 * `validate_brief`) instead of a generic one. This module holds the tool-name
 * grammar and the slot's trusted context; the backend's result-kind registry
 * validates values against it.
 *
 * Port names follow the template key grammar (`GRAPH_KEY_PATTERN`, at most 48
 * characters), so `submit_<port>` is at most 55 characters and fits every
 * provider's tool-name limit (64, `[A-Za-z0-9_-]`). A port whose tool names
 * would collide with a built-in workflow result tool is reserved.
 */
import { isPlainRecord } from "../field-validation.js";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  type WorkflowResultKind,
  workflowResultToolName,
} from "../workflow-results.js";
import type { ArtifactStorageClass, ArtifactTypeBudgets } from "./artifact-type-def.js";
import {
  GRAPH_KEY_PATTERN,
  GRAPH_TEMPLATE_BOUNDS,
  graphUtf8Bytes,
  parseGraphTypeRef,
} from "./grammar.js";
import {
  type GraphProvenancePlan,
  type GraphProvenanceSources,
  graphProvenancePlanProblem,
  graphProvenanceSourcesProblem,
} from "./provenance.js";

export const GRAPH_OUTPUT_SUBMIT_TOOL_PREFIX = "submit_";
export const GRAPH_OUTPUT_VALIDATE_TOOL_PREFIX = "validate_";

/**
 * Port names whose `submit_`/`validate_` tools would shadow a built-in
 * workflow result tool: every kind's own suffix, and `workflow_result`
 * (`validate_workflow_result`).
 */
export const GRAPH_OUTPUT_RESERVED_PORTS: readonly string[] = Object.freeze([
  ...WORKFLOW_RESULT_KINDS.map((kind) =>
    workflowResultToolName(kind).slice(GRAPH_OUTPUT_SUBMIT_TOOL_PREFIX.length),
  ),
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME.slice(GRAPH_OUTPUT_VALIDATE_TOOL_PREFIX.length),
]);

export type GraphOutputPortProblem = "pattern" | "too_long" | "reserved";

/** Why `port` cannot name a result tool, or null when it can. */
export function graphOutputPortProblem(port: unknown): GraphOutputPortProblem | null {
  if (typeof port !== "string" || !GRAPH_KEY_PATTERN.test(port)) return "pattern";
  if (port.length > GRAPH_TEMPLATE_BOUNDS.maxKeyChars) return "too_long";
  if (GRAPH_OUTPUT_RESERVED_PORTS.includes(port)) return "reserved";
  return null;
}

/** The submission and validation tools of one output port. */
export function graphOutputToolNames(port: string): { submit: string; validate: string } {
  return {
    submit: `${GRAPH_OUTPUT_SUBMIT_TOOL_PREFIX}${port}`,
    validate: `${GRAPH_OUTPUT_VALIDATE_TOOL_PREFIX}${port}`,
  };
}

/** The port a `submit_<port>` tool belongs to, or null for any other name. */
export function graphOutputToolPort(toolName: unknown): string | null {
  if (typeof toolName !== "string" || !toolName.startsWith(GRAPH_OUTPUT_SUBMIT_TOOL_PREFIX))
    return null;
  const port = toolName.slice(GRAPH_OUTPUT_SUBMIT_TOOL_PREFIX.length);
  return graphOutputPortProblem(port) === null ? port : null;
}

/** `validate_<port>` for a `submit_<port>` tool. Throws for any other name. */
export function graphOutputValidationToolName(toolName: string): string {
  const port = graphOutputToolPort(toolName);
  if (port === null) throw new Error("Not a graph output submission tool");
  return graphOutputToolNames(port).validate;
}

/** Provenance a consolidating port's slot is checked against (report §5.9). */
export interface GraphOutputProvenanceContext extends GraphProvenancePlan {
  /** Source item ID → class, from the node's input artifacts. */
  sources: GraphProvenanceSources;
}

/**
 * The trusted context of a `graph-output` slot: what the port declares beyond
 * its schema (which is the slot's `schema`). Built by the runtime from the
 * compiled plan; never from model output.
 */
export interface WorkflowGraphOutputContext {
  type: "graph-output";
  /** The output port's key; its tools are `submit_<port>` and `validate_<port>`. */
  port: string;
  label?: string;
  /** Shown to the model in the tool descriptions. */
  description?: string;
  /** `name@version` of the port's type. Built-in types are resolved by the backend. */
  artifactType: string;
  /** Custom types only: the storage class and budgets from the type definition. */
  storage?: ArtifactStorageClass;
  budgets?: ArtifactTypeBudgets;
  /** `decision@N` ports: the choices the port declares. */
  choices?: string[];
  /** `verification-verdict@N` ports: the criterion IDs of the ticket being verified. */
  criterionIds?: string[];
  provenance?: GraphOutputProvenanceContext;
}

export const GRAPH_OUTPUT_CONTEXT_BOUNDS = Object.freeze({
  maxChoices: 32,
  maxChoiceChars: GRAPH_TEMPLATE_BOUNDS.maxEnumValueChars,
  maxCriterionIds: 100,
  maxCriterionIdChars: 64,
});

function stringList(value: unknown, max: number, maxChars: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(
      (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= maxChars,
    )
  );
}

function budgetsProblem(value: unknown): string | null {
  if (!isPlainRecord(value)) return "budgets must be an object";
  const positive = (candidate: unknown, max: number) =>
    Number.isSafeInteger(candidate) && (candidate as number) >= 1 && (candidate as number) <= max;
  if (!positive(value.maxBytes, GRAPH_TEMPLATE_BOUNDS.maxReferenceArtifactBytes))
    return "budgets.maxBytes is invalid";
  if (
    value.maxStringBytes !== undefined &&
    !positive(value.maxStringBytes, GRAPH_TEMPLATE_BOUNDS.maxReferenceArtifactBytes)
  )
    return "budgets.maxStringBytes is invalid";
  if (
    value.maxItems !== undefined &&
    !positive(value.maxItems, GRAPH_TEMPLATE_BOUNDS.maxArtifactItems)
  )
    return "budgets.maxItems is invalid";
  return null;
}

/**
 * Structural guard for a slot context (bounded; it is persisted with the
 * slot). Returns a message naming the first problem, or null. Whether the
 * type resolves and the fields agree with the schema is the backend's check.
 */
export function graphOutputContextProblem(value: unknown): string | null {
  const B = GRAPH_OUTPUT_CONTEXT_BOUNDS;
  if (!isPlainRecord(value) || value.type !== "graph-output") return "not a graph-output context";
  const allowed = new Set([
    "type",
    "port",
    "label",
    "description",
    "artifactType",
    "storage",
    "budgets",
    "choices",
    "criterionIds",
    "provenance",
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return `unknown field ${key}`;
  const port = graphOutputPortProblem(value.port);
  if (port !== null) return `port is invalid (${port})`;
  if (
    value.label !== undefined &&
    (typeof value.label !== "string" ||
      graphUtf8Bytes(value.label) > GRAPH_TEMPLATE_BOUNDS.maxLabelBytes)
  )
    return "label is invalid";
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" ||
      graphUtf8Bytes(value.description) > GRAPH_TEMPLATE_BOUNDS.maxPortDescriptionBytes)
  )
    return "description is invalid";
  if (typeof value.artifactType !== "string") return "artifactType is required";
  const ref = parseGraphTypeRef(value.artifactType);
  if (!ref) return "artifactType is not a type reference";
  if (ref.listDepth > 0) return "artifactType must be a named type, not a list";
  if (value.storage !== undefined && value.storage !== "value" && value.storage !== "reference")
    return "storage is invalid";
  if (value.budgets !== undefined) {
    const budgets = budgetsProblem(value.budgets);
    if (budgets) return budgets;
  }
  if (value.choices !== undefined && !stringList(value.choices, B.maxChoices, B.maxChoiceChars))
    return "choices is invalid";
  if (
    value.criterionIds !== undefined &&
    !stringList(value.criterionIds, B.maxCriterionIds, B.maxCriterionIdChars)
  )
    return "criterionIds is invalid";
  if (value.provenance !== undefined) {
    const provenance = value.provenance;
    const plan = graphProvenancePlanProblem(provenance);
    if (plan) return plan;
    const sources = graphProvenanceSourcesProblem((provenance as Record<string, unknown>).sources);
    if (sources) return `provenance ${sources}`;
    for (const key of Object.keys(provenance as Record<string, unknown>)) {
      if (!["mode", "fields", "droppedField", "sources"].includes(key))
        return `unknown provenance field ${key}`;
    }
  }
  return null;
}

/** The workflow result kind graph output ports use. */
export const GRAPH_OUTPUT_RESULT_KIND: WorkflowResultKind = "graph-output";

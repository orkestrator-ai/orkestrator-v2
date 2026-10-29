/**
 * The `graph-output` result kind (plan P1.3, report §5.3, §5.5, §5.9).
 *
 * A graph agent activation opens one result slot per output port. Unlike the
 * built-in kinds, the slot carries the contract: its `schema` is the port
 * type's schema, its `toolName` is `submit_<port>` (with `validate_<port>` for
 * dry runs), and its `context` is the port declaration from the compiled plan
 * (type, choices, provenance). Values go through the full type validation of
 * the type library (`validateGraphArtifactValue`: budgets, schema, domain
 * validator), then the backend-only parts of built-in validators:
 *
 * - placeholder and probe prose, through the final-content check of the
 *   workflow result kind the type maps to (`resultKind`);
 * - provenance against the node's input items (`cite`, `accountForAll`);
 * - environment checks (`workspace-commit`, `file-list-paths`) through the
 *   registry's environment validator hook, which the service runs.
 *
 * Providers never see `x-orkestrator-sources`: the provider schema is the
 * slot schema stripped by `graphProviderSchema`. Providers on structured
 * output get one combined schema per activation ({@link graphOutputCombinedSchema})
 * whose answer the runtime splits by port ({@link splitGraphOutputCombined}).
 */
import {
  type GraphOutputProvenanceContext,
  type WorkflowGraphOutputContext,
  GRAPH_OUTPUT_RESULT_KIND,
  graphOutputContextProblem,
  graphOutputPortProblem,
  graphOutputToolNames,
  graphOutputToolPort,
  graphOutputValidationToolName,
} from "@orkestrator/protocol/graphs/output-slots";
import type { GraphOutputPortSpec } from "@orkestrator/protocol/graphs/template";
import {
  type GraphProvenanceField,
  type GraphProvenanceSources,
  graphProvenancePlanForSchema,
  validateGraphProvenance,
} from "@orkestrator/protocol/graphs/provenance";
import {
  GRAPH_SCHEMA_SUBSET_BOUNDS,
  graphProviderSchema,
  graphSchemaSegmentsPath,
  validateGraphSchemaSubset,
} from "@orkestrator/protocol/graphs/schema-subset";
import { GRAPH_TEMPLATE_BOUNDS, parseGraphTypeRef } from "@orkestrator/protocol/graphs/grammar";
import {
  type GraphTypeDefinition,
  graphBuiltInType,
  graphDecisionSchema,
  isGraphBuiltInTypeName,
  validateGraphArtifactValue,
} from "@orkestrator/protocol/graphs/types";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import {
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
  type WorkflowResultSlotInput,
  type WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import {
  WORKFLOW_RESULT_ENVIRONMENT_VALIDATOR_IDS,
  WORKFLOW_RESULT_MAX_ISSUES,
  type WorkflowResultEnvironmentValidatorId,
  type WorkflowResultKindDefinition,
  type WorkflowResultSlotView,
  workflowResultKindDefinition,
} from "./workflow-result-registry.js";
import {
  isReviewConsolidationProvenance,
  REVIEW_CONSOLIDATION_WORDING,
} from "./review-consolidation-provenance.js";

/** The contract of a `graph-output` slot that names no port type: any object. */
export const GRAPH_OUTPUT_GENERIC_SCHEMA: JsonSchema = Object.freeze({ type: "object" });

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, canonical(source[key])]),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The slot's graph-output context, when it has one. */
export function graphOutputContext(
  slot: Pick<WorkflowResultSlotView, "context">,
): WorkflowGraphOutputContext | undefined {
  return slot.context?.type === "graph-output" ? slot.context : undefined;
}

/**
 * The type definition a slot validates against: the library's built-in, or
 * the custom type the slot carries (schema in `schema`, storage and budgets
 * in the context). Undefined when the slot cannot describe one.
 */
export function graphOutputTypeDefinition(
  context: WorkflowGraphOutputContext,
  schema: JsonSchema | undefined,
): GraphTypeDefinition | undefined {
  const builtIn = graphBuiltInType(context.artifactType);
  if (builtIn) return builtIn;
  const parts = parseGraphTypeRef(context.artifactType);
  if (!parts || parts.listDepth > 0 || !schema || !context.storage || !context.budgets)
    return undefined;
  return {
    name: parts.name,
    version: parts.version,
    ref: context.artifactType,
    builtIn: false,
    family: context.storage === "reference" ? "package" : "report",
    schema: schema as Record<string, unknown>,
    storage: context.storage,
    budgets: context.budgets,
    sources: [],
  };
}

function isEnvironmentValidator(value: unknown): value is WorkflowResultEnvironmentValidatorId {
  return (WORKFLOW_RESULT_ENVIRONMENT_VALIDATOR_IDS as readonly unknown[]).includes(value);
}

/** The schema a built-in port type presents: decisions narrow `choice` to the port's options. */
function builtInPortSchema(
  definition: GraphTypeDefinition,
  context: Pick<WorkflowGraphOutputContext, "choices">,
): JsonSchema {
  return definition.name === "decision" && context.choices
    ? graphDecisionSchema(context.choices)
    : definition.schema;
}

/**
 * Checks a `graph-output` slot before it is persisted and returns what to
 * store: the effective schema (a built-in type's own, or the custom type's
 * after the subset check) and the port's submission tool. Throws with a
 * message naming the problem; the runtime built the slot, so a refusal is a
 * compile or runtime bug, never a model's.
 */
function prepareGraphOutputSlot(
  input: WorkflowResultSlotInput,
): Pick<WorkflowResultSlotInput, "schema" | "toolName"> {
  if (input.toolName !== undefined && graphOutputToolPort(input.toolName) === null)
    throw new Error("A graph output tool must be submit_<port> for a valid, unreserved port");
  const context = input.context;
  if (context === undefined) {
    // A slot without a port declaration: the generic tools and any object.
    if (
      input.schema !== undefined &&
      (!input.schema || typeof input.schema !== "object" || Array.isArray(input.schema))
    )
      throw new Error("A graph output schema must be an object");
    return { schema: input.schema, toolName: input.toolName };
  }
  const problem = graphOutputContextProblem(context);
  if (problem) throw new Error(`Invalid graph output context: ${problem}`);
  const port = context as WorkflowGraphOutputContext;
  const toolName = graphOutputToolNames(port.port).submit;
  if (input.toolName !== undefined && input.toolName !== toolName)
    throw new Error("A graph output slot's tool must be submit_<port> for its own port");

  const builtIn = graphBuiltInType(port.artifactType);
  let schema: JsonSchema;
  let sourceFields: readonly { segments: string[]; path: string }[];
  if (builtIn) {
    if (port.storage !== undefined || port.budgets !== undefined)
      throw new Error("A built-in type's storage and budgets come from the type library");
    if (port.choices !== undefined && builtIn.name !== "decision")
      throw new Error("Only decision ports declare choices");
    if (port.criterionIds !== undefined && builtIn.name !== "verification-verdict")
      throw new Error("Only verification verdict ports carry criterion IDs");
    schema = clone(builtInPortSchema(builtIn, port));
    if (input.schema !== undefined && !sameJson(input.schema, schema))
      throw new Error(`The slot schema does not match ${builtIn.ref}`);
    sourceFields = builtIn.sources;
  } else {
    const parts = parseGraphTypeRef(port.artifactType)!;
    if (isGraphBuiltInTypeName(parts.name))
      throw new Error(`${parts.name} has no version ${parts.version}`);
    if (port.choices !== undefined || port.criterionIds !== undefined)
      throw new Error("Custom types take no choices or criterion IDs");
    if (!port.storage || !port.budgets)
      throw new Error("A custom type's slot carries its storage and budgets");
    if (
      port.storage === "value" &&
      port.budgets.maxBytes > GRAPH_TEMPLATE_BOUNDS.maxValueArtifactBytes
    )
      throw new Error("A value type's byte budget exceeds the result cap");
    if (input.schema === undefined) throw new Error("A custom type's slot carries its schema");
    const subset = validateGraphSchemaSubset(input.schema, 1);
    if (!subset.ok) {
      const first = subset.errors[0];
      throw new Error(
        `The custom type's schema is outside the portable subset (${first?.path ?? "$"}: ${first?.code ?? "invalid"})`,
      );
    }
    schema = clone(input.schema);
    sourceFields = subset.value.sources;
  }

  if (port.provenance) {
    const known = new Set(sourceFields.map((field) => field.path));
    for (const field of port.provenance.fields) {
      if (!known.has(graphSchemaSegmentsPath(field.segments)))
        throw new Error(
          `Provenance field ${graphSchemaSegmentsPath(field.segments)} is not a sources field of ${port.artifactType}`,
        );
    }
    if (port.provenance.droppedField !== undefined) {
      const plan = graphProvenancePlanForSchema(port.provenance.mode, schema, sourceFields);
      if (plan?.droppedField !== port.provenance.droppedField)
        throw new Error(`${port.artifactType} has no ${port.provenance.droppedField} list`);
    }
  }
  return { schema, toolName };
}

function graphOutputLabel(slot: WorkflowResultSlotView): string {
  const context = graphOutputContext(slot);
  if (!context) return "graph output";
  return `${context.label ?? context.port} (${context.artifactType})`;
}

/** The registry entry of graph output ports. */
export const graphOutputKindDefinition: WorkflowResultKindDefinition = {
  kind: GRAPH_OUTPUT_RESULT_KIND,
  schema: (slot) => slot.schema ?? GRAPH_OUTPUT_GENERIC_SCHEMA,
  providerSchema: (slot) =>
    slot.schema
      ? graphProviderSchema(slot.schema as Record<string, unknown>)
      : GRAPH_OUTPUT_GENERIC_SCHEMA,
  toolName: (slot) => slot.toolName ?? workflowResultToolName(GRAPH_OUTPUT_RESULT_KIND),
  validationToolName: (slot) =>
    slot.toolName
      ? graphOutputValidationToolName(slot.toolName)
      : WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  label: graphOutputLabel,
  structural: (value, slot) => {
    const context = graphOutputContext(slot);
    if (!context) return null;
    const definition = graphOutputTypeDefinition(context, slot.schema);
    if (!definition)
      return [issue("$", "invalid_value", "The output port's type is unavailable for validation.")];
    return validateGraphArtifactValue(definition, value, {
      ...(context.choices ? { choices: context.choices } : {}),
      ...(context.criterionIds ? { criterionIds: context.criterionIds } : {}),
    }).slice(0, WORKFLOW_RESULT_MAX_ISSUES);
  },
  finalContent: (value, slot) => {
    const context = graphOutputContext(slot);
    const resultKind = context ? graphBuiltInType(context.artifactType)?.resultKind : undefined;
    if (!resultKind) return [];
    return workflowResultKindDefinition(resultKind).finalContent?.(value, {}) ?? [];
  },
  contextValidator: (value, slot) => {
    const provenance = graphOutputContext(slot)?.provenance;
    if (!provenance) return [];
    // Multi Review's consolidation contract keeps the wording it always had.
    return validateGraphProvenance(
      value,
      provenance,
      provenance.sources,
      isReviewConsolidationProvenance(provenance) ? REVIEW_CONSOLIDATION_WORDING : undefined,
    );
  },
  environmentValidator: (slot) => {
    const context = graphOutputContext(slot);
    const validator = context ? graphBuiltInType(context.artifactType)?.validator : undefined;
    return isEnvironmentValidator(validator) ? validator : null;
  },
  prepareSlot: prepareGraphOutputSlot,
};

// ------------------------------------------------------------ slot builder

/**
 * Builds the slot input for one output port of an activation: the port's
 * tool, its type's schema (decisions narrowed to the port's choices) and the
 * trusted context. `sources` is required when the port declares provenance:
 * the item IDs of the node's inputs, mapped to a class (the runtime uses the
 * item type, `finding@1`).
 */
export function graphOutputSlotInput(
  base: Pick<WorkflowResultSlotInput, "resultKey" | "environmentId" | "projectId" | "provider">,
  port: Pick<GraphOutputPortSpec, "name" | "label" | "description" | "provenance" | "choices">,
  type: GraphTypeDefinition,
  options: {
    criterionIds?: string[];
    sources?: GraphProvenanceSources;
    /**
     * Rules for the port's provenance fields instead of the type's plain
     * ones (item 301: a consolidation built-in's review report follows Multi
     * Review's contract). Each must name one of the type's sources fields.
     */
    provenanceFields?: GraphProvenanceField[];
  } = {},
): WorkflowResultSlotInput {
  const problem = graphOutputPortProblem(port.name);
  if (problem) throw new Error(`Output port ${port.name} cannot name a result tool (${problem})`);
  const schema = type.builtIn ? builtInPortSchema(type, port) : type.schema;
  let provenance: GraphOutputProvenanceContext | undefined;
  if (port.provenance) {
    if (!options.sources) throw new Error("A provenance port needs the sources of its inputs");
    const plan = graphProvenancePlanForSchema(port.provenance, schema, type.sources);
    if (!plan) throw new Error(`${type.ref} has a schema outside the portable subset`);
    if (options.provenanceFields) {
      const known = new Set(plan.fields.map((field) => graphSchemaSegmentsPath(field.segments)));
      for (const field of options.provenanceFields) {
        if (!known.has(graphSchemaSegmentsPath(field.segments)))
          throw new Error(
            `Provenance field ${graphSchemaSegmentsPath(field.segments)} is not a sources field of ${type.ref}`,
          );
      }
      plan.fields = options.provenanceFields.map((field) => structuredClone(field));
    }
    provenance = { ...plan, sources: { ...options.sources } };
  }
  const context: WorkflowGraphOutputContext = {
    type: "graph-output",
    port: port.name,
    ...(port.label ? { label: port.label } : {}),
    ...(port.description ? { description: port.description } : {}),
    artifactType: type.ref,
    ...(type.builtIn ? {} : { storage: type.storage, budgets: { ...type.budgets } }),
    ...(port.choices && type.name === "decision" ? { choices: [...port.choices] } : {}),
    ...(options.criterionIds && type.name === "verification-verdict"
      ? { criterionIds: [...options.criterionIds] }
      : {}),
    ...(provenance ? { provenance } : {}),
  };
  return {
    ...base,
    kind: GRAPH_OUTPUT_RESULT_KIND,
    schema: clone(schema),
    toolName: graphOutputToolNames(port.name).submit,
    context,
  };
}

// --------------------------------------------- structured-output transport

/** One port of an activation answered through a provider's structured output. */
export interface GraphOutputStructuredPort {
  port: string;
  /** The port slot's schema (it may carry `x-orkestrator-sources`). */
  schema: JsonSchema;
  /** A required port must be answered; an optional one may be null. */
  required: boolean;
  description?: string;
}

function checkPorts(ports: readonly GraphOutputStructuredPort[]): void {
  if (ports.length === 0 || ports.length > GRAPH_TEMPLATE_BOUNDS.maxPortsPerDirection)
    throw new Error(
      `An activation answers 1 to ${GRAPH_TEMPLATE_BOUNDS.maxPortsPerDirection} output ports`,
    );
  const seen = new Set<string>();
  for (const { port } of ports) {
    if (graphOutputPortProblem(port) !== null) throw new Error(`Invalid output port ${port}`);
    if (seen.has(port)) throw new Error(`Output port ${port} is listed twice`);
    seen.add(port);
  }
}

/**
 * One schema for an activation on a structured-output provider: an object
 * with one property per port. Every property is required (the cross-provider
 * rule); an optional port is nullable. Provenance annotations are stripped.
 */
export function graphOutputCombinedSchema(ports: readonly GraphOutputStructuredPort[]): JsonSchema {
  checkPorts(ports);
  const properties: Record<string, JsonSchema> = {};
  for (const entry of ports) {
    const provider = graphProviderSchema(entry.schema as Record<string, unknown>);
    const described = entry.description
      ? { ...provider, description: entry.description }
      : provider;
    properties[entry.port] = entry.required ? described : { anyOf: [described, { type: "null" }] };
  }
  const combined: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ports.map((entry) => entry.port),
    properties,
  };
  const bytes = Buffer.byteLength(JSON.stringify(combined), "utf8");
  if (bytes > GRAPH_SCHEMA_SUBSET_BOUNDS.maxSchemaBytes * ports.length)
    throw new Error("The combined output schema is too large");
  return combined;
}

export type GraphOutputSplit =
  | {
      ok: true;
      /** The ports answered, in port order: submit each value to its own slot. */
      outputs: Array<{ port: string; value: unknown }>;
      /** Optional ports answered with null. */
      omitted: string[];
    }
  | { ok: false; issues: WorkflowResultValidationIssue[] };

/**
 * Splits a combined structured answer by port. It checks only the envelope
 * (an object with exactly the ports, required ones not null); each value is
 * then submitted to its port's slot, which applies the full validation, and
 * {@link graphOutputPortIssues} maps that slot's issues back for a repair turn.
 */
export function splitGraphOutputCombined(
  ports: readonly GraphOutputStructuredPort[],
  value: unknown,
): GraphOutputSplit {
  checkPorts(ports);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      issues: [issue("$", "invalid_type", "Expected an object with one property per output")],
    };
  const answer = value as Record<string, unknown>;
  const issues: WorkflowResultValidationIssue[] = [];
  const known = new Set(ports.map((entry) => entry.port));
  for (const key of Object.keys(answer)) {
    if (!known.has(key))
      issues.push(issue(`$.${key}`, "unknown_field", "Not an output of this step"));
  }
  const outputs: Array<{ port: string; value: unknown }> = [];
  const omitted: string[] = [];
  for (const entry of ports) {
    const present = Object.hasOwn(answer, entry.port);
    const portValue = present ? answer[entry.port] : undefined;
    if (portValue === undefined || portValue === null) {
      if (entry.required) {
        issues.push(issue(`$.${entry.port}`, "missing_field", "This output is required"));
      } else if (!present) {
        issues.push(
          issue(`$.${entry.port}`, "missing_field", "Give this output, or null to omit it"),
        );
      } else {
        omitted.push(entry.port);
      }
      continue;
    }
    outputs.push({ port: entry.port, value: portValue });
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, WORKFLOW_RESULT_MAX_ISSUES) };
  return { ok: true, outputs, omitted };
}

/** A port slot's issues as paths into the combined answer (`$.brief.title`). */
export function graphOutputPortIssues(
  port: string,
  issues: readonly WorkflowResultValidationIssue[],
): WorkflowResultValidationIssue[] {
  return issues.map((entry) =>
    issue(
      entry.path === "$" ? `$.${port}` : `$.${port}${entry.path.slice(1)}`,
      entry.code,
      entry.message,
    ),
  );
}

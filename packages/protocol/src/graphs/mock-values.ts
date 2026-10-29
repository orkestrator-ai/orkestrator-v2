/**
 * The values a mock run answers with (item 213, report §7.5), shared by the
 * backend's mock executors and the designer's previews so both show the same
 * thing. Browser-safe.
 *
 * - {@link graphMockValue}: a type's `example` or a value generated from its
 *   schema ({@link graphSchemaSample}), fitted to what the port knows (a
 *   decision's choices, a ticket's criteria, the workspace commit) and
 *   checked with the same validator every real artifact passes
 *   (`validateGraphArtifactValue`). When the preferred value fails, the other
 *   source is tried; a value that still fails is returned with its issues.
 * - {@link graphMockWorkspace}: the deterministic, fake commit identity a
 *   mock node's `workspace@1` output carries. Nothing touches git.
 * - {@link GraphMockWouldRun}: the "would have run" record a side-effecting
 *   system node leaves in a mock run instead of acting.
 */
import type { WorkflowResultValidationIssue } from "../workflow-results.js";
import { graphSchemaSample } from "./schema-sample.js";
import { sha256Hex } from "./sha256.js";
import type { GraphScalarValue, GraphSystemAction } from "./template-model.js";
import {
  graphDecisionSchema,
  validateGraphArtifactValue,
  type GraphTypeDefinition,
} from "./types.js";
import type { GraphTypeValidationContext } from "./type-validators.js";

export type GraphMockValueMode = "example" | "generated";

export interface GraphMockValueContext extends GraphTypeValidationContext {
  /** The commit the run is working on, for values that name one (`headRef`). */
  headRef?: string;
}

export interface GraphMockValue {
  value: unknown;
  /** Where the value came from (a generated value that failed falls back to the example). */
  source: GraphMockValueMode;
  /** Empty when the value passes its type; otherwise why the mock will refuse it. */
  issues: WorkflowResultValidationIssue[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adjusts a value to what the port knows, for built-in types whose checks
 * depend on it: a decision's choice must be one of the port's choices, a
 * verdict reports exactly the ticket's criteria, and a `headRef` field names
 * the run's commit. Custom values are never fitted: a pinned value that does
 * not fit fails loudly.
 */
function fit(
  definition: GraphTypeDefinition,
  value: unknown,
  context: GraphMockValueContext,
): unknown {
  if (!record(value)) return value;
  const next: Record<string, unknown> = structuredClone(value);
  if (definition.builtIn && definition.name === "decision" && context.choices?.length) {
    if (typeof next.choice !== "string" || !context.choices.includes(next.choice)) {
      next.choice = context.choices[0];
    }
  }
  if (
    definition.builtIn &&
    definition.name === "verification-verdict" &&
    context.criterionIds !== undefined
  ) {
    const complete = next.complete === true;
    next.acceptanceCriteria = context.criterionIds.map((id, index) => ({
      id,
      status: complete || index > 0 ? "passed" : "failed",
      evidence: complete || index > 0 ? "Mock run: met." : "Mock run: not met.",
    }));
  }
  if (context.headRef !== undefined && typeof next.headRef === "string") {
    next.headRef = context.headRef;
  }
  return next;
}

/** The schema a value of `definition` is generated from (a decision narrowed to its choices). */
function generationSchema(definition: GraphTypeDefinition, context: GraphMockValueContext) {
  return definition.builtIn && definition.name === "decision" && context.choices?.length
    ? graphDecisionSchema(context.choices)
    : definition.schema;
}

/**
 * The mock value of one output of type `definition`: the example
 * (`"example"`, generated when the type has none) or a generated value
 * (`"generated"`, the example when the generated one fails the type's domain
 * checks). Deterministic.
 */
export function graphMockValue(
  definition: GraphTypeDefinition,
  mode: GraphMockValueMode,
  context: GraphMockValueContext = {},
): GraphMockValue {
  const candidates: { source: GraphMockValueMode; value: () => unknown }[] = [];
  const example =
    definition.example === undefined
      ? null
      : { source: "example" as const, value: () => structuredClone(definition.example) };
  const generated = {
    source: "generated" as const,
    value: () => graphSchemaSample(generationSchema(definition, context)),
  };
  if (mode === "example") {
    if (example) candidates.push(example);
    candidates.push(generated);
  } else {
    candidates.push(generated);
    if (example) candidates.push(example);
  }
  const validation: GraphTypeValidationContext = {
    ...(context.choices ? { choices: context.choices } : {}),
    ...(context.criterionIds ? { criterionIds: context.criterionIds } : {}),
  };
  let first: GraphMockValue | null = null;
  for (const candidate of candidates) {
    const value = fit(definition, candidate.value(), context);
    const issues = validateGraphArtifactValue(definition, value, validation);
    if (issues.length === 0) return { value, source: candidate.source, issues };
    first ??= { value, source: candidate.source, issues };
  }
  return first!;
}

/** A `workspace@1` value. */
export interface GraphMockWorkspaceValue {
  branch: string;
  headRef: string;
  baseRef: string | null;
}

/** A deterministic 40-character hex "commit" id. */
export function graphMockCommit(seed: string): string {
  return sha256Hex(`orkestrator-mock-commit\0${seed}`).slice(0, 40);
}

/**
 * The fake commit identity of a mock node's `workspace@1` output, derived
 * from the run, the activation and the port (so a retry or restart yields
 * the same one). A writing node makes a new "commit" on top of its input's;
 * a reading node passes its input's through. Nothing touches git.
 */
export function graphMockWorkspace(input: {
  runId: string;
  activationKey: string;
  port: string;
  /** The node writes (`workspaceAccess: write`): a new commit. */
  writes: boolean;
  /** The `workspace@1` the node consumed, when it had one. */
  base?: GraphMockWorkspaceValue;
}): GraphMockWorkspaceValue {
  const branch = input.base?.branch ?? `mock/run-${graphMockCommit(input.runId).slice(0, 8)}`;
  if (!input.writes && input.base) return { ...input.base };
  return {
    branch,
    headRef: graphMockCommit(`${input.runId}\0${input.activationKey}\0${input.port}`),
    baseRef: input.base?.headRef ?? null,
  };
}

/**
 * What a side-effecting system node would have done, recorded in the run's
 * effect journal (state `simulated`, data `{ wouldRun }`) instead of acting.
 * The run view's inspector shows it beside the activation (item 211).
 */
export interface GraphMockWouldRun {
  action: GraphSystemAction;
  /** The action's label (`GRAPH_SYSTEM_ACTION_SPECS`). */
  label: string;
  /** One sentence: "Would open a pull request from mock/run-1 into main." */
  summary: string;
  /** The parameters with defaults applied. */
  params: Record<string, GraphScalarValue>;
  /** Facts the summary names: branch, commit, target, ticket status, recipient (bounded, no bodies). */
  details: Record<string, string | number | boolean | null>;
  /** Input port → the artifact ids it read. */
  inputs: Record<string, string | string[]>;
  /** Output port → the mock artifact id it produced instead. */
  outputs: Record<string, string>;
}

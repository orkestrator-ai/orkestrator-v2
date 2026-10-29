/**
 * The workflow result kind registry (plan P1.3, report §5.3).
 *
 * Every result kind maps to one {@link WorkflowResultKindDefinition}: its
 * schema, the provider-facing schema, its submission and validation tools, and
 * the validators that run at submit time. Built-in kinds register themselves in
 * `workflow-result-contracts.ts`; graph output ports register the generic
 * `graph-output` kind (`workflow-result-graph-output.ts`), whose schema and
 * tool name come from the slot. Adding a kind is a registration, not an edit
 * to enums, switch statements and context unions.
 *
 * Definitions are static and process-wide. What a running backend attaches to
 * a kind — acceptance checks (a workflow's environment preconditions, item
 * 001) and the environment validator hook — is per {@link WorkflowResultRegistry}
 * instance, which each `WorkflowResultService` owns, so two services in one
 * process (tests, two data directories) never share registrations.
 */
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { validateWorkflowJsonSchema } from "@orkestrator/protocol/workflow-json-schema";
import type {
  WorkflowResultError,
  WorkflowResultKind,
  WorkflowResultSlotInput,
  WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";

/** Issues one validation returns at most. */
export const WORKFLOW_RESULT_MAX_ISSUES = 32;

/** What a kind's definition sees of a slot. */
export type WorkflowResultSlotView = Pick<
  WorkflowResultSlotInput,
  "schema" | "toolName" | "context"
>;

/** The attempt an acceptance check or environment validator is asked about. */
export interface WorkflowResultAttempt {
  resultKey: string;
  kind: WorkflowResultKind;
  environmentId: string;
  projectId: string;
}

/**
 * A workflow's own precondition on its environment, checked before a result of
 * one kind is validated or accepted. Returns the error to hand the model, or
 * null when the result may proceed.
 *
 * Several owners may register checks for the same kind (a build pipeline's
 * review guard and a graph node's guard both judge `review-report`). A check
 * must therefore return null for every attempt it does not own: another
 * workflow's key, a superseded attempt, a turn it does not guard.
 */
export type WorkflowResultAcceptanceCheck = (
  attempt: WorkflowResultAttempt,
) => Promise<WorkflowResultError | null>;

/**
 * Built-in validators that need the environment (report §5.3): a
 * `workspace@1` commit must exist and be reachable from its branch, and the
 * paths of a `file-list@1` must resolve inside the worktree.
 */
export const WORKFLOW_RESULT_ENVIRONMENT_VALIDATOR_IDS = [
  "workspace-commit",
  "file-list-paths",
] as const;
export type WorkflowResultEnvironmentValidatorId =
  (typeof WORKFLOW_RESULT_ENVIRONMENT_VALIDATOR_IDS)[number];

export interface WorkflowResultEnvironmentRequest {
  attempt: WorkflowResultAttempt;
  validator: WorkflowResultEnvironmentValidatorId;
  /** A value that already passed every pure check of its kind. */
  value: unknown;
}

/**
 * The runtime's environment access, supplied to the registry as a hook. It
 * returns the value's problems as ordinary validation issues (which the model
 * corrects like any other), and throws when the environment cannot be
 * observed: the service then refuses the result without spending a correction,
 * because an unchecked value must never be accepted (fail closed).
 */
export type WorkflowResultEnvironmentValidator = (
  request: WorkflowResultEnvironmentRequest,
) => Promise<WorkflowResultValidationIssue[]>;

export interface WorkflowResultKindDefinition {
  kind: WorkflowResultKind;
  /** The contract schema values are validated against. */
  schema(slot: WorkflowResultSlotView): JsonSchema;
  /** The schema a provider sees (tool input, structured output). Defaults to {@link schema}. */
  providerSchema?(slot: WorkflowResultSlotView): JsonSchema;
  /** The submission tool. */
  toolName(slot: WorkflowResultSlotView): string;
  /** The read-only validation tool. */
  validationToolName(slot: WorkflowResultSlotView): string;
  /** Short noun for tool titles and descriptions: "review report". */
  label(slot: WorkflowResultSlotView): string;
  /**
   * Replaces the schema check: issues, or null to run the schema check. Used
   * for legacy shapes that skip it and for checks that must come first
   * (graph budgets).
   */
  structural?(value: unknown, slot: WorkflowResultSlotView): WorkflowResultValidationIssue[] | null;
  /** Domain validation after the structure passed. May throw; the message becomes one issue. */
  validator?(value: unknown, slot: WorkflowResultSlotView): WorkflowResultValidationIssue[];
  /** Final-content checks (placeholders, probes) on a valid object. */
  finalContent?(
    value: Record<string, unknown>,
    slot: WorkflowResultSlotView,
  ): WorkflowResultValidationIssue[];
  /** Checks against the slot's trusted context (sources, pools, stories). */
  contextValidator?(
    value: Record<string, unknown>,
    slot: WorkflowResultSlotView,
  ): WorkflowResultValidationIssue[];
  /** The environment validator a slot needs, if any. */
  environmentValidator?(slot: WorkflowResultSlotView): WorkflowResultEnvironmentValidatorId | null;
  /**
   * Checks and normalises a slot when it is prepared (throws to refuse it),
   * and returns the fields to persist with it.
   */
  prepareSlot?(
    input: WorkflowResultSlotInput,
  ): Pick<WorkflowResultSlotInput, "schema" | "toolName">;
}

/** A kind's definition with what a registry instance attached to it. */
export interface WorkflowResultRegistryEntry extends WorkflowResultKindDefinition {
  acceptanceChecks: readonly WorkflowResultAcceptanceCheck[];
}

const DEFINITIONS = new Map<WorkflowResultKind, WorkflowResultKindDefinition>();

/** Registers a kind. Each kind registers once, at module load. */
export function registerWorkflowResultKind(definition: WorkflowResultKindDefinition): void {
  if (DEFINITIONS.has(definition.kind))
    throw new Error(`Workflow result kind ${definition.kind} is already registered`);
  DEFINITIONS.set(definition.kind, Object.freeze({ ...definition }));
}

/** Every registered kind, in registration order. */
export function registeredWorkflowResultKinds(): WorkflowResultKind[] {
  return Array.from(DEFINITIONS.keys());
}

/**
 * The definition of an unregistered kind. Only a value that bypassed the kind
 * guard reaches it; it keeps the pre-registry behaviour (the slot's schema, or
 * none, and no domain checks).
 */
function unregisteredDefinition(kind: WorkflowResultKind): WorkflowResultKindDefinition {
  return {
    kind,
    schema: (slot) => slot.schema ?? {},
    toolName: () => `submit_${String(kind).replaceAll("-", "_")}`,
    validationToolName: () => "validate_workflow_result",
    label: () => String(kind).replaceAll("-", " "),
  };
}

/** A kind's definition. */
export function workflowResultKindDefinition(
  kind: WorkflowResultKind,
): WorkflowResultKindDefinition {
  return DEFINITIONS.get(kind) ?? unregisteredDefinition(kind);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(path: string, code: string, message: string): WorkflowResultValidationIssue {
  return { path: path.slice(0, 256), code, message: message.slice(0, 512) };
}

/**
 * The one validation path every kind shares: structure (the schema, or the
 * kind's replacement), then domain validation, then final content and the
 * trusted context. Environment checks are asynchronous and run in the service
 * after this passes.
 */
export function validateRegisteredWorkflowResult(
  kind: WorkflowResultKind,
  value: unknown,
  slot: WorkflowResultSlotView = {},
): WorkflowResultValidationIssue[] {
  const definition = workflowResultKindDefinition(kind);
  const structural =
    definition.structural?.(value, slot) ??
    validateWorkflowJsonSchema(definition.schema(slot), value);
  if (structural.length > 0) return structural;
  try {
    const domain = definition.validator?.(value, slot) ?? [];
    if (domain.length > 0) return domain.slice(0, WORKFLOW_RESULT_MAX_ISSUES);
  } catch (error) {
    return [issue("$", "invalid_value", error instanceof Error ? error.message : String(error))];
  }
  if (!record(value)) return [];
  const issues = [...(definition.finalContent?.(value, slot) ?? [])];
  issues.push(...(definition.contextValidator?.(value, slot) ?? []));
  return issues.slice(0, WORKFLOW_RESULT_MAX_ISSUES);
}

/** The schema a provider sees for a slot. */
export function workflowResultProviderSchema(
  kind: WorkflowResultKind,
  slot: WorkflowResultSlotView = {},
): JsonSchema {
  const definition = workflowResultKindDefinition(kind);
  return definition.providerSchema?.(slot) ?? definition.schema(slot);
}

/** The submission and validation tools of a slot. */
export function workflowResultSlotTools(
  kind: WorkflowResultKind,
  slot: WorkflowResultSlotView = {},
): { submit: string; validate: string } {
  const definition = workflowResultKindDefinition(kind);
  return { submit: definition.toolName(slot), validate: definition.validationToolName(slot) };
}

/**
 * What one backend attaches to the registered kinds. Owned by a
 * `WorkflowResultService`; every lookup returns the static definition plus
 * this instance's acceptance checks.
 */
export class WorkflowResultRegistry {
  private readonly acceptanceChecks = new Map<
    WorkflowResultKind,
    WorkflowResultAcceptanceCheck[]
  >();
  private environmentValidator: WorkflowResultEnvironmentValidator | null = null;

  /** kind → {schema, validators, toolName, acceptanceChecks[]}. */
  entry(kind: WorkflowResultKind): WorkflowResultRegistryEntry {
    return {
      ...workflowResultKindDefinition(kind),
      acceptanceChecks: this.checksFor(kind),
    };
  }

  /**
   * Adds an acceptance check for one kind. Checks accumulate per kind and run
   * in registration order; the first refusal wins. Returns a function that
   * removes this registration.
   */
  addAcceptanceCheck(kind: WorkflowResultKind, check: WorkflowResultAcceptanceCheck): () => void {
    const checks = this.acceptanceChecks.get(kind) ?? [];
    checks.push(check);
    this.acceptanceChecks.set(kind, checks);
    return () => {
      const current = this.acceptanceChecks.get(kind);
      if (!current) return;
      const index = current.indexOf(check);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.acceptanceChecks.delete(kind);
    };
  }

  /** A copy: a check may unregister itself (or another) while the list runs. */
  checksFor(kind: WorkflowResultKind): readonly WorkflowResultAcceptanceCheck[] {
    return this.acceptanceChecks.get(kind)?.slice() ?? [];
  }

  hasAcceptanceChecks(): boolean {
    return this.acceptanceChecks.size > 0;
  }

  /**
   * Installs the runtime's environment access. One hook serves every
   * environment validator id; installing another replaces it. Returns a
   * function that removes this installation.
   */
  setEnvironmentValidator(validator: WorkflowResultEnvironmentValidator): () => void {
    this.environmentValidator = validator;
    return () => {
      if (this.environmentValidator === validator) this.environmentValidator = null;
    };
  }

  /** The installed hook, or null when the runtime supplied none. */
  environmentHook(): WorkflowResultEnvironmentValidator | null {
    return this.environmentValidator;
  }
}

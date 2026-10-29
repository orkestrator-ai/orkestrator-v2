/**
 * The result slots of a graph agent activation (item 204, report §5.5, §8.3).
 *
 * Every output port the agent fills opens one `graph-output` workflow result
 * slot per request, keyed by {@link graphAgentResultKey}: `submit_<port>`,
 * `validate_<port>` and the shared status tool on the activation's
 * credential. `workspace@1` ports are not slots: the runtime fills them from
 * Git after the turn (agents do not hand-write commits).
 *
 * To the branch runner the activation's result is one result per request:
 * it exists once every required port's slot is accepted, and its value is
 * `{ port: value }` over the accepted ports. Providers on structured output
 * get one combined schema (one property per port) and the answer is split by
 * port and checked with each slot's own validation. Accepted values become
 * immutable artifacts in the run's store (validated against their type
 * again), with lineage = the consumed input artifacts and the workspace
 * commit.
 */
import type { GraphPlanAgentNode, GraphPlanOutputPort } from "@orkestrator/protocol/graphs/compile";
import type { GraphProvenanceSources } from "@orkestrator/protocol/graphs/provenance";
import {
  graphAcceptedItemIds,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  GraphTypeLibrary,
  type GraphTypeDefinition,
  type GraphTypeValidationContext,
} from "@orkestrator/protocol/graphs/types";
import type {
  JsonSchema,
  StructuredOutputProvider,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import type { ReviewContractValidationIssue } from "@orkestrator/protocol/structured-review";
import type {
  WorkflowResultSlotInput,
  WorkflowResultSubmissionState,
  WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import type { AgentBranchParsedResult } from "./agent-branch-types.js";
import { graphAgentResultKey } from "./graph-agent-state.js";
import {
  graphOutputCombinedSchema,
  graphOutputPortIssues,
  graphOutputSlotInput,
  splitGraphOutputCombined,
  type GraphOutputStructuredPort,
} from "./workflow-result-graph-output.js";
import { validateRegisteredWorkflowResult } from "./workflow-result-registry.js";
import type { WorkflowResultService } from "./workflow-result-service.js";

const CONTRACT_CODES: ReadonlySet<string> = new Set([
  "invalid_type",
  "missing_field",
  "unknown_field",
  "invalid_value",
  "duplicate_id",
  "inconsistent_value",
]);

/** Result issues in the repair prompt's vocabulary; other codes keep their name in the message. */
export function graphAgentContractIssues(
  issues: readonly WorkflowResultValidationIssue[],
): ReviewContractValidationIssue[] {
  return issues.map((issue) =>
    CONTRACT_CODES.has(issue.code)
      ? {
          path: issue.path,
          code: issue.code as ReviewContractValidationIssue["code"],
          message: issue.message,
        }
      : { path: issue.path, code: "invalid_value", message: `${issue.code}: ${issue.message}` },
  );
}

/** What the slots need from the workflow result service. */
export type GraphAgentResultService = Pick<
  WorkflowResultService,
  | "prepare"
  | "projection"
  | "structured"
  | "heldValidation"
  | "claimCommitNudge"
  | "consume"
  | "close"
>;

export class GraphAgentResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphAgentResultError";
  }
}

/** One output port the agent submits. */
export interface GraphAgentSlotPort {
  port: GraphPlanOutputPort;
  definition: GraphTypeDefinition;
  required: boolean;
}

export interface GraphAgentResultsInput {
  run: Readonly<GraphRun>;
  node: GraphPlanAgentNode;
  activation: Readonly<NodeActivation>;
  service: GraphAgentResultService | undefined;
  /** Item ids of the consumed inputs, for provenance ports: id → class. */
  sources: GraphProvenanceSources;
  /** Acceptance criteria ids of the ticket input, for verdict ports. */
  criterionIds?: string[];
}

function isWorkspaceType(definition: GraphTypeDefinition): boolean {
  return definition.builtIn && definition.name === "workspace";
}

export function graphAgentTypeLibrary(run: Readonly<GraphRun>): GraphTypeLibrary {
  return new GraphTypeLibrary(run.plan.types);
}

function namedDefinition(library: GraphTypeLibrary, type: string): GraphTypeDefinition {
  const resolved = library.resolve(type);
  if (!resolved.ok || resolved.type.kind !== "named") {
    throw new GraphAgentResultError(`The output type ${type} does not resolve in the run's plan`);
  }
  return resolved.type.definition;
}

/** The node's output ports split into agent slots and runtime-filled workspace ports. */
export function graphAgentOutputPorts(
  run: Readonly<GraphRun>,
  node: GraphPlanAgentNode,
): { slots: GraphAgentSlotPort[]; workspace: GraphPlanOutputPort[] } {
  const library = graphAgentTypeLibrary(run);
  const slots: GraphAgentSlotPort[] = [];
  const workspace: GraphPlanOutputPort[] = [];
  for (const port of node.outputs) {
    const definition = namedDefinition(library, port.type);
    if (isWorkspaceType(definition)) {
      workspace.push(port);
      continue;
    }
    if (definition.storage !== "value") {
      throw new GraphAgentResultError(
        `Output ${port.name} has the reference type ${port.type}; agent nodes produce value artifacts only`,
      );
    }
    slots.push({ port, definition, required: port.required });
  }
  return { slots, workspace };
}

export class GraphAgentResults {
  readonly slots: GraphAgentSlotPort[];
  readonly workspacePorts: GraphPlanOutputPort[];
  private readonly scope: { environmentId: string; projectId: string };
  /** Ports of the last projected request that have no accepted slot yet. */
  private missing: string[] = [];

  constructor(private readonly input: GraphAgentResultsInput) {
    const ports = graphAgentOutputPorts(input.run, input.node);
    this.slots = ports.slots;
    this.workspacePorts = ports.workspace;
    this.scope = { environmentId: input.run.environmentId!, projectId: input.run.projectId };
  }

  private get service(): GraphAgentResultService {
    if (!this.input.service) throw new GraphAgentResultError("Workflow results are unavailable");
    return this.input.service;
  }

  /** Port → result key for one request. */
  keys(requestId: string): Record<string, string> {
    return Object.fromEntries(
      this.slots.map((slot) => [
        slot.port.name,
        graphAgentResultKey(
          this.input.run.id,
          this.input.activation.key,
          requestId,
          slot.port.name,
        ),
      ]),
    );
  }

  keyList(requestId: string): string[] {
    return Object.values(this.keys(requestId));
  }

  /** The workflow-result slot input of one port. */
  slotInput(
    slot: GraphAgentSlotPort,
    requestId: string,
    provider: WorkflowResultSlotInput["provider"],
  ): WorkflowResultSlotInput {
    const resultKey = graphAgentResultKey(
      this.input.run.id,
      this.input.activation.key,
      requestId,
      slot.port.name,
    );
    return graphOutputSlotInput(
      {
        resultKey,
        environmentId: this.scope.environmentId,
        projectId: this.scope.projectId,
        provider,
      },
      {
        name: slot.port.name,
        ...(slot.port.label ? { label: slot.port.label } : {}),
        ...(slot.port.description ? { description: slot.port.description } : {}),
        ...(slot.port.provenance ? { provenance: slot.port.provenance } : {}),
        ...(slot.port.choices ? { choices: slot.port.choices } : {}),
      },
      slot.definition,
      {
        ...(this.input.criterionIds ? { criterionIds: this.input.criterionIds } : {}),
        ...(slot.port.provenance ? { sources: this.input.sources } : {}),
      },
    );
  }

  /** Opens one slot per port for a request (idempotent for the same request). */
  async prepare(requestId: string, provider: WorkflowResultSlotInput["provider"]): Promise<void> {
    for (const slot of this.slots) {
      await this.service.prepare(this.slotInput(slot, requestId, provider));
    }
  }

  /**
   * The request's delivery state across its slots: `received` once every
   * required port is accepted; otherwise the most urgent state of a slot
   * still missing.
   */
  async project(requestId: string): Promise<WorkflowResultSubmissionState | undefined> {
    const keys = this.keys(requestId);
    const states = new Map<string, WorkflowResultSubmissionState | undefined>();
    for (const slot of this.slots) {
      states.set(slot.port.name, await this.service.projection(keys[slot.port.name]!));
    }
    this.missing = this.slots
      .filter((slot) => slot.required && states.get(slot.port.name) !== "received")
      .map((slot) => slot.port.name);
    if (this.missing.length === 0) return this.slots.length > 0 ? "received" : undefined;
    const pending = this.missing.map((port) => states.get(port));
    if (pending.includes("needs-attention")) return "needs-attention";
    if (pending.includes("correcting")) return "correcting";
    return pending.includes("preparing") ? "preparing" : undefined;
  }

  /** The submission tool of the first required port still missing (for reminders). */
  missingTool(): string {
    const port = this.missing[0] ?? this.slots.find((slot) => slot.required)?.port.name;
    return port ? `submit_${port}` : "the result tools";
  }

  /**
   * The request's result: every accepted port's value once every required
   * port is accepted, else null.
   */
  async read(requestId: string): Promise<StructuredOutputResult<unknown> | null> {
    const keys = this.keys(requestId);
    const value: Record<string, unknown> = {};
    let provider: StructuredOutputProvider = "claude";
    for (const slot of this.slots) {
      const result = await this.service.structured<unknown>(keys[slot.port.name]!);
      if (result?.ok) {
        value[slot.port.name] = result.value;
        provider = result.provider;
      } else if (slot.required) {
        return null;
      }
    }
    if (this.slots.length === 0) return null;
    return { ok: true, provider, requestId, value };
  }

  /** Whether any slot of the request was accepted: proof the request reached the agent. */
  async proof(requestId: string): Promise<StructuredOutputResult<unknown> | null> {
    const keys = this.keys(requestId);
    for (const slot of this.slots) {
      const result = await this.service.structured<unknown>(keys[slot.port.name]!);
      if (result?.ok) return result;
    }
    return null;
  }

  /** The oldest held validation among the request's slots. */
  held(
    requestId: string,
  ): { digest: string; ageMs: number; port: string; key: string } | undefined {
    const keys = this.keys(requestId);
    let found: { digest: string; ageMs: number; port: string; key: string } | undefined;
    for (const slot of this.slots) {
      const key = keys[slot.port.name]!;
      const held = this.service.heldValidation(key);
      if (held && (!found || held.ageMs > found.ageMs))
        found = { ...held, port: slot.port.name, key };
    }
    return found;
  }

  claimNudge(requestId: string): boolean {
    const held = this.held(requestId);
    return held ? this.service.claimCommitNudge(held.key) : false;
  }

  /** Consumes every accepted slot of the request (the payload leaves the slot store). */
  async consume(requestId: string): Promise<void> {
    const keys = this.keys(requestId);
    for (const slot of this.slots) {
      const key = keys[slot.port.name]!;
      if ((await this.service.structured(key))?.ok) await this.service.consume(key);
    }
  }

  /** Retires every slot of a request a new request replaces. */
  async close(requestId: string): Promise<void> {
    for (const key of this.keyList(requestId)) await this.service.close(key, "superseded");
  }

  /** One schema for a structured-output provider: one property per port. */
  combinedSchema(): JsonSchema {
    return graphOutputCombinedSchema(this.structuredPorts("schema-only"));
  }

  private structuredPorts(_purpose: "schema-only"): GraphOutputStructuredPort[] {
    return this.slots.map((slot) => {
      const input = this.slotInput(slot, "schema", "claude");
      return {
        port: slot.port.name,
        schema: input.schema!,
        required: slot.required,
        ...(slot.port.description ? { description: slot.port.description } : {}),
      };
    });
  }

  /**
   * Parses a result as the branch runner asks: a tool-transport result was
   * validated by its slots; a structured answer is split by port and each
   * value checked with its slot's own validation (issues map back into the
   * combined answer for the repair turn).
   */
  parse(
    transport: string | undefined,
    result: StructuredOutputResult<unknown>,
  ): AgentBranchParsedResult {
    if (!result.ok) {
      if (
        result.error.code === "schema_retry_exhausted" ||
        result.error.code === "malformed_output"
      ) {
        return {
          success: false,
          error: {
            message: "The structured result did not match the output schema.",
            issues: [
              {
                path:
                  typeof result.error.details?.path === "string" ? result.error.details.path : "$",
                code: "invalid_value",
                message: result.error.message.slice(0, 512),
              },
            ],
          },
        };
      }
      throw new GraphAgentResultError(result.error.message);
    }
    if (transport === "tool-v1") return { success: true, data: result.value };
    const ports = this.structuredPorts("schema-only");
    const split = splitGraphOutputCombined(ports, result.value);
    if (!split.ok) {
      return {
        success: false,
        error: {
          message: "The result failed its contract.",
          issues: graphAgentContractIssues(split.issues),
        },
      };
    }
    const issues: ReviewContractValidationIssue[] = [];
    const value: Record<string, unknown> = {};
    for (const output of split.outputs) {
      const slot = this.slots.find((entry) => entry.port.name === output.port)!;
      const input = this.slotInput(slot, "structured", "claude");
      const portIssues = validateRegisteredWorkflowResult("graph-output", output.value, {
        schema: input.schema,
        ...(input.toolName ? { toolName: input.toolName } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      if (portIssues.length > 0) {
        issues.push(...graphAgentContractIssues(graphOutputPortIssues(output.port, portIssues)));
      } else value[output.port] = output.value;
    }
    if (issues.length > 0) {
      return { success: false, error: { message: "The result failed its contract.", issues } };
    }
    return { success: true, data: value };
  }

  /** The type validation context of a port (choices, criteria). */
  validation(slot: GraphAgentSlotPort): GraphTypeValidationContext | undefined {
    const context: GraphTypeValidationContext = {
      ...(slot.port.choices ? { choices: slot.port.choices } : {}),
      ...(this.input.criterionIds ? { criterionIds: this.input.criterionIds } : {}),
    };
    return Object.keys(context).length > 0 ? context : undefined;
  }
}

/**
 * Stable item ids of an accepted value whose type has `items`, from the one
 * protocol derivation (`graphAcceptedItemIds`, item 205):
 * `<node>[/iter-<n>][/<branch>]/<idPrefix>-<k>` (report §5.8, §5.9).
 */
export function graphAgentItemIds(
  definition: GraphTypeDefinition,
  value: unknown,
  activation: Pick<NodeActivation, "nodeId" | "branchKey" | "iteration">,
): string[] | undefined {
  return graphAcceptedItemIds(definition.items, value, {
    nodeId: activation.nodeId,
    iteration: activation.iteration,
    ...(activation.branchKey !== undefined ? { branchKey: activation.branchKey } : {}),
  });
}

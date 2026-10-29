/**
 * Mock `system` nodes (item 213, plan P2.13). A mock run must never open a
 * pull request, push, move a ticket, mail anyone, start an environment or run
 * commands in one, so no action handler of `graph-node-system.ts` runs here:
 *
 * - Every output answers like a mock agent's (pin, else example, else
 *   generated), fitted to the run's fake commit. A `workspace@1` output
 *   passes the input commit through (system nodes never commit); a
 *   `review-package@2` is an unwritten mock file (`putMockReference`);
 *   `wait-for-checks` answers its pinned or example `check-summary@1` at once.
 * - An action with `sideEffect` (`GRAPH_SYSTEM_ACTION_SPECS`) records "would
 *   have run" in the run's effect journal (state `simulated`, data
 *   `{ wouldRun: GraphMockWouldRun }`, key `would-run:<activation key>`):
 *   the action, its parameters with defaults, the facts it would have acted
 *   on (branch, commit, target branch, ticket move, recipient) and the
 *   artifacts it read and produced. The run view's inspector shows it.
 */
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import {
  graphMockValue,
  graphMockWorkspace,
  type GraphMockWouldRun,
} from "@orkestrator/protocol/graphs/mock";
import {
  GRAPH_SYSTEM_ACTION_SPECS,
  graphSystemActionParams,
} from "@orkestrator/protocol/graphs/system-actions";
import type { GraphScalarValue } from "@orkestrator/protocol/graphs/template";
import {
  graphMockBaseWorkspace,
  graphMockCustomOutputs,
  graphMockDefinition,
  graphMockFailure,
  graphMockInputs,
  graphMockPinFor,
  graphMockSkipsPort,
  graphMockStep,
  graphMockStoreOutput,
  type GraphMockInput,
} from "./graph-mock-outputs.js";
import type {
  GraphActivationReport,
  GraphCancelReason,
  GraphExecutorContext,
  GraphNodeExecutor,
} from "./graph-run-executors.js";
import type { GraphEffectsStorage } from "./storage-graph-effects.js";

type SystemNode = Extract<GraphPlanNode, { kind: "system" }>;

export interface GraphMockSystemDependencies {
  storage: { graphEffects: Pick<GraphEffectsStorage, "recordSimulatedGraphEffect"> };
  owner: string;
}

/** The effect-journal key of an activation's "would have run" record. */
export function graphMockWouldRunKey(activationKey: string): string {
  return `would-run:${activationKey}`;
}

function short(commit: string | undefined): string {
  return commit ? commit.slice(0, 12) : "the run's commit";
}

function inputValue(inputs: readonly GraphMockInput[], type: string): unknown {
  const artifact = inputs.find((input) => input.type === type)?.artifacts[0];
  return artifact && "value" in artifact.body ? artifact.body.value : undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The sentence and facts of one action's "would have run" record. */
function describe(
  node: SystemNode,
  params: Record<string, GraphScalarValue>,
  inputs: readonly GraphMockInput[],
): { summary: string; details: GraphMockWouldRun["details"] } {
  const workspace = graphMockBaseWorkspace(inputs);
  const branch = workspace?.branch ?? null;
  const headRef = workspace?.headRef ?? null;
  const commands = field(inputValue(inputs, "validation-plan@1"), "commands");
  const commandCount = Array.isArray(commands) ? commands.length : 0;
  const target =
    typeof params.targetBranch === "string"
      ? params.targetBranch
      : "the project's pull request base branch";
  switch (node.action) {
    case "prepare-environment":
      return {
        summary:
          params.setup === false
            ? "Would start the run's environment."
            : "Would start the run's environment and run its setup script once.",
        details: { setup: params.setup !== false },
      };
    case "run-validation":
      return {
        summary: `Would run the validation plan's ${commandCount} command${commandCount === 1 ? "" : "s"} on ${short(headRef ?? undefined)}.`,
        details: { headRef, commands: commandCount },
      };
    case "run-validation-and-seal":
      return {
        summary: `Would run the validation plan's ${commandCount} command${commandCount === 1 ? "" : "s"} on ${short(headRef ?? undefined)} and seal a review package against ${target}.`,
        details: { headRef, commands: commandCount, targetBranch: target },
      };
    case "push-branch":
      return {
        summary: `Would push ${short(headRef ?? undefined)} to origin/${branch ?? "the run's branch"}.`,
        details: { branch, headRef },
      };
    case "open-pull-request": {
      const title = field(inputValue(inputs, "pr-description@1"), "title");
      return {
        summary: `Would push ${branch ?? "the run's branch"} and open a${params.draft === true ? " draft" : ""} pull request into ${target}.`,
        details: {
          branch,
          headRef,
          targetBranch: target,
          draft: params.draft === true,
          title: typeof title === "string" ? title.slice(0, 256) : null,
        },
      };
    }
    case "update-ticket": {
      const parts: string[] = [];
      if (typeof params.lifecycle === "string") parts.push(`record the ${params.lifecycle} event`);
      if (typeof params.status === "string") parts.push(`move it to ${params.status}`);
      if (typeof params.comment === "string") parts.push("add a comment");
      if (params.record === "criteria") parts.push("record the verdict on its criteria");
      return {
        summary: `Would update the ticket: ${parts.join(", ") || "no change"}.`,
        details: {
          taskId: typeof params.taskId === "string" ? params.taskId : null,
          lifecycle: typeof params.lifecycle === "string" ? params.lifecycle : null,
          status: typeof params.status === "string" ? params.status : null,
          comment: typeof params.comment === "string",
        },
      };
    }
    case "notify":
      return {
        summary:
          params.to === "tab"
            ? typeof params.tabId === "string"
              ? `Would mail tab ${params.tabId}.`
              : "Would mail a tab."
            : "Would mail the coordinator.",
        details: {
          to: typeof params.to === "string" ? params.to : null,
          tabId: typeof params.tabId === "string" ? params.tabId : null,
          subject: typeof params.subject === "string" ? params.subject.slice(0, 200) : null,
        },
      };
    case "wait-for-checks":
      return { summary: "Reads check results only.", details: {} };
  }
}

/** Mock `system` nodes: mock outputs, and "would have run" for side effects. */
export class GraphMockSystemExecutor implements GraphNodeExecutor {
  readonly kind = "system" as const;

  constructor(private readonly deps: GraphMockSystemDependencies) {}

  start(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return graphMockStep(context, () => this.produce(context));
  }

  observe(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return graphMockStep(context, () => this.produce(context));
  }

  recover(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return graphMockStep(context, () => this.produce(context));
  }

  /** Nothing runs elsewhere, so every cancel reason stops it at once. */
  async cancel(_context: GraphExecutorContext, _reason: GraphCancelReason) {
    return { state: "cancelled" as const };
  }

  private async produce(context: GraphExecutorContext): Promise<GraphActivationReport> {
    const node = context.node as SystemNode;
    const pin = graphMockPinFor(context);
    if (pin !== undefined && typeof pin !== "string" && "fail" in pin) {
      return graphMockFailure(pin);
    }
    const spec = GRAPH_SYSTEM_ACTION_SPECS[node.action];
    const inputs = await graphMockInputs(context);
    const lineage = inputs.flatMap((input) => input.ids);
    const base = graphMockBaseWorkspace(inputs);
    const workspace = base
      ? base
      : graphMockWorkspace({
          runId: context.run.id,
          activationKey: context.activation.key,
          port: "workspace",
          writes: true,
        });
    const custom = graphMockCustomOutputs(pin);
    const mode = pin === "generated" ? "generated" : "example";
    const outputs: Record<string, string> = {};
    for (const port of node.outputs) {
      if (graphMockSkipsPort(port)) continue;
      const definition = graphMockDefinition(context.run, port.type);
      let value: unknown;
      if (Object.hasOwn(custom, port.name)) {
        value = custom[port.name];
        if (value === null) continue;
      } else if (definition.builtIn && definition.name === "workspace") {
        value = workspace;
      } else {
        value = graphMockValue(definition, mode, {
          ...(port.choices ? { choices: port.choices } : {}),
          headRef: workspace.headRef,
        }).value;
        if (definition.builtIn && definition.name === "pr-result") {
          value = {
            ...(value as Record<string, unknown>),
            summary: "Mock run: no pull request was opened.",
          };
        }
      }
      outputs[port.name] = await graphMockStoreOutput(context, {
        port,
        value,
        definition,
        lineage,
        workspace: {
          headRef: workspace.headRef,
          ...(workspace.baseRef ? { baseRef: workspace.baseRef } : {}),
        },
      });
    }
    if (spec.sideEffect) {
      const resolved = graphSystemActionParams(node.action, node.params);
      const params = Object.fromEntries(
        Object.entries(resolved).filter(
          (entry): entry is [string, GraphScalarValue] => entry[1] !== undefined,
        ),
      );
      const { summary, details } = describe(node, params, inputs);
      const wouldRun: GraphMockWouldRun = {
        action: node.action,
        label: spec.label,
        summary,
        params,
        details,
        inputs: structuredClone(context.activation.inputs),
        outputs,
      };
      await this.deps.storage.graphEffects.recordSimulatedGraphEffect({
        runId: context.run.id,
        key: graphMockWouldRunKey(context.activation.key),
        action: node.action,
        nodeId: node.id,
        activation: context.activation.key,
        owner: this.deps.owner,
        data: { wouldRun },
      });
    }
    return { state: "complete", outputs };
  }
}

import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type {
  WorkflowActionsResult,
  WorkflowActionsSpec,
} from "@orkestrator/protocol/rich-interactions";
import type { StoredReceipt, StoredRequest } from "./store.js";

/**
 * The registry behind the `product-command` route.
 *
 * A card's label is presentation; the command a `commandId` names is defined
 * here, rechecks the live state it acts on, and goes through the owning
 * service's own authorization and validation. A command that cannot be served
 * on this backend reports itself unavailable with a reason, so the card shows
 * an explained disabled control instead of an action that fails.
 */

export type ProductCommandOutcome =
  | { state: "applied"; detail: string }
  | { state: "failed"; detail: string }
  | { state: "unknown"; detail: string };

export interface ProductCommandInvocation {
  request: StoredRequest;
  receipt: StoredReceipt;
  result: unknown;
}

export interface ProductCommand {
  id: string;
  /** Whether this backend can serve the command for this request at all. */
  availability(request: StoredRequest): { available: true } | { available: false; reason: string };
  run(invocation: ProductCommandInvocation): Promise<ProductCommandOutcome>;
}

/** The graph-run operations the workflow card's commands need (`GraphRunService`). */
export interface GraphCardExpectation {
  environmentId: string;
  revision: number;
  nodeId: string;
  activationKey: string;
}

export interface GraphRunControls {
  get(runId: string): Promise<GraphRun | null | undefined>;
  retry(runId: string, activationKey: string, expected: GraphCardExpectation): Promise<GraphRun>;
  cancel(runId: string, expected: GraphCardExpectation): Promise<GraphRun>;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * `workflow.retry` / `workflow.stop` for graph runs (`workflowId: "graph"`).
 * The node's `attemptId` is the activation key the card showed; the live run
 * must still be at the snapshot revision the user acted on, so a retry or
 * stop never lands on an attempt that started after the card was read.
 */
export function graphWorkflowCommands(
  graphRuns: () => GraphRunControls | undefined,
): ProductCommand[] {
  const availability = (request: StoredRequest) => {
    const spec = request.spec as WorkflowActionsSpec;
    if (request.kind !== "workflow-actions" || spec.workflowId !== "graph") {
      return {
        available: false as const,
        reason:
          "Only graph-run workflows have registered retry and stop operations on this backend.",
      };
    }
    if (!graphRuns())
      return { available: false as const, reason: "Graph runs are unavailable on this backend." };
    return { available: true as const };
  };
  const live = async (
    request: StoredRequest,
    receipt: StoredReceipt,
    result: WorkflowActionsResult,
  ) => {
    const controls = graphRuns();
    if (!controls) return { error: "Graph runs are unavailable on this backend." } as const;
    const runId = receipt.operationRunId;
    if (!runId || !result.attemptId)
      return { error: "The approved operation has no recorded graph target." } as const;
    const run = await controls.get(runId);
    if (!run) return { error: "The graph run no longer exists." } as const;
    if (run.environmentId !== request.owner.environmentId) {
      return { error: "The graph run belongs to another environment." } as const;
    }
    if (run.revision !== result.snapshotRevision) {
      return {
        error: `The run advanced (revision ${run.revision}, card showed ${result.snapshotRevision}); refresh the card before acting.`,
      } as const;
    }
    return {
      controls,
      runId,
      expected: {
        environmentId: request.owner.environmentId,
        revision: result.snapshotRevision,
        nodeId: result.nodeId,
        activationKey: result.attemptId,
      },
    } as const;
  };
  return [
    {
      id: "workflow.retry",
      availability,
      async run({ request, receipt, result }) {
        const typed = result as WorkflowActionsResult;
        const checked = await live(request, receipt, typed);
        if ("error" in checked) return { state: "failed", detail: checked.error ?? "Refused" };
        try {
          const run = await checked.controls.retry(
            checked.runId,
            checked.expected.activationKey,
            checked.expected,
          );
          return {
            state: "applied",
            detail: `Retry accepted; run is now at revision ${run.revision}.`,
          };
        } catch (error) {
          return { state: "failed", detail: message(error) };
        }
      },
    },
    {
      id: "workflow.stop",
      availability,
      async run({ request, receipt, result }) {
        const typed = result as WorkflowActionsResult;
        if (typed.confirmWholeRun !== true)
          return {
            state: "failed",
            detail: "Stopping the entire workflow run requires confirmation.",
          };
        const checked = await live(request, receipt, typed);
        if ("error" in checked) return { state: "failed", detail: checked.error ?? "Refused" };
        try {
          const run = await checked.controls.cancel(checked.runId, checked.expected);
          // A cancel request is not proof work stopped: report the run's own status.
          return run.status === "cancelled"
            ? { state: "applied", detail: "The run reports cancelled." }
            : {
                state: "unknown",
                detail: `Stop requested; the run reports ${run.status}. Work may still be running.`,
              };
        } catch (error) {
          return { state: "failed", detail: message(error) };
        }
      },
    },
  ];
}

export class ProductCommandRegistry {
  private readonly commands = new Map<string, ProductCommand>();

  register(command: ProductCommand): void {
    this.commands.set(command.id, command);
  }

  availability(
    commandId: string | undefined,
    request: StoredRequest,
  ): { available: true } | { available: false; reason: string } {
    const command = commandId ? this.commands.get(commandId) : undefined;
    if (!command) {
      return {
        available: false,
        reason:
          "No operation is registered for this action on this backend. Ask the agent instead.",
      };
    }
    return command.availability(request);
  }

  async run(
    commandId: string,
    invocation: ProductCommandInvocation,
  ): Promise<ProductCommandOutcome> {
    const command = this.commands.get(commandId);
    if (!command)
      return {
        state: "failed",
        detail: "No operation is registered for this action on this backend.",
      };
    try {
      return await command.run(invocation);
    } catch (error) {
      // The operation may have started: never claim failure for a thrown error.
      return { state: "unknown", detail: message(error) };
    }
  }
}

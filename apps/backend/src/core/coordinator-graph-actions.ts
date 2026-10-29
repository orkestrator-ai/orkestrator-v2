import { randomUUID } from "node:crypto";
import {
  GRAPH_LAUNCH_ERROR_CODES,
  GraphLaunchRequestError,
  parseGraphLaunchRequest,
  type GraphLaunchErrorCode,
  type GraphLaunchOptions,
  type GraphLaunchResult,
} from "@orkestrator/protocol/graphs/launch";
import {
  parseGraphTemplateRef,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import { isGraphRunTerminal, type GraphRun } from "@orkestrator/protocol/graphs/run";
import { graphRunSummary, type GraphRunSummary } from "@orkestrator/protocol/graphs/run-view";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type { CommandContext } from "./commands-context.js";
import {
  actionHash,
  coordinatorCaller,
  type CoordinatorCaller,
} from "./coordinator-action-scope.js";
import { graphLaunchRunId, GraphLaunchError } from "./graph-run-launch.js";

/**
 * The coordinator's graph commands (item 214, D6): list saved templates, read
 * one template's launch options, launch one, read and cancel the runs of its
 * project. There is deliberately no command that creates, saves, edits,
 * duplicates, imports or describes a template: a coordinator runs saved
 * graphs, it never authors them.
 *
 * A launch admits before it acts: a durable `graph-run` workflow association
 * is reserved under the coordinator's `requestId` (with the request's hash)
 * before the launch service is called, and the run id is derived from that
 * key, so a retry after a crash finds the run the first attempt created
 * rather than creating a second. The association is what gives the
 * coordinator one status wake when the run ends or waits for a person
 * (`coordinator-status-wakes.ts`). A launch the service refuses outright
 * created nothing, so its reservation is released and the same `requestId`
 * can be retried with a corrected request.
 *
 * Every result is content-free: ids, states, counts and template metadata,
 * never prompts, artifact payloads or file contents.
 */

/** Waiting and failed positions a coordinator may want to name, bounded. */
const MAX_LISTED_POSITIONS = 16;

function launches(context: CommandContext) {
  if (!context.graphLaunches) {
    throw new GraphLaunchError("disabled", "Graph launches are unavailable");
  }
  return context.graphLaunches;
}

function launchCode(error: unknown): GraphLaunchErrorCode | null {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && (GRAPH_LAUNCH_ERROR_CODES as readonly string[]).includes(code)
    ? (code as GraphLaunchErrorCode)
    : null;
}

/** The content-free summary a coordinator sees of a template. */
export function coordinatorGraphTemplateView(summary: GraphTemplateSummary) {
  return {
    ref: summary.ref,
    id: summary.id,
    name: summary.name,
    ...(summary.description ? { description: summary.description.slice(0, 500) } : {}),
    scope: summary.scope,
    revision: summary.revision,
    trust: summary.trust,
    ...(summary.engine ? { engine: summary.engine } : {}),
    launchable: summary.launchable,
    compile: {
      errors: summary.compile.errors,
      warnings: summary.compile.warnings,
      pendingAcknowledgements: summary.compile.pendingAcknowledgements,
      ...(summary.compile.cost ? { cost: summary.compile.cost } : {}),
    },
  };
}

/** What a coordinator needs to bind a launch, without the plan itself. */
export function coordinatorGraphLaunchView(options: GraphLaunchOptions) {
  return {
    template: coordinatorGraphTemplateView(options.summary),
    launchable: options.launchable,
    ...(options.blockedReason ? { blockedReason: options.blockedReason } : {}),
    roles: options.roles.map((role) => ({
      key: role.role.key,
      ...(role.role.label ? { label: role.role.label } : {}),
      panel: role.panel,
      maxPanel: role.maxPanel,
      ...(role.floor ? { floor: role.floor } : {}),
      steps: role.nodes,
      providers: role.providers.map((provider) => ({
        platform: provider.platform,
        tier: provider.tier,
        available: provider.available,
        ...(provider.unavailableReason ? { unavailableReason: provider.unavailableReason } : {}),
      })),
      default: role.default,
    })),
    parameters: options.parameters,
    params: options.params,
    inputs: options.inputs,
    environment: options.environment,
    ...(options.cost
      ? {
          cost: {
            agentSessions: options.cost.agentSessions,
            peakParallelism: options.cost.peakParallelism,
          },
        }
      : {}),
  };
}

/** A run as a coordinator sees it: the summary plus the positions worth naming. */
export function coordinatorGraphRunView(run: GraphRun): {
  run: GraphRunSummary;
  waitingFor: Array<{ activationKey: string; nodeId: string }>;
  failed: Array<{ activationKey: string; nodeId: string; error?: string }>;
  terminal: boolean;
} {
  const live = run.activations.filter((activation) => activation.state !== "superseded");
  return {
    run: graphRunSummary(run),
    waitingFor: live
      .filter((activation) => activation.state === "awaiting-human")
      .slice(0, MAX_LISTED_POSITIONS)
      .map((activation) => ({ activationKey: activation.key, nodeId: activation.nodeId })),
    failed: live
      .filter((activation) => activation.state === "failed")
      .slice(0, MAX_LISTED_POSITIONS)
      .map((activation) => ({
        activationKey: activation.key,
        nodeId: activation.nodeId,
        ...(activation.error ? { error: activation.error.slice(0, 400) } : {}),
      })),
    terminal: isGraphRunTerminal(run.status),
  };
}

async function projectRun(
  context: CommandContext,
  caller: CoordinatorCaller,
  runId: unknown,
): Promise<GraphRun> {
  if (typeof runId !== "string" || !runId || runId.length > 128) {
    throw new GraphLaunchError("invalid-request", "runId must be a graph run id");
  }
  const run = context.graphRuns ? await context.graphRuns.get(runId) : null;
  if (!run || run.projectId !== caller.projectId) {
    throw new GraphLaunchError("not-found", "The graph run does not exist in this project");
  }
  return run;
}

export function registerCoordinatorGraphActions(register: CommandRegistrar): void {
  const starts = new Map<string, Promise<unknown>>();

  register("list_coordinator_graph_templates", async ({ scope, ref, environmentId }, context) => {
    const caller = await coordinatorCaller(scope, context);
    if (ref !== undefined && ref !== null) {
      const parsed = parseGraphTemplateRef(ref);
      if ("error" in parsed) throw new GraphLaunchError("invalid-request", parsed.error);
      const options = await launches(context).options({
        ref: parsed,
        projectId: caller.projectId,
        ...(typeof environmentId === "string" && environmentId ? { environmentId } : {}),
      });
      return { template: coordinatorGraphLaunchView(options) };
    }
    if (!context.graphTemplates) {
      throw new GraphLaunchError("disabled", "Graph templates are unavailable");
    }
    const listed = await context.graphTemplates.list({ projectId: caller.projectId });
    return {
      templates: listed.templates.slice(0, 200).map(coordinatorGraphTemplateView),
      total: listed.templates.length,
    };
  });

  register("start_coordinator_graph_run", async ({ scope, requestId, request }, context) => {
    const caller = await coordinatorCaller(scope, context);
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 256) {
      throw new GraphLaunchError("invalid-request", "requestId must be 1 to 256 characters");
    }
    const stableRequestId = requestId.trim();
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new GraphLaunchError("invalid-request", "request must be a graph launch request");
    }
    const requested = request as Record<string, unknown>;
    // The launch's own idempotency key is scoped to this coordinator.
    const launchRequestId = `coordinator:${caller.coordinatorId}:${stableRequestId}`.slice(0, 128);
    let parsed;
    try {
      parsed = parseGraphLaunchRequest({
        ...requested,
        projectId: caller.projectId,
        requestId: launchRequestId,
      });
    } catch (error) {
      if (error instanceof GraphLaunchRequestError) {
        throw new GraphLaunchError("invalid-request", error.message);
      }
      throw error;
    }
    const runId = graphLaunchRunId(caller.projectId, launchRequestId);
    const payloadHash = actionHash(requested);
    const key = `${caller.coordinatorId}\0${stableRequestId}`;
    const existing = starts.get(key);
    if (existing) return existing;
    const started = (async () => {
      const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
        id: randomUUID(),
        projectId: caller.projectId,
        coordinatorId: caller.coordinatorId,
        conversationId: caller.conversationId,
        kind: "graph-run",
        // The run's identity is fixed before any launch I/O.
        resourceId: runId,
        requestId: stableRequestId,
        payloadHash,
        createdAt: new Date().toISOString(),
      });
      if (!receipt.claimed && !receipt.association.pending) {
        const run = await context.graphRuns?.get(receipt.association.resourceId);
        if (!run) throw new GraphLaunchError("not-found", "The associated graph run was not found");
        return {
          launch: {
            runId: run.id,
            projectId: run.projectId,
            ...(run.environmentId ? { environmentId: run.environmentId } : {}),
            status: run.status,
            template: {
              id: run.plan.template.id,
              revision: run.plan.template.revision,
              name: run.plan.template.name,
            },
            repeated: true,
          } satisfies GraphLaunchResult,
          associationId: receipt.association.id,
        };
      }
      if (!receipt.claimed) {
        throw new GraphLaunchError(
          "conflict",
          "This graph launch is already in progress; retry this requestId",
        );
      }
      let launched: GraphLaunchResult;
      try {
        launched = await launches(context).launch(parsed, { requestedBy: "coordinator" });
      } catch (error) {
        // A definite refusal created nothing: free the requestId for a corrected retry.
        const run = await context.graphRuns?.get(runId).catch(() => null);
        if (!run && launchCode(error) !== null) {
          await context.storage.coordinators
            .releasePendingCoordinatorWorkflowAssociation(receipt.association.id)
            .catch(() => false);
        }
        throw error;
      }
      await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
        receipt.association.id,
        launched.runId,
      );
      return { launch: launched, associationId: receipt.association.id };
    })().finally(() => {
      if (starts.get(key) === started) starts.delete(key);
    });
    starts.set(key, started);
    return started;
  });

  register("get_coordinator_graph_run", async ({ scope, runId }, context) => {
    const caller = await coordinatorCaller(scope, context);
    return coordinatorGraphRunView(await projectRun(context, caller, runId));
  });

  register("cancel_coordinator_graph_run", async ({ scope, runId }, context) => {
    const caller = await coordinatorCaller(scope, context);
    const run = await projectRun(context, caller, runId);
    if (isGraphRunTerminal(run.status) || run.status === "cancelling") {
      return { ...coordinatorGraphRunView(run), cancelled: false };
    }
    const cancelled = await context.graphRuns!.cancel(run.id);
    return { ...coordinatorGraphRunView(cancelled), cancelled: true };
  });
}

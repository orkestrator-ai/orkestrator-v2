import { registerCoordinatorMarkTools } from "./coordinator-marks.js";
import { hostTimeZone, isValidTimeZone } from "@orkestrator/protocol/schedule-time";
import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { describe, int, list, str, strictObject, toolInput, withDefault } from "../tool-schema.js";
import { coordinatorReplayFields } from "./results.js";
import {
  pollKey,
  workflowFingerprint,
  workflowListFingerprint,
  type CoordinatorPollGuard,
} from "./poll-guard.js";
import { registerControlReviewActions, workflowStatusWakeResult } from "./review-actions.js";
import { registerAccountTools } from "./account-tools.js";
import { registerCoordinatorSurfaceTools } from "./coordinator-surfaces.js";
import { registerCoordinatorWorkerTools } from "./coordinator-worker-tools.js";
import { registerCoordinatorWorkerTurnTools } from "./coordinator-worker-turns.js";
import { registerCoordinatorGoalTools } from "./coordinator-goals.js";
import { registerCoordinatorSuborkTool } from "./coordinator-suborks.js";
import { registerCoordinatorGraphTools } from "./graph-tools.js";
import { registerNodeFileTools } from "./node-files.js";
import { registerNodeTools, type NodeTarget } from "./nodes.js";
import {
  agentSelectionSchema,
  asArray,
  assertCoordinatorLaunchBaseOnBranch,
  buildPipelineSelection,
  buildReviewerSchema,
  buildStepOverrideSchema,
  isRecord,
  nodeIdField,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./tool-support.js";
import type { CoordinatorControlScope } from "./tools.js";
import { environmentSummary, type ControlMcpInvoker } from "../control-shared-actions.js";
import { normalizedWorkflow, workflowSummary } from "../control-workflow-summary.js";
import {
  coordinatorPrFields,
  nodePrHealth,
  prReadingFrom,
  pullRequestFollowSummary,
  thisNodePrHealth,
} from "../coordinator-pr-status.js";
import { featurePlanFollowSummary } from "../coordinator-feature-plan-status.js";
import { withScheduleActor } from "../commands-registry-scheduled-jobs.js";
import {
  BUILD_CANCELLED_ERROR,
  MAX_BUILD_PIPELINE_ITERATIONS,
} from "@orkestrator/protocol/build-pipeline";
import { registerScheduleTools, type ScheduleToolBackend } from "../scheduled-jobs/tools.js";
import {
  SCHEDULED_JOB_LIMITS,
  type ScheduleAccountSwitchGrant,
  type ScheduleOwner,
  type ScheduledJob,
  type ScheduledJobSummary,
} from "@orkestrator/protocol/scheduled-jobs";
import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorCallTurnOrigin,
  coordinatorDelegationBucket,
  coordinatorDelegationSummary,
  coordinatorRuntimeId,
  type CoordinatorDelegation,
} from "@orkestrator/protocol/coordinator";

/** An association's delegation as the snapshot's JSON carries it, if it has one. */
function recordedDelegation(association: JsonRecord): CoordinatorDelegation | null {
  const delegation = association.delegation;
  return isRecord(delegation) && typeof delegation.state === "string"
    ? (delegation as unknown as CoordinatorDelegation)
    : null;
}

/**
 * The tools only a coordinator credential has: repository context, workflow
 * associations, worker start and stop, build pipelines, Multi Review status
 * and cancellation, and the node, Multi Review and worker-surface tools
 * registered by their own modules. `createControlMcp` registers them through the same
 * capability-filtered server as the shared tools.
 */

export interface CoordinatorToolContext {
  invoke: ControlMcpInvoker;
  coordinatorScope: CoordinatorControlScope;
  onNode(nodeId: string | undefined): Promise<NodeTarget | null>;
  environmentInvoker(
    nodeId: string | undefined,
    environmentId: string,
  ): Promise<{ inv: ControlMcpInvoker; target: NodeTarget | null }>;
  onNodeResult(target: NodeTarget | null): JsonRecord;
  /** This conversation's poll guard; absent outside a coordinator request. */
  pollGuard?: CoordinatorPollGuard;
}

export function registerCoordinatorWorkflowTools(
  server: McpServer,
  {
    invoke,
    coordinatorScope,
    onNode,
    environmentInvoker,
    onNodeResult,
    pollGuard,
  }: CoordinatorToolContext,
): void {
  registerCoordinatorMarkTools(server);
  registerControlReviewActions(server, invoke, coordinatorScope);
  registerCoordinatorSurfaceTools(server, invoke, coordinatorScope);
  registerCoordinatorWorkerTools(server, invoke, coordinatorScope);
  registerCoordinatorWorkerTurnTools(server, invoke, coordinatorScope);
  registerCoordinatorGoalTools(server, invoke, coordinatorScope);
  registerCoordinatorSuborkTool(server, invoke, coordinatorScope);
  registerCoordinatorGraphTools(server, invoke, coordinatorScope);
  const nodeToolScope = {
    projectId: coordinatorScope.projectId,
    coordinatorId: coordinatorScope.coordinatorId,
    conversationId: coordinatorScope.conversationId,
  };
  registerNodeTools(server, invoke, nodeToolScope);
  registerNodeFileTools(server, invoke, nodeToolScope);
  const schedules = coordinatorScheduleBackend(invoke, coordinatorScope);
  registerScheduleTools(server, "coordinator", () => schedules);
  registerAccountTools(server, {
    invoke,
    coordinatorScope,
    onNode,
    onNodeResult,
    getSchedule: (scheduleId) => schedules.get(scheduleId),
  });
  server.registerTool(
    "get_repository_context",
    {
      title: "Get project repository context",
      description:
        "Read current branch, immutable HEAD commit, dirty state, and upstream freshness. This tool cannot mutate Git. With nodeId, of that node's copy of the project.",
      inputSchema: toolInput(Schema.Struct({ nodeId: nodeIdField })),
      annotations: readAnnotations(),
    },
    async ({ nodeId }) => {
      const target = await onNode(nodeId);
      const status = target
        ? await target.call<unknown>("get_project_git_status", { projectId: target.projectId })
        : await invoke<unknown>("get_project_git_status", {
            projectId: coordinatorScope.projectId,
          });
      if (!isRecord(status)) throw new Error("Repository status returned no result");
      return toolResult({ repository: status, ...onNodeResult(target) });
    },
  );
  server.registerTool(
    "list_workflows",
    {
      title: "List coordinator workflows",
      description:
        "List durable worker, build-pipeline, multi-review, graph-run, feature-plan and pull-request associations for this project with bounded authoritative summaries. A feature-plan association is one launch_feature_plan request: its resource is the plan as get_feature_plan reads it, and its follow says whether the reply was reported. A pull-request association is a worker's pull request this conversation follows for status wakes: its follow (what started it, the PR URL, whether it is still followed, the last state reported, a Resolve tab's progress) and the worker with its PR fields (prHasMergeConflicts, prMergeability, prChecks, prReadyToMerge). A worker association carries its delegation: state, bucket (needs-you, running or finished), workerTabId and waitingSince. To answer \"what am I waiting on?\", call this with openOnly instead of polling list_environments or list_agents.",
      inputSchema: toolInput(
        Schema.Struct({
          openOnly: Schema.optionalKey(
            describe(
              Schema.Boolean,
              "List only the workers this project's coordinator is still waiting on.",
            ),
          ),
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ openOnly }) => {
      const snapshot = await invoke<unknown>("get_project_coordinator", {
        projectId: coordinatorScope.projectId,
      });
      const recorded = isRecord(snapshot) ? asArray(snapshot.workflows) : [];
      // Filtered before the cap: rows are one per message, so an open delegation
      // can sit behind 200 newer ones.
      const associations = (
        openOnly
          ? recorded.filter((association) => {
              const delegation = recordedDelegation(association);
              return delegation && coordinatorDelegationBucket(delegation) !== "finished";
            })
          : recorded
      ).slice(-200);
      // One resolution per node, shared by that node's workflows.
      const invokers = new Map<string, Promise<ControlMcpInvoker | null>>();
      const invokerOn = (nodeId: string | undefined): Promise<ControlMcpInvoker | null> => {
        if (!nodeId) return Promise.resolve(invoke);
        let resolved = invokers.get(nodeId);
        if (!resolved) {
          resolved = onNode(nodeId)
            .then((target) => (target ? target.invoke : invoke))
            .catch(() => null);
          invokers.set(nodeId, resolved);
        }
        return resolved;
      };
      const workflows = await Promise.all(
        associations.map(async (association) => {
          const kind = association.kind;
          const resourceId =
            typeof association.resourceId === "string" ? association.resourceId : "";
          const nodeId = typeof association.nodeId === "string" ? association.nodeId : undefined;
          let resource: JsonRecord | null = null;
          try {
            const inv = await invokerOn(nodeId);
            if (association.pending === true || resourceId.startsWith("pending:")) {
              resource = { id: resourceId, status: "pending" };
            } else if (!inv) {
              resource = { id: resourceId, status: "unavailable" };
            } else if (kind === "environment") {
              const environment = await inv<unknown>("get_environment", {
                environmentId: resourceId,
              });
              resource = isRecord(environment) ? environmentSummary(environment) : null;
            } else if (kind === "pull-request") {
              // The worker, with the PR fields its environment reads carry.
              const environment = await inv<unknown>("get_environment", {
                environmentId: resourceId,
              });
              if (isRecord(environment)) {
                const health = nodeId
                  ? await nodePrHealth(invoke, nodeId)
                  : await thisNodePrHealth(invoke, coordinatorScope.projectId, [environment]);
                resource = {
                  ...environmentSummary(environment),
                  ...coordinatorPrFields(prReadingFrom(environment, health.get(resourceId))),
                };
              }
            } else if (kind === "build-pipeline") {
              const workflow = await inv<unknown>("get_build_pipeline", {
                pipelineId: resourceId,
              });
              const record = normalizedWorkflow(workflow);
              resource = record ? workflowSummary(record) : null;
            } else if (kind === "multi-review") {
              const workflow = await inv<unknown>("get_multi_review_workflow", {
                workflowId: resourceId,
              });
              const record = normalizedWorkflow(workflow);
              resource = record ? workflowSummary(record) : null;
            } else if (kind === "graph-run") {
              const run = await inv<unknown>("get_coordinator_graph_run", {
                scope: coordinatorScope,
                runId: resourceId,
              });
              resource = isRecord(run) && isRecord(run.run) ? run.run : null;
            } else if (kind === "feature-plan") {
              const plan = await inv<unknown>("get_coordinator_feature_plan", {
                scope: coordinatorScope,
                featureId: resourceId,
              });
              resource = isRecord(plan) ? plan : null;
            }
            // A kind this backend does not know keeps a null resource.
          } catch {
            resource = { id: resourceId, status: "unavailable" };
          }
          const delegation = recordedDelegation(association);
          return {
            id: association.id,
            kind,
            resourceId,
            ...(nodeId ? { nodeId } : {}),
            requestId: association.requestId,
            baseBranch: association.baseBranch,
            baseCommit: association.baseCommit,
            createdAt: association.createdAt,
            ...(delegation ? { delegation: coordinatorDelegationSummary(delegation) } : {}),
            ...(kind === "pull-request" ? { follow: pullRequestFollowSummary(association) } : {}),
            ...(kind === "feature-plan" ? { follow: featurePlanFollowSummary(association) } : {}),
            resource,
          };
        }),
      );
      const guidance = pollGuard?.(
        pollKey("list_workflows", openOnly === true),
        workflowListFingerprint(workflows),
      );
      return toolResult({ workflows, total: workflows.length, ...guidance });
    },
  );
  server.registerTool(
    "adopt_workflow",
    {
      title: "Adopt a coordinator workflow",
      description:
        "Associate an orphaned or closed-tab workflow with this conversation so terminal notifications can be delivered here.",
      inputSchema: toolInput(
        Schema.Struct({ associationId: str({ trim: true, min: 1, max: 200 }) }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ associationId }) => {
      const association = await invoke<unknown>("adopt_coordinator_workflow", {
        ...coordinatorScope,
        associationId,
      });
      if (!isRecord(association)) throw new Error("Workflow adoption returned no result");
      return toolResult({ association });
    },
  );
  const scopedWorkflow = async (
    kind: "build" | "review",
    workflowId: string,
    target: NodeTarget | null = null,
  ) => {
    const inv = target ? target.invoke : invoke;
    const raw = await inv<unknown>(
      kind === "build" ? "get_build_pipeline" : "get_multi_review_workflow",
      kind === "build" ? { pipelineId: workflowId } : { workflowId },
    );
    const record = normalizedWorkflow(raw);
    if (!record || record.projectId !== (target ? target.projectId : coordinatorScope.projectId)) {
      throw new Error(
        `${kind === "build" ? "Build pipeline" : "Multi-review"} not found in this project`,
      );
    }
    return record;
  };

  for (const [tool, command, title] of [
    ["start_environment", "start_environment_background", "Start a worker environment"],
    ["stop_environment", "stop_environment", "Stop a worker environment"],
  ] as const) {
    server.registerTool(
      tool,
      {
        title,
        description: `${title} that belongs to this coordinator's project.`,
        inputSchema: toolInput(
          Schema.Struct({
            environmentId: str({ trim: true, min: 1, max: 200 }),
            nodeId: nodeIdField,
          }),
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: tool === "stop_environment",
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ environmentId, nodeId }) => {
        const { inv, target } = await environmentInvoker(nodeId, environmentId);
        await inv("get_environment", { environmentId });
        await inv(command, { environmentId });
        return toolResult({ environmentId, ...onNodeResult(target), accepted: true });
      },
    );
  }

  server.registerTool(
    "start_build_pipeline",
    {
      title: "Start a structured build pipeline",
      description:
        "Start Orkestrator's durable build/review/verify/PR workflow, the build pipeline, in a new pipeline environment. This is the default for any work whose whole spec is known (a ticket, or settled with the user). Omit agentType, steps, reviewers and reviewPreparation to run the Build button's saved defaults: the same build agent, Multi Review reviewers, preparation/consolidation, fix, verify, PR and conflict-resolution models. Override one only when the user has asked for a specific agent, model, effort or reviewer set, or has given instructions for a step; any field you leave out keeps its saved default. Delivery follows the ticket's delivery policy when Verify passes (none means open-pr): set it on the ticket; push-no-pr pushes and stops, with no automatic review.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          taskId: describe(
            str({ trim: true, min: 1, max: 200 }),
            "The id of a ticket in this project. The build is linked to it and records its criteria results, status and pull request there. Create the ticket with create_ticket first if there is none. With nodeId, a ticket of this board is synced to that node first and built there under the same id (no relay through that node's coordinator); a ticket made only on that node works too.",
          ),
          environmentType: withDefault(Schema.Literals(["local", "containerized"]), "local"),
          baseBranch: str({ trim: true, min: 1, max: 500 }),
          baseCommit: str({ pattern: /^[0-9a-f]{40}$/i }),
          agentType: Schema.optionalKey(
            describe(
              Schema.Literals(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
              "Optional. Omit to use the user's saved build agent. Set only when the user asks for a specific agent.",
            ),
          ),
          steps: Schema.optionalKey(
            describe(
              strictObject({
                build: Schema.optionalKey(buildStepOverrideSchema),
                review: Schema.optionalKey(buildStepOverrideSchema),
                address: Schema.optionalKey(buildStepOverrideSchema),
                verify: Schema.optionalKey(buildStepOverrideSchema),
                pr: Schema.optionalKey(buildStepOverrideSchema),
                "resolve-conflicts": Schema.optionalKey(buildStepOverrideSchema),
              }),
              "Optional per-step overrides. Each step you name replaces only that step's saved default; omitted steps keep theirs. Set only when the user asks for a specific agent, model or effort for a step, or gives instructions for it. A step that names only instructions keeps its saved agent and model.",
            ),
          ),
          reviewers: Schema.optionalKey(
            describe(
              list(buildReviewerSchema, { min: 1, max: 32 }),
              "Optional. Replaces the saved Multi Review reviewer rows (and their saved focus) for the review step. Omit to use them. Set only when the user asks for specific reviewers, for a focus (lens) per reviewer, or for instructions per reviewer.",
            ),
          ),
          reviewPreparation: Schema.optionalKey(
            describe(
              buildStepOverrideSchema,
              "Optional. Replaces the saved preparation/consolidation model for a multi-reviewer review step. Omit to use it. Set only when the user asks for one, or for instructions for it; naming only instructions keeps the saved model.",
            ),
          ),
          taskTitle: str({ trim: true, min: 1, max: 500 }),
          taskSnapshot: Schema.Struct({
            title: str({ max: 500 }),
            description: str({ max: 100_000 }),
            acceptanceCriteria: str({ max: 100_000 }),
            comments: withDefault(
              list(Schema.Struct({ text: str({ max: 20_000 }) }), { max: 200 }),
              [],
            ),
            images: withDefault(
              list(Schema.Struct({ filename: str({ max: 500 }), data: str({ max: 5_000_000 }) }), {
                max: 20,
              }),
              [],
            ),
          }),
          existingEnvironmentId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          maxIterations: Schema.optionalKey(
            describe(
              int({
                min: 1,
                max: MAX_BUILD_PIPELINE_ITERATIONS,
                maxMessage: `maxIterations must be at most ${MAX_BUILD_PIPELINE_ITERATIONS}, the Build Pipeline's iteration limit.`,
              }),
              `Optional. Review/fix/verify rounds before the pipeline gives up, from 1 to ${MAX_BUILD_PIPELINE_ITERATIONS}. Omit for the default.`,
            ),
          ),
          nodeId: describe(
            nodeIdField,
            "Optional: run the build on that node's copy of this project (a nodeId from list_nodes); take baseBranch and baseCommit from get_launch_options with the same nodeId. Omit for this node.",
          ),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, baseBranch, baseCommit, nodeId, ...input }) => {
      const target = await onNode(nodeId);
      await assertCoordinatorLaunchBaseOnBranch(
        target ? target.invoke : invoke,
        target ? target.projectId : coordinatorScope.projectId,
        { baseBranch, baseCommit },
      );
      if (input.existingEnvironmentId && !target) {
        await invoke("get_environment", { environmentId: input.existingEnvironmentId });
      }
      const scoped = {
        ...input,
        projectId: coordinatorScope.projectId,
        delegationBaseBranch: baseBranch,
        delegationBaseCommit: baseCommit,
      };
      const workflow = target
        ? await invoke<unknown>("start_coordinator_node_build_pipeline", {
            scope: coordinatorScope,
            requestId,
            nodeId: target.nodeId,
            input: scoped,
          })
        : await invoke<unknown>("start_coordinator_build_pipeline", {
            scope: coordinatorScope,
            requestId,
            input: scoped,
          });
      const record = normalizedWorkflow(workflow);
      if (!record) throw new Error("Build pipeline returned no result");
      return toolResult({
        workflow: workflowSummary(record),
        ...onNodeResult(target),
        ...coordinatorReplayFields(workflow),
        ...(await workflowStatusWakeResult(invoke)),

        selection: buildPipelineSelection(record, input),
      });
    },
  );

  server.registerTool(
    "get_build_pipeline",
    {
      title: "Get a build pipeline",
      description:
        "Read authoritative state for a coordinator-associated build pipeline, including workers: every agent session it has started (build, each reviewer, preparation, consolidation, address, verify, fix, PR, conflict resolution, every round), each with its mailbox address, step, round, slot, label, agent, model and status (running, idle, finished, failed, cancelled). Message one worker with send_message (toEnvironmentId the pipeline environment, toTabId its address) and read its transcript with get_tab_transcript (tabId its address). verificationResult is the newest Verify verdict; criteria gives each acceptance criterion's result and evidence (failed first) and the commit Verify judged them on.",
      inputSchema: toolInput(
        Schema.Struct({
          pipelineId: str({ trim: true, min: 1, max: 200 }),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ pipelineId, nodeId }) => {
      const target = await onNode(nodeId);
      const workflow = workflowSummary(await scopedWorkflow("build", pipelineId, target), {
        criteriaDetail: true,
      });
      // Re-reading an unchanged workflow is polling it; its status wake is the answer.
      const guidance = pollGuard?.(
        pollKey("get_build_pipeline", pipelineId, nodeId),
        workflowFingerprint(workflow),
      );
      return toolResult({ workflow, ...onNodeResult(target), ...guidance });
    },
  );

  for (const [tool, command, title] of [
    ["pause_build_pipeline", "pause_build_pipeline", "Pause a build pipeline"],
    ["resume_build_pipeline", "resume_build_pipeline", "Resume a build pipeline"],
    ["cancel_build_pipeline", "cancel_build_pipeline", "Cancel a build pipeline"],
  ] as const) {
    server.registerTool(
      tool,
      {
        title,
        description:
          tool === "resume_build_pipeline"
            ? `${title} in this coordinator's project. Only a paused pipeline resumes; any other phase is refused with the phase. To carry on after a failed step, use restart_build_pipeline_step.`
            : `${title} in this coordinator's project.`,
        inputSchema: toolInput(
          Schema.Struct({
            pipelineId: str({ trim: true, min: 1, max: 200 }),
            nodeId: nodeIdField,
          }),
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: tool === "cancel_build_pipeline",
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ pipelineId, nodeId }) => {
        const target = await onNode(nodeId);
        const current = await scopedWorkflow("build", pipelineId, target);
        if (tool === "resume_build_pipeline" && current.phase !== "paused") {
          throw new Error(resumeRefusal(current));
        }
        const workflow = target
          ? await target.call<unknown>(command, { pipelineId }, `${command}:${pipelineId}`)
          : await invoke<unknown>(command, { pipelineId });
        const record = normalizedWorkflow(workflow);
        return toolResult({
          workflow: record ? workflowSummary(record) : { id: pipelineId },
          ...onNodeResult(target),
        });
      },
    );
  }

  server.registerTool(
    "restart_build_pipeline_step",
    {
      title: "Restart a build pipeline step",
      description:
        "Restart one step of a build pipeline in this project, as the step's Restart in the UI does, so a pipeline that failed for a passing reason (a usage limit, an unreachable agent) carries on without the user. Omit stepId to restart the step a failed pipeline failed in, or the current step of a paused, stalled or running one; or name a step by its worker address from get_build_pipeline. Earlier rounds and the work already committed are kept: the step reruns on the code as it is now, and that step's old session and any after it stay readable as a previous attempt. Set selection to rerun the step on another agent or model (the UI's Restart in…); the step keeps it for later rounds. A cancelled or completed pipeline, a failure before any step started, and an unknown step are refused. Code rewind and skipping a step are not offered here: they discard or bypass work, so they stay the user's. Retry with the same requestId after a lost answer: it never restarts twice. Pass nodeId for a pipeline on another connected node.",
      inputSchema: toolInput(
        strictObject({
          requestId: describe(
            str({ trim: true, min: 1, max: 256 }),
            "Stable key for this restart; reuse it only to retry the same call.",
          ),
          pipelineId: str({ trim: true, min: 1, max: 200 }),
          stepId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 300 }),
              "A worker address from get_build_pipeline (workers[].address). Omit for the failed or current step.",
            ),
          ),
          selection: Schema.optionalKey(
            describe(
              strictObject({
                ...agentSelectionSchema.fields,
                fastMode: Schema.optionalKey(Schema.Boolean),
              }),
              "Optional. Rerun the step on this agent and model (and reasoning effort, speed) from now on. Omit to keep the step's own selection.",
            ),
          ),
          nodeId: nodeIdField,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      // The command checks the node, the project and the pipeline itself.
      const result = await invoke<JsonRecord>("restart_coordinator_build_pipeline_step", {
        scope: {
          projectId: coordinatorScope.projectId,
          coordinatorId: coordinatorScope.coordinatorId,
          conversationId: coordinatorScope.conversationId,
        },
        input,
      });
      const failedAgain = result.phase === "failed";
      return toolResult({
        ...result,
        ...(failedAgain
          ? {
              nextStep:
                "The step failed again as soon as it restarted; read error. Do not retry until its cause has changed.",
            }
          : result.followed === true
            ? {
                delivery: "async",
                wake: "This conversation follows the pipeline: it will be woken by the usual status wake when the pipeline completes, fails or pauses for a decision.",
                nextStep: "The step restarted. Finish your turn now. Do not poll.",
              }
            : {
                nextStep:
                  "The step restarted. This conversation does not follow the pipeline, so nothing will wake you about it; adopt it with adopt_workflow to be told, or read it later with get_build_pipeline.",
              }),
      });
    },
  );

  server.registerTool(
    "get_multi_review",
    {
      title: "Get a multi-review",
      description: "Read authoritative state for a multi-review in this project.",
      inputSchema: toolInput(
        Schema.Struct({
          workflowId: str({ trim: true, min: 1, max: 200 }),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ workflowId, nodeId }) => {
      const target = await onNode(nodeId);
      const workflow = workflowSummary(await scopedWorkflow("review", workflowId, target));
      // Re-reading an unchanged workflow is polling it; its status wake is the answer.
      const guidance = pollGuard?.(
        pollKey("get_multi_review", workflowId, nodeId),
        workflowFingerprint(workflow),
      );
      return toolResult({ workflow, ...onNodeResult(target), ...guidance });
    },
  );

  for (const [tool, command, title] of [
    ["cancel_multi_review", "cancel_multi_review", "Cancel a multi-review"],
  ] as const) {
    server.registerTool(
      tool,
      {
        title,
        description: `${title} in the associated worker environment.`,
        inputSchema: toolInput(
          Schema.Struct({
            workflowId: str({ trim: true, min: 1, max: 200 }),
            nodeId: nodeIdField,
          }),
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workflowId, nodeId }) => {
        const target = await onNode(nodeId);
        await scopedWorkflow("review", workflowId, target);
        const workflow = target
          ? await target.call<unknown>(command, { workflowId }, `${command}:${workflowId}`)
          : await invoke<unknown>(command, { workflowId });
        const record = normalizedWorkflow(workflow);
        return toolResult({
          workflow: record ? workflowSummary(record) : { id: workflowId },
          ...onNodeResult(target),
        });
      },
    );
  }
}

/**
 * Schedules act for this conversation's coordinator. The owner is built from
 * the authenticated scope and the stored conversation role, never from tool
 * arguments, and travels to the command under an in-process symbol key.
 */
function coordinatorScheduleBackend(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): Required<ScheduleToolBackend> {
  const ownConversation = async (): Promise<{
    owner: ScheduleOwner;
    record: JsonRecord;
    workspace: JsonRecord;
  }> => {
    const snapshot = await invoke<unknown>("get_project_coordinator", {
      projectId: scope.projectId,
    });
    const workspace =
      isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
    const conversation = asArray(workspace?.conversations).find(
      (item) => isRecord(item) && item.id === scope.conversationId,
    );
    if (
      !workspace ||
      workspace.id !== scope.coordinatorId ||
      !isRecord(conversation) ||
      conversation.closedAt ||
      (conversation.role !== "side" && conversation.role !== "main")
    ) {
      throw new Error("The authenticated coordinator conversation is unavailable");
    }
    const role = conversation.role;
    return {
      owner: {
        kind: "coordinator",
        projectId: scope.projectId,
        coordinatorId: scope.coordinatorId,
        conversationId: scope.conversationId,
        role,
        // A schedule's fires are framed from the turn that set it.
        turnOrigin:
          coordinatorCallTurnOrigin(conversation.lastTurnOrigin, scope.turnOrigin) ?? "user",
      },
      record: conversation,
      workspace,
    };
  };
  const owner = async (): Promise<ScheduleOwner> => (await ownConversation()).owner;
  return {
    async defaultTimeZone() {
      const { workspace } = await ownConversation();
      return isValidTimeZone(workspace.userTimeZone)
        ? { zone: workspace.userTimeZone, source: "user" as const }
        : { zone: hostTimeZone(), source: "host" as const };
    },
    async selfTimer({ body, subject, authorize }) {
      const { owner: self, record } = await ownConversation();
      if (self.kind !== "coordinator") throw new Error("Only coordinators set self-timers");
      let grant: ScheduleAccountSwitchGrant | undefined;
      if (authorize) {
        if (self.role !== "main") {
          throw new Error(
            "Only the main coordinator switches accounts; a side agent cannot carry that permission",
          );
        }
        // The user's own word only: a turn started by mail, a workflow notice
        // or another timer cannot mint a permission to change billing.
        if (record.lastTurnOrigin !== "user") {
          throw new Error(
            "authorizeAccountSwitch is accepted only in a turn the user started with their own message. Set the timer without it; the switch will then ask the user to approve.",
          );
        }
        grant = {
          kind: "switch-agent-account",
          platforms: [...new Set(authorize.platforms)],
          ...(authorize.nodeIds?.length ? { nodeIds: [...new Set(authorize.nodeIds)] } : {}),
          userInstruction: authorize.userInstruction.slice(
            0,
            SCHEDULED_JOB_LIMITS.userInstructionMaxChars,
          ),
          grantedIn: "user-turn",
          grantedAt:
            typeof record.lastTurnStartedAt === "string"
              ? record.lastTurnStartedAt
              : new Date().toISOString(),
        };
      }
      return {
        kind: "action",
        action: "send_message",
        input: {
          // The main coordinator's address follows the main conversation; a
          // side agent's reminder comes back to that side conversation.
          toEnvironmentId:
            self.role === "main"
              ? COORDINATOR_MAIL_ADDRESS
              : coordinatorRuntimeId(self.coordinatorId, self.conversationId),
          ...(subject ? { subject } : {}),
          body,
          ...(grant ? { grant } : {}),
        },
      };
    },
    async create(input, requestId) {
      return invoke<{ schedule: ScheduledJob; replayed: boolean }>(
        "create_scheduled_job",
        withScheduleActor({ ...input, requestId }, await owner()),
      );
    },
    async list() {
      const listed = await invoke<{ schedules: ScheduledJobSummary[] }>(
        "list_scheduled_jobs",
        withScheduleActor({}, await owner()),
      );
      return listed.schedules;
    },
    async get(scheduleId) {
      return invoke<ScheduledJob>(
        "get_scheduled_job",
        withScheduleActor({ scheduleId }, await owner()),
      );
    },
    async cancel(scheduleId) {
      return invoke<{ scheduleId: string; deleted: boolean }>(
        "delete_scheduled_job",
        withScheduleActor({ scheduleId }, await owner()),
      );
    },
    async pause(scheduleId) {
      return invoke<ScheduledJob>(
        "pause_scheduled_job",
        withScheduleActor({ scheduleId }, await owner()),
      );
    },
    async resume(scheduleId) {
      return invoke<ScheduledJob>(
        "resume_scheduled_job",
        withScheduleActor({ scheduleId }, await owner()),
      );
    },
    async update(scheduleId, input) {
      return invoke<ScheduledJob>(
        "update_scheduled_job",
        withScheduleActor({ ...input, scheduleId }, await owner()),
      );
    },
  };
}

/** Why resume did nothing: a pipeline resumes only from paused. */
export function resumeRefusal(workflow: Record<string, unknown>): string {
  const phase = typeof workflow.phase === "string" ? workflow.phase : "unknown";
  const error = typeof workflow.error === "string" ? workflow.error : "";
  if (phase === "failed" && error.startsWith(BUILD_CANCELLED_ERROR)) {
    return "This build pipeline was cancelled, not paused, so it cannot be resumed or restarted. If you did not cancel it yourself, the user did: do not start another build for this ticket unless the user asks you to.";
  }
  if (phase === "failed") {
    return "This build pipeline is failed, not paused, so resume does nothing. To restart the step it failed in, call restart_build_pipeline_step with this pipelineId (omit stepId).";
  }
  if (phase === "complete") {
    return "This build pipeline is complete, not paused; there is nothing to resume.";
  }
  return `This build pipeline is ${phase}, not paused, so there is nothing to resume. It is already running; no action is needed.`;
}

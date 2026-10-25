import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  AUTO_FIX_FIELD_DESCRIPTION,
  AUTO_PR_FIELD_DESCRIPTION,
  MULTI_REVIEW_AUTOMATION_DESCRIPTION,
  registerControlReviewActions,
  reviewSelection,
  workflowStatusWakeResult,
} from "./control-mcp-review-actions.js";
import { registerNodeFileTools } from "./control-mcp-node-files.js";
import { registerNodeTools, type NodeTarget } from "./control-mcp-nodes.js";
import {
  agentSelectionSchema,
  asArray,
  assertCoordinatorLaunchBaseOnBranch,
  buildPipelineSelection,
  buildStepSchema,
  isRecord,
  nodeIdField,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./control-mcp-tool-support.js";
import type { CoordinatorControlScope } from "./control-mcp-tools.js";
import { environmentSummary, type ControlMcpInvoker } from "./control-shared-actions.js";
import { normalizedWorkflow, workflowSummary } from "./control-workflow-summary.js";
import { withScheduleActor } from "./commands-registry-scheduled-jobs.js";
import { registerScheduleTools, type ScheduleToolBackend } from "./scheduled-jobs/tools.js";
import type {
  ScheduleOwner,
  ScheduledJob,
  ScheduledJobSummary,
} from "@orkestrator/protocol/scheduled-jobs";

/**
 * The tools only a coordinator credential has: repository context, workflow
 * associations, worker start and stop, build pipelines, Multi Review status
 * and cancellation, and the node and Multi Review launch tools registered by
 * their own modules. `createControlMcp` registers them through the same
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
}

export function registerCoordinatorWorkflowTools(
  server: McpServer,
  { invoke, coordinatorScope, onNode, environmentInvoker, onNodeResult }: CoordinatorToolContext,
): void {
  registerControlReviewActions(server, invoke, coordinatorScope);
  const nodeToolScope = {
    projectId: coordinatorScope.projectId,
    coordinatorId: coordinatorScope.coordinatorId,
    conversationId: coordinatorScope.conversationId,
  };
  registerNodeTools(server, invoke, nodeToolScope);
  registerNodeFileTools(server, invoke, nodeToolScope);
  registerScheduleTools(server, "coordinator", () =>
    coordinatorScheduleBackend(invoke, coordinatorScope),
  );
  server.registerTool(
    "get_repository_context",
    {
      title: "Get project repository context",
      description:
        "Read current branch, immutable HEAD commit, dirty state, and upstream freshness. This tool cannot mutate Git. With nodeId, of that node's copy of the project.",
      inputSchema: z.object({ nodeId: nodeIdField }),
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
        "List durable worker, build-pipeline, and multi-review associations for this project with bounded authoritative summaries.",
      inputSchema: z.object({}),
      annotations: readAnnotations(),
    },
    async () => {
      const snapshot = await invoke<unknown>("get_project_coordinator", {
        projectId: coordinatorScope.projectId,
      });
      const associations = isRecord(snapshot) ? asArray(snapshot.workflows).slice(-200) : [];
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
            }
          } catch {
            resource = { id: resourceId, status: "unavailable" };
          }
          return {
            id: association.id,
            kind,
            resourceId,
            ...(nodeId ? { nodeId } : {}),
            requestId: association.requestId,
            baseBranch: association.baseBranch,
            baseCommit: association.baseCommit,
            createdAt: association.createdAt,
            resource,
          };
        }),
      );
      return toolResult({ workflows, total: workflows.length });
    },
  );
  server.registerTool(
    "adopt_workflow",
    {
      title: "Adopt a coordinator workflow",
      description:
        "Associate an orphaned or closed-tab workflow with this conversation so terminal notifications can be delivered here.",
      inputSchema: z.object({ associationId: z.string().trim().min(1).max(200) }),
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
        inputSchema: z.object({
          environmentId: z.string().trim().min(1).max(200),
          nodeId: nodeIdField,
        }),
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
        "Start Orkestrator's durable build/review/verify/PR workflow in a disposable worker environment. Omit agentType, steps, reviewers and reviewPreparation to run the Build button's saved defaults: the same build agent, Multi Review reviewers, preparation/consolidation, fix, verify, PR and conflict-resolution models. Override one only when the user has asked for a specific agent, model, effort or reviewer set; any field you leave out keeps its saved default.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        taskId: z.string().trim().min(1).max(200),
        environmentType: z.enum(["local", "containerized"]).default("local"),
        baseBranch: z.string().trim().min(1).max(500),
        baseCommit: z.string().regex(/^[0-9a-f]{40}$/i),
        agentType: z
          .enum(["claude", "codex", "cursor", "grok", "opencode", "pi"])
          .optional()
          .describe(
            "Optional. Omit to use the user's saved build agent. Set only when the user asks for a specific agent.",
          ),
        steps: z
          .object({
            build: buildStepSchema.optional(),
            review: buildStepSchema.optional(),
            address: buildStepSchema.optional(),
            verify: buildStepSchema.optional(),
            pr: buildStepSchema.optional(),
            "resolve-conflicts": buildStepSchema.optional(),
          })
          .strict()
          .optional()
          .describe(
            "Optional per-step overrides. Each step you name replaces only that step's saved default; omitted steps keep theirs. Set only when the user asks for a specific agent, model or effort for a step.",
          ),
        reviewers: z
          .array(buildStepSchema)
          .min(1)
          .max(32)
          .optional()
          .describe(
            "Optional. Replaces the saved Multi Review reviewer rows for the review step. Omit to use them. Set only when the user asks for specific reviewers.",
          ),
        reviewPreparation: buildStepSchema
          .optional()
          .describe(
            "Optional. Replaces the saved preparation/consolidation model for a multi-reviewer review step. Omit to use it. Set only when the user asks for one.",
          ),
        taskTitle: z.string().trim().min(1).max(500),
        taskSnapshot: z.object({
          title: z.string().max(500),
          description: z.string().max(100_000),
          acceptanceCriteria: z.string().max(100_000),
          comments: z
            .array(z.object({ text: z.string().max(20_000) }))
            .max(200)
            .default([]),
          images: z
            .array(z.object({ filename: z.string().max(500), data: z.string().max(5_000_000) }))
            .max(20)
            .default([]),
        }),
        existingEnvironmentId: z.string().trim().min(1).max(200).optional(),
        maxIterations: z.number().int().min(1).max(20).optional(),
        nodeId: nodeIdField.describe(
          "Optional: run the build on that node's copy of this project (a nodeId from list_nodes); take baseBranch and baseCommit from get_launch_options with the same nodeId. Omit for this node.",
        ),
      }),
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
        ...(await workflowStatusWakeResult(invoke)),

        selection: buildPipelineSelection(record, input),
      });
    },
  );

  server.registerTool(
    "get_build_pipeline",
    {
      title: "Get a build pipeline",
      description: "Read authoritative state for a coordinator-associated build pipeline.",
      inputSchema: z.object({
        pipelineId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ pipelineId, nodeId }) => {
      const target = await onNode(nodeId);
      return toolResult({
        workflow: workflowSummary(await scopedWorkflow("build", pipelineId, target)),
        ...onNodeResult(target),
      });
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
        description: `${title} in this coordinator's project.`,
        inputSchema: z.object({
          pipelineId: z.string().trim().min(1).max(200),
          nodeId: nodeIdField,
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: tool === "cancel_build_pipeline",
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ pipelineId, nodeId }) => {
        const target = await onNode(nodeId);
        await scopedWorkflow("build", pipelineId, target);
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
    "start_multi_review",
    {
      title: "Start a multi-review",
      description:
        "Low-level build-gated recovery primitive: starts backend work only and does NOT create/select a root tab or reproduce the UI button. Prefer launch_multi_review for a complete environment-level Multi Review action. Omit reviewers, reviewModel and fixModel to use the user's saved Multi Review defaults; set them only when the user asks for specific models. " +
        MULTI_REVIEW_AUTOMATION_DESCRIPTION +
        " The result's selection reports the rows and auto-actions that will run and which were requested.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        buildPipelineId: z.string().trim().min(1).max(200),
        environmentId: z.string().trim().min(1).max(200),
        targetBranch: z.string().trim().min(1).max(500),
        reviewInstruction: z.string().max(100_000).optional(),
        reviewers: z
          .array(agentSelectionSchema)
          .min(1)
          .max(32)
          .optional()
          .describe(
            "Optional. Omit to use the user's saved reviewer rows. Set only when the user asks for specific reviewers.",
          ),
        reviewModel: agentSelectionSchema
          .optional()
          .describe(
            "Optional. Omit to use the user's saved preparation/consolidation model. Set only when the user asks for one.",
          ),
        fixModel: agentSelectionSchema
          .optional()
          .describe(
            "Optional. Omit to use the user's saved fix model. Set only when the user asks for one.",
          ),
        autoFix: z.boolean().optional().describe(AUTO_FIX_FIELD_DESCRIPTION),
        autoPr: z.boolean().optional().describe(AUTO_PR_FIELD_DESCRIPTION),
        nodeId: nodeIdField,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, buildPipelineId, nodeId, ...input }) => {
      const target = await onNode(nodeId);
      if (!target) await invoke("get_environment", { environmentId: input.environmentId });
      const workflow = target
        ? await invoke<unknown>("start_coordinator_node_multi_review", {
            scope: coordinatorScope,
            requestId,
            nodeId: target.nodeId,
            buildPipelineId,
            input: { ...input, projectId: coordinatorScope.projectId },
          })
        : await invoke<unknown>("start_coordinator_multi_review", {
            scope: coordinatorScope,
            requestId,
            buildPipelineId,
            input: { ...input, projectId: coordinatorScope.projectId },
          });
      const record = normalizedWorkflow(workflow);
      if (!record) throw new Error("Multi-review returned no result");
      return toolResult({
        workflow: workflowSummary(record),
        ...onNodeResult(target),
        selection: reviewSelection(record, input),
        ...(await workflowStatusWakeResult(invoke)),
      });
    },
  );

  server.registerTool(
    "get_multi_review",
    {
      title: "Get a multi-review",
      description: "Read authoritative state for a multi-review in this project.",
      inputSchema: z.object({
        workflowId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ workflowId, nodeId }) => {
      const target = await onNode(nodeId);
      return toolResult({
        workflow: workflowSummary(await scopedWorkflow("review", workflowId, target)),
        ...onNodeResult(target),
      });
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
        inputSchema: z.object({
          workflowId: z.string().trim().min(1).max(200),
          nodeId: nodeIdField,
        }),
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
): ScheduleToolBackend {
  const owner = async (): Promise<ScheduleOwner> => {
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
      kind: "coordinator",
      projectId: scope.projectId,
      coordinatorId: scope.coordinatorId,
      conversationId: scope.conversationId,
      role,
    };
  };
  return {
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
    async cancel(scheduleId) {
      return invoke<{ scheduleId: string; deleted: boolean }>(
        "delete_scheduled_job",
        withScheduleActor({ scheduleId }, await owner()),
      );
    },
  };
}

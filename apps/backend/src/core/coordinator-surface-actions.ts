import { createHash } from "node:crypto";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { isFeaturePlanningRecord } from "@orkestrator/protocol/feature-planning";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  coordinatorCaller,
  withCoordinatorReceipt,
  type CoordinatorCaller,
} from "./coordinator-action-scope.js";
import { beginWorkerTabClose } from "./worker-tab-close-admission.js";
import { launchWorkerPr } from "./coordinator-pr.js";
import {
  coordinatorNodeTarget,
  RETRY_SAME_REQUEST,
  withRetryAdvice,
  type CoordinatorNodeTarget,
} from "./commands-registry-coordinator-nodes.js";
import type { Environment } from "./models.js";
import { resolveProjectGitRoot } from "./project-git-root.js";
import { applyRootChanges, listRootChanges } from "./root-changes.js";
import {
  editWorkerTabWithTeardown,
  launchWorkerTerminal,
  openWorkerBrowser,
  optionalText,
  parseBrowserOpen,
  parseTabEdit,
  parseTerminalLaunch,
  requireProjectWorker,
  surfaceRecord as record,
} from "./worker-surface-runs.js";

/**
 * Backend commands behind the coordinator's worker surfaces (todo 0142):
 * terminal and tmux launch, browser preview launch and navigation, tab
 * editing, the PR tab, feature-plan launch, and the request
 * to copy the checkout's uncommitted changes into a worker.
 *
 * Every command takes the authenticated `scope` the Control MCP server built
 * from the coordinator's credential, revalidates it, and acts only on a
 * worker environment of that project, never on the project home (the
 * checkout the coordinator may only read). Mutations that create something
 * take the caller's `requestId` through `withCoordinatorReceipt`.
 *
 * The terminal, browser, tab-edit and PR commands also take `nodeId` for a
 * worker on a connected node (todo 0395): the receipt stays here, the node
 * validates its own worker and runs the work through its `*_controller_*`
 * command, with IDs derived from this receipt's key so a retry replays there.
 */

type JsonRecord = Record<string, unknown>;

/** A disposable worker of the caller's project: never the checkout itself. */
export async function requireCoordinatorWorker(
  context: CommandContext,
  caller: CoordinatorCaller,
  environmentId: unknown,
): Promise<Environment> {
  return requireProjectWorker(context, caller.projectId, environmentId);
}

/** A stable ID per coordinator request, so a retry finds what the first attempt made. */
function requestKey(caller: CoordinatorCaller, requestId: string): string {
  return createHash("sha256")
    .update(`${caller.coordinatorId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24);
}

/** The connected node `nodeId` names; none for this node, even by its own ID. */
async function remoteNode(
  context: CommandContext,
  caller: CoordinatorCaller,
  nodeId: string | undefined,
): Promise<CoordinatorNodeTarget | undefined> {
  return nodeId && (await context.nodes?.status())?.nodeId !== nodeId
    ? coordinatorNodeTarget(context, caller.projectId, nodeId)
    : undefined;
}

export function registerCoordinatorSurfaceActions(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const run = async <T>(context: CommandContext, command: string, args: JsonRecord): Promise<T> => {
    const handler = dependencies.commands.get(command);
    if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
    return (await handler(args, context)) as T;
  };

  register("launch_coordinator_terminal", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the terminal input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const remote = await remoteNode(context, caller, optionalText(input.nodeId, "nodeId", 200));
    const environmentId = remote
      ? asNonBlankString(input.environmentId, "environmentId")
      : (await requireCoordinatorWorker(context, caller, input.environmentId)).id;
    const launch = parseTerminalLaunch(input);
    if (remote) await remote.environment(environmentId);
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "launch-terminal",
        payload: { environmentId, ...launch, ...(remote ? { nodeId: remote.nodeId } : {}) },
      },
      async () => {
        const key = requestKey(caller, requestId);
        if (remote)
          return {
            ...(await withRetryAdvice(RETRY_SAME_REQUEST, () =>
              remote.call<JsonRecord>(
                "launch_controller_terminal",
                {
                  projectId: remote.projectId,
                  environmentId,
                  input: { ...launch, tabType: launch.type },
                  key,
                },
                `terminal:${caller.coordinatorId}:${requestId}`,
              ),
            )),
            nodeId: remote.nodeId,
          };
        // Namespaced, so a coordinator request can never collide with the
        // renderer's or another coordinator's job of the same name.
        return launchWorkerTerminal(context, run, environmentId, launch, `coordinator:${key}`);
      },
    );
  });

  register("open_coordinator_browser", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the browser input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const remote = await remoteNode(context, caller, optionalText(input.nodeId, "nodeId", 200));
    const environmentId = remote
      ? asNonBlankString(input.environmentId, "environmentId")
      : (await requireCoordinatorWorker(context, caller, input.environmentId)).id;
    const open = parseBrowserOpen(input, environmentId);
    if (remote) await remote.environment(environmentId);
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "open-browser",
        payload: { environmentId, ...open, ...(remote ? { nodeId: remote.nodeId } : {}) },
      },
      async () => {
        const key = requestKey(caller, requestId);
        if (remote)
          return {
            ...(await withRetryAdvice(RETRY_SAME_REQUEST, () =>
              remote.call<JsonRecord>(
                "open_controller_browser",
                {
                  projectId: remote.projectId,
                  environmentId,
                  url: open.address,
                  ...(open.tabId ? { tabId: open.tabId } : {}),
                  ...(open.title ? { title: open.title } : {}),
                  key,
                },
                `browser:${caller.coordinatorId}:${requestId}`,
              ),
            )),
            nodeId: remote.nodeId,
          };
        return openWorkerBrowser(context, environmentId, open, key);
      },
    );
  });

  register("edit_coordinator_worker_tab", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the tab edit");
    const remote = await remoteNode(context, caller, optionalText(input.nodeId, "nodeId", 200));
    const environmentId = remote
      ? asNonBlankString(input.environmentId, "environmentId")
      : (await requireCoordinatorWorker(context, caller, input.environmentId)).id;
    const edit = parseTabEdit(input);
    if (!remote) return editWorkerTabWithTeardown(context, run, environmentId, edit);
    await remote.environment(environmentId);
    const release =
      edit.operation === "close"
        ? beginWorkerTabClose(environmentId, edit.tabId, remote.nodeId)
        : () => {};
    try {
      // Delegations to that node's workers are kept here, not on the node.
      if (
        edit.operation === "close" &&
        (await context.storage.coordinators.listOpenCoordinatorDelegations()).some(
          (association) =>
            association.kind === "environment" &&
            association.nodeId === remote.nodeId &&
            association.resourceId === environmentId &&
            association.delegation?.workerTabId === edit.tabId,
        )
      )
        throw new Error("A coordinator is waiting on this tab's report; it cannot be closed now");
      return {
        ...(await withRetryAdvice(
          "Retry the same edit: it states an end state, so repeating it is harmless.",
          () =>
            remote.call<JsonRecord>("edit_controller_worker_tab", {
              projectId: remote.projectId,
              environmentId,
              ...edit,
            }),
        )),
        nodeId: remote.nodeId,
      };
    } finally {
      release();
    }
  });

  /**
   * The Create PR button for a worker: the PR tab is the only place a
   * coordinator's work becomes a pull request, after review. A build
   * pipeline raises its own while active; forks and terminal leftovers can publish.
   */
  register("create_coordinator_pr", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the pull request input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const environmentId = asNonBlankString(input.environmentId, "environmentId");
    const targetBranch = optionalText(input.targetBranch, "targetBranch", 500);
    const nodeId = optionalText(input.nodeId, "nodeId", 200);
    const remote = await remoteNode(context, caller, nodeId);
    if (remote) await remote.environment(environmentId);
    else await requireCoordinatorWorker(context, caller, environmentId);
    return withCoordinatorReceipt(
      context,
      caller,
      { requestId, action: "create-pr", payload: { environmentId, targetBranch, nodeId } },
      async () => {
        const launch = {
          environmentId,
          projectId: remote?.projectId ?? caller.projectId,
          targetBranch,
          requestId: `coordinator-pr:${requestKey(caller, requestId)}`,
        };
        if (remote)
          return {
            ...(await withRetryAdvice(RETRY_SAME_REQUEST, () =>
              remote.call<JsonRecord>("create_controller_pr", launch, launch.requestId),
            )),
            nodeId: remote.nodeId,
          };
        return launchWorkerPr(context, dependencies, launch);
      },
    );
  });

  register("launch_coordinator_feature_plan", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the feature plan input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const message = asNonBlankString(input.message, "message").trim();
    if (message.length > 100_000) throw new Error("message must be at most 100000 characters");
    const featureId = optionalText(input.featureId, "featureId", 200);
    if (featureId) {
      const plan = await context.storage.kanban.getFeaturePlan(featureId);
      if (!plan || plan.projectId !== caller.projectId)
        throw new Error("Feature plan not found in this project");
    }
    return withCoordinatorReceipt(
      context,
      caller,
      { requestId, action: "launch-feature-plan", payload: { featureId, message } },
      async () => {
        const key = requestKey(caller, requestId);
        const id =
          featureId ??
          (
            await context.storage.kanban.createFeaturePlan(
              caller.projectId,
              `feature-coordinator-${key}`,
            )
          ).id;
        const operationId = `planning-coordinator-${key}`;
        const plan = await context.storage.kanban.getFeaturePlan(id);
        if (
          plan?.planning?.operationId === operationId ||
          plan?.messages.some((entry) => entry.id === operationId)
        )
          return { featureId: id, phase: plan.planning?.phase ?? null, reused: true };
        const planning = await run<JsonRecord>(context, "start_feature_planning", {
          featureId: id,
          operationId,
          kind: "feature",
          userMessage: message,
        });
        return { featureId: id, phase: planning.phase ?? null, reused: false };
      },
    );
  });

  register("get_coordinator_feature_plan", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const featureId = asNonBlankString(args.featureId, "featureId");
    const plan = await context.storage.kanban.getFeaturePlan(featureId);
    if (!plan || plan.projectId !== caller.projectId)
      throw new Error("Feature plan not found in this project");
    const lastAssistant = plan.messages.findLast((entry) => entry.role === "assistant");
    return {
      featureId: plan.id,
      title: plan.title,
      status: plan.status,
      summary: plan.summary.slice(0, 4_000),
      stories: plan.stories.slice(0, 100).map((story) => ({ id: story.id, title: story.title })),
      planning: isFeaturePlanningRecord(plan.planning)
        ? {
            phase: plan.planning.phase,
            ...(plan.planning.failure ? { failure: plan.planning.failure.message } : {}),
          }
        : null,
      lastReply: lastAssistant ? lastAssistant.content.slice(0, 8_000) : null,
      ...(plan.buildPipelineId ? { buildPipelineId: plan.buildPipelineId } : {}),
    };
  });

  register("request_coordinator_root_changes", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the request");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const environment = await requireCoordinatorWorker(context, caller, input.environmentId);
    const reason = asNonBlankString(input.reason, "reason").trim().slice(0, 500);
    const files = input.files === undefined ? [] : input.files;
    if (
      !Array.isArray(files) ||
      files.length > 200 ||
      !files.every(
        (file) =>
          typeof file === "string" &&
          file.length > 0 &&
          file.length <= 512 &&
          !file.startsWith("/") &&
          !file.split("/").includes(".."),
      )
    )
      throw new Error("files are up to 200 paths inside the project");
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
      caller.coordinatorId,
    );
    const conversation = workspace?.conversations.find((item) => item.id === caller.conversationId);
    if (!conversation) throw new Error("This coordinator conversation has no mailbox");
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "request-root-changes",
        payload: { environmentId: environment.id, files, reason },
      },
      async () => {
        const self = await run<JsonRecord>(context, "get_node_status", {});
        const created = await run<JsonRecord>(context, "create_node_action_request", {
          requestId: `root-changes-coordinator-${requestKey(caller, requestId)}`,
          kind: "apply-root-changes",
          targets: [
            {
              nodeId: self.nodeId,
              nodeName: "this machine",
              environmentId: environment.id,
              environmentName: environment.name,
              projectId: caller.projectId,
              ...(files.length ? { files } : {}),
            },
          ],
          requestedBy: {
            coordinatorEnvironmentId: coordinatorRuntimeId(
              caller.coordinatorId,
              caller.conversationId,
            ),
            coordinatorTabId: conversation.tabId,
            projectId: caller.projectId,
          },
          reason,
        });
        return {
          environmentId: environment.id,
          approvalRequestId: created.requestId,
          state: "pending",
        };
      },
    );
  });

  /** The user's file picker: the checkout's changed files. Read-only. */
  register("list_project_root_changes", async (args, context) => {
    const projectId = asNonBlankString(args.projectId, "projectId");
    return listRootChanges(await resolveProjectGitRoot(context.storage, projectId));
  });

  /**
   * Runs only from an approved `apply-root-changes` request (and the
   * coordinator's command invoker refuses it by name): the user picked these
   * paths.
   */
  register("apply_project_root_changes", async (args, context) => {
    const paths = args.paths;
    if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string"))
      throw new Error("Expected paths");
    return applyRootChanges(context, {
      projectId: asNonBlankString(args.projectId, "projectId"),
      environmentId: asNonBlankString(args.environmentId, "environmentId"),
      paths: paths as string[],
    });
  });
}

import { createHash } from "node:crypto";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_TAB_EDIT_OPERATIONS,
  COORDINATOR_TERMINAL_TAB_TYPES,
  type CoordinatorTabEditOperation,
  type CoordinatorTerminalTabType,
} from "@orkestrator/protocol/coordinator-surfaces";
import { isFeaturePlanningRecord } from "@orkestrator/protocol/feature-planning";
import {
  formatPreviewIntentUri,
  parsePreviewUrlIntent,
} from "@orkestrator/protocol/preview-services";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { isTabTeardownKind, type TabTeardownKind } from "@orkestrator/protocol/tab-teardown";
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
import { coordinatorNodeTarget } from "./commands-registry-coordinator-nodes.js";
import type { Environment } from "./models.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { resolveProjectGitRoot } from "./project-git-root.js";
import { applyRootChanges, listRootChanges } from "./root-changes.js";
import { editWorkerTab, openWorkerBrowserTab } from "./worker-tab-actions.js";

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
 */

type JsonRecord = Record<string, unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected ${name}`);
  return value as JsonRecord;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Expected ${name} of 1-${max} characters`);
  return value.trim();
}

/** A disposable worker of the caller's project: never the checkout itself. */
export async function requireCoordinatorWorker(
  context: CommandContext,
  caller: CoordinatorCaller,
  environmentId: unknown,
): Promise<Environment> {
  const id = asNonBlankString(environmentId, "environmentId");
  const environment = await context.storage.getEnvironment(id);
  if (!environment || environment.projectId !== caller.projectId)
    throw new Error("Environment not found in this project");
  if (isProjectHomeEnvironment(environment))
    throw new Error("Coordinator credential cannot act on the project checkout");
  if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting")
    throw new Error("The worker environment is being deleted");
  return environment;
}

/** A stable ID per coordinator request, so a retry finds what the first attempt made. */
function requestKey(caller: CoordinatorCaller, requestId: string): string {
  return createHash("sha256")
    .update(`${caller.coordinatorId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24);
}

/** Which `teardown_tab` kind closes a tab's resources, if it owns any. */
function teardownKind(tab: JsonRecord): TabTeardownKind | null {
  if (tab.type === "claude-tmux") return "claude-tmux";
  if (tab.type === "agent-native") {
    const data = tab.nativeAgentData as JsonRecord | undefined;
    const kind = `${String(data?.platform)}-native`;
    return isTabTeardownKind(kind) ? kind : null;
  }
  return typeof tab.type === "string" &&
    ["plain", "root", "claude", "codex", "cursor", "grok", "opencode", "pi"].includes(tab.type)
    ? "terminal"
    : null;
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
    const environment = await requireCoordinatorWorker(context, caller, input.environmentId);
    const tabType = input.tabType ?? "plain";
    if (!(COORDINATOR_TERMINAL_TAB_TYPES as readonly unknown[]).includes(tabType))
      throw new Error(`tabType must be one of ${COORDINATOR_TERMINAL_TAB_TYPES.join(", ")}`);
    const type = tabType as CoordinatorTerminalTabType;
    const command = optionalText(input.command, "command", 100_000);
    const prompt = optionalText(input.prompt, "prompt", 100_000);
    const title = optionalText(input.title, "title", 200);
    const model = optionalText(input.model, "model", 512);
    const reasoningEffort = optionalText(input.reasoningEffort, "reasoningEffort", 128);
    if (type === "plain" && !command) throw new Error("A plain terminal needs a command to run");
    if (type !== "plain" && command)
      throw new Error("command is for plain terminals; agent terminals take prompt and model");
    if (type === "plain" && (prompt || model || reasoningEffort))
      throw new Error("prompt, model and reasoningEffort are for agent terminals");
    if (type === "grok" && (prompt || model || reasoningEffort))
      throw new Error("grok terminals do not support prompt, model or reasoningEffort options");
    const payload = {
      environmentId: environment.id,
      type,
      command,
      prompt,
      title,
      model,
      reasoningEffort,
    };
    return withCoordinatorReceipt(
      context,
      caller,
      { requestId, action: "launch-terminal", payload },
      async () => {
        let data: string | undefined;
        if (type === "plain") data = `${command}\n`;
        else if (type !== "claude-tmux") {
          const line = buildTerminalAgentLaunchCommand({
            tabType: type,
            initialPrompt: prompt,
            model,
            reasoningEffort,
          });
          if (!line) throw new Error(`${type} does not support terminal launch`);
          data = `${line}\n`;
        }
        const launched = await run<JsonRecord>(context, "launch_terminal_job", {
          // Namespaced, so a coordinator request can never collide with the
          // renderer's or another coordinator's job of the same name.
          requestId: `coordinator:${requestKey(caller, requestId)}`,
          environmentId: environment.id,
          tabType: type,
          ...(title ? { title } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(type === "claude-tmux"
            ? {
                ...(prompt ? { initialPrompt: prompt } : {}),
                ...(model ? { model } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
              }
            : {}),
          activateTab: true,
        });
        return {
          environmentId: environment.id,
          tabId: launched.tabId,
          tabType: type,
          status: launched.status,
        };
      },
    );
  });

  register("open_coordinator_browser", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the browser input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const environment = await requireCoordinatorWorker(context, caller, input.environmentId);
    const address = asNonBlankString(input.url, "url").trim();
    // The same rule the browser tab applies to an agent's link: a loopback
    // http(s) address of a service this worker runs, never the open web.
    parsePreviewUrlIntent(address, "agent-link", environment.id);
    const tabId = optionalText(input.tabId, "tabId", 200);
    const title = optionalText(input.title, "title", 200);
    const url = formatPreviewIntentUri({
      environmentId: environment.id,
      source: "agent-link",
      url: address,
    });
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "open-browser",
        payload: { environmentId: environment.id, address, tabId, title },
      },
      async () => {
        const key = requestKey(caller, requestId);
        const ui = await openWorkerBrowserTab(context.storage, {
          environmentId: environment.id,
          ...(tabId ? { tabId } : {}),
          newTabId: `browser-coordinator-${key}`,
          url,
          navigationRequestId: `coordinator-${key}`,
          ...(title ? { title } : {}),
        });
        return { environmentId: environment.id, url: address, ui };
      },
    );
  });

  register("edit_coordinator_worker_tab", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = record(args.input, "the tab edit");
    const environment = await requireCoordinatorWorker(context, caller, input.environmentId);
    const tabId = asNonBlankString(input.tabId, "tabId");
    const operation = input.operation;
    if (!(COORDINATOR_TAB_EDIT_OPERATIONS as readonly unknown[]).includes(operation))
      throw new Error(`operation must be one of ${COORDINATOR_TAB_EDIT_OPERATIONS.join(", ")}`);
    const toPaneId = optionalText(input.toPaneId, "toPaneId", 200);
    if (operation === "move" && !toPaneId) throw new Error("move needs toPaneId (see list_tabs)");
    const close = async (tab: JsonRecord) => {
      const delegations = await context.storage.coordinators.listOpenCoordinatorDelegations();
      if (
        delegations.some(
          (association) =>
            association.kind === "environment" &&
            association.nodeId === undefined &&
            association.resourceId === environment.id &&
            association.delegation?.workerTabId === tabId,
        )
      )
        throw new Error("A coordinator is waiting on this tab's report; it cannot be closed now");
      const native = await nativeTurnPhase(
        context,
        environment.id,
        { kind: "leaf", tabs: [tab] },
        tabId,
      );
      if (native && native !== "idle" && native !== "error")
        throw new Error(
          "The agent in this tab is busy or waiting on a person; it cannot be closed now",
        );
      const kind = teardownKind(tab);
      if (kind) {
        // Retain the tab and resource identity until teardown succeeds. The
        // teardown command journals its own intent and retains conversation history.
        const sessionId =
          kind === "terminal"
            ? tab.backendTerminalSessionId
            : kind.endsWith("-native") &&
                !["claude-native", "codex-native", "opencode-native"].includes(kind)
              ? (tab.nativeAgentData as JsonRecord | undefined)?.sessionId
              : undefined;
        await run(context, "teardown_tab", {
          environmentId: environment.id,
          tabId,
          kind,
          ...(typeof sessionId === "string" ? { sessionId } : {}),
        });
      }
    };
    const release = operation === "close" ? beginWorkerTabClose(environment.id, tabId) : () => {};
    let releaseAgentAdmission: (() => void) | undefined;
    try {
      if (operation === "close")
        releaseAgentAdmission = context.runtime.environments.fence.beginTabClose(environment.id);
      const edited = await editWorkerTab(context.storage, {
        environmentId: environment.id,
        tabId,
        operation: operation as CoordinatorTabEditOperation,
        ...(toPaneId ? { toPaneId } : {}),
        beforeClose: close,
      });
      const { closed: _closed, ...result } = edited;
      return { environmentId: environment.id, ...result };
    } finally {
      releaseAgentAdmission?.();
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
    // Resolve an explicit self ID just as the other node-qualified tools do.
    const remote =
      nodeId && (await context.nodes?.status())?.nodeId !== nodeId
        ? await coordinatorNodeTarget(context, caller.projectId, nodeId)
        : undefined;
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
            ...(await remote.call<JsonRecord>("create_controller_pr", launch, launch.requestId)),
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

async function nativeTurnPhase(
  context: CommandContext,
  environmentId: string,
  root: unknown,
  tabId: string,
): Promise<string | null> {
  const visit = (node: unknown): JsonRecord | null => {
    if (!node || typeof node !== "object") return null;
    const value = node as JsonRecord;
    if (value.kind === "leaf" && Array.isArray(value.tabs))
      return (
        (value.tabs.find((tab) => (tab as JsonRecord)?.id === tabId) as JsonRecord | undefined) ??
        null
      );
    if (value.kind === "split" && Array.isArray(value.children))
      return value.children.map(visit).find(Boolean) ?? null;
    return null;
  };
  const tab = visit(root);
  const platform = (tab?.nativeAgentData as JsonRecord | undefined)?.platform;
  if (tab?.type !== "agent-native") return null;
  if (typeof platform !== "string" || !context.nativeAgents) return "unknown";
  try {
    const projection = await context.nativeAgents.getProjection({
      environmentId,
      agent: platform as import("./models.js").NativeAgentProvider,
      logicalSessionKey: `env-${environmentId}:${tabId}`,
      messageLimit: 1,
    });
    if (!projection) return null;
    if (projection.interactions.length > 0) return "waiting";
    return projection.turn.phase;
  } catch {
    // An unreadable session is refused rather than closed under a turn.
    return "unknown";
  }
}

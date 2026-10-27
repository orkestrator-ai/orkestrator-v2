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
import {
  isLoopedReviewTerminalPhase,
  isLoopedReviewWorkflow,
  type LoopedReviewAgent,
  type StartLoopedReviewInput,
} from "@orkestrator/protocol/review-workflow";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { isTabTeardownKind, type TabTeardownKind } from "@orkestrator/protocol/tab-teardown";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString, stripLoopedReviewSnapshotSecrets } from "./commands-helpers.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  coordinatorCaller,
  withCoordinatorReceipt,
  type CoordinatorCaller,
} from "./coordinator-action-scope.js";
import {
  multiReviewDefaultRows,
  readLaunchModelCatalog,
  savedLaunchSettings,
} from "./coordinator-launch-defaults.js";
import type { Environment } from "./models.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { resolveProjectGitRoot } from "./project-git-root.js";
import { applyRootChanges, listRootChanges } from "./root-changes.js";
import { editWorkerTab, openLoopedReviewTab, openWorkerBrowserTab } from "./worker-tab-actions.js";

/**
 * Backend commands behind the coordinator's worker surfaces (todo 0142):
 * terminal and tmux launch, browser preview launch and navigation, tab
 * editing, looped review, feature-plan launch, and the request to copy the
 * checkout's uncommitted changes into a worker.
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
    // A close is refused while a turn runs or a person is being asked
    // something in that tab, and while this or another coordinator waits on
    // the tab: closing would cut off the report it is waiting for.
    let refusal: string | null = null;
    if (operation === "close") {
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
        refusal = "A coordinator is waiting on this tab's report; it cannot be closed now";
      const layout = await context.storage.getPaneLayout(environment.id);
      const native = await nativeTurnPhase(context, environment.id, layout?.root, tabId);
      if (!refusal && native && native !== "idle" && native !== "error")
        refusal = "The agent in this tab is busy or waiting on a person; it cannot be closed now";
    }
    const edited = await editWorkerTab(context.storage, {
      environmentId: environment.id,
      tabId,
      operation: operation as CoordinatorTabEditOperation,
      ...(toPaneId ? { toPaneId } : {}),
      beforeClose: () => {
        if (refusal) throw new Error(refusal);
      },
    });
    const { closed, ...result } = edited;
    if (closed) {
      if (closed.type === "browser") {
        // The preview view lives in the desktop process; a renderer that has
        // the worker loaded drops it when the tab leaves the layout.
      } else {
        const kind = teardownKind(closed);
        if (kind) {
          const sessionId =
            kind === "terminal" && typeof closed.backendTerminalSessionId === "string"
              ? closed.backendTerminalSessionId
              : kind.endsWith("-native") &&
                  !["claude-native", "codex-native", "opencode-native"].includes(kind)
                ? ((closed.nativeAgentData as JsonRecord | undefined)?.sessionId as
                    | string
                    | undefined)
                : undefined;
          // The conversation is retained: teardown closes the provider session
          // through its retain-history path and never deletes it.
          await run(context, "teardown_tab", {
            environmentId: environment.id,
            tabId,
            kind,
            ...(sessionId ? { sessionId } : {}),
          });
        }
      }
    }
    return { environmentId: environment.id, ...result };
  });

  register("start_coordinator_looped_review", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
    const service = context.loopedReviews;
    const input = record(args.input, "the looped review input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const environment = await requireCoordinatorWorker(context, caller, input.environmentId);
    const agent = input.agent as LoopedReviewAgent | undefined;
    const model = optionalText(input.model, "model", 512);
    const reasoningEffort = optionalText(input.reasoningEffort, "reasoningEffort", 128);
    if ((model || reasoningEffort) && !agent)
      throw new Error("model and reasoningEffort need agent");
    const targetBranch = optionalText(input.targetBranch, "targetBranch", 500);
    const reviewInstruction =
      input.reviewInstruction === undefined
        ? undefined
        : typeof input.reviewInstruction === "string" && input.reviewInstruction.length <= 100_000
          ? input.reviewInstruction
          : (() => {
              throw new Error("reviewInstruction must be at most 100000 characters");
            })();
    const allowance = input.allowance;
    if (allowance !== undefined && (!Number.isInteger(allowance) || (allowance as number) < 1))
      throw new Error("allowance must be a positive integer");
    const payload = {
      environmentId: environment.id,
      agent,
      model,
      reasoningEffort,
      targetBranch,
      reviewInstruction,
      allowance,
    };
    const result = await withCoordinatorReceipt(
      context,
      caller,
      { requestId, action: "start-looped-review", payload },
      async (receipt) => {
        // A retry after a crash between start and receipt reattaches to the
        // review that attempt started, rather than refusing or starting twice.
        const active = (await context.storage.listLoopedReviewWorkflows(environment.id)).find(
          (entry) =>
            isLoopedReviewWorkflow(entry.snapshot) &&
            !isLoopedReviewTerminalPhase(entry.snapshot.phase),
        );
        let workflowId: string;
        let reused = false;
        if (
          active &&
          isLoopedReviewWorkflow(active.snapshot) &&
          active.snapshot.createdAt >= receipt.createdAt
        ) {
          workflowId = active.id;
          reused = true;
        } else {
          const config = await context.storage.loadConfig();
          // Omitted, the agent and model are the Review action's saved
          // default, the row the Looped review dialog opens on.
          const defaults = agent
            ? undefined
            : multiReviewDefaultRows(
                savedLaunchSettings(config, caller.projectId, environment),
                await readLaunchModelCatalog(
                  dependencies.commands.get("get_native_agent_model_catalog"),
                  environment.id,
                  context,
                ),
              ).reviewers[0];
          const start: StartLoopedReviewInput = {
            environmentId: environment.id,
            projectId: caller.projectId,
            agent: (agent ?? defaults!.agent) as LoopedReviewAgent,
            model: model ?? defaults?.model ?? "default",
            ...((reasoningEffort ?? defaults?.reasoningEffort)
              ? { reasoningEffort: reasoningEffort ?? defaults?.reasoningEffort }
              : {}),
            targetBranch:
              targetBranch ?? (config.repositories[caller.projectId]?.prBaseBranch || "main"),
            ...(reviewInstruction !== undefined
              ? reviewInstruction.trim()
                ? { reviewInstruction }
                : {}
              : config.global.reviewInstruction
                ? { reviewInstruction: config.global.reviewInstruction }
                : {}),
            ...(allowance !== undefined ? { allowance: allowance as number } : {}),
          };
          workflowId = (await service.start(start)).id;
        }
        let ui: JsonRecord;
        try {
          ui = {
            ...(await openLoopedReviewTab(context.storage, {
              environmentId: environment.id,
              workflowId,
            })),
          };
        } catch (error) {
          ui = {
            status: "unavailable",
            recovery: `The looped review is running, but its tab could not be opened: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return { environmentId: environment.id, workflowId, reused, ui };
      },
    );
    const saved = await context.storage.getLoopedReviewWorkflow(result.workflowId as string);
    return {
      ...result,
      workflow:
        saved && isLoopedReviewWorkflow(saved.snapshot) ? loopedSummary(saved.snapshot) : null,
    };
  });

  for (const [name, verb] of [
    ["get_coordinator_looped_review", "get"],
    ["cancel_coordinator_looped_review", "cancel"],
  ] as const) {
    register(name, async (args, context) => {
      const caller = await coordinatorCaller(args.scope, context);
      const workflowId = asNonBlankString(args.workflowId, "workflowId");
      const saved = await context.storage.getLoopedReviewWorkflow(workflowId);
      if (!saved || !isLoopedReviewWorkflow(saved.snapshot))
        throw new Error("Looped review not found in this project");
      await requireCoordinatorWorker(context, caller, saved.snapshot.environmentId);
      if (verb === "get") return { workflow: loopedSummary(saved.snapshot) };
      if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
      const cancelled = stripLoopedReviewSnapshotSecrets(
        await context.loopedReviews.cancel(workflowId),
      );
      return { workflow: loopedSummary(cancelled) };
    });
  }

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
      async (receipt) => {
        let id = featureId;
        if (!id) {
          // A retry after a crash finds the plan its first attempt created
          // (made after the receipt): reattach if planning already started,
          // or start planning on it if it is still the empty new plan.
          const mine = (await context.storage.kanban.getFeaturePlans(caller.projectId)).filter(
            (plan) => plan.createdAt >= receipt.createdAt,
          );
          const started = mine.find(
            (plan) =>
              (isFeaturePlanningRecord(plan.planning) && plan.planning.userMessage === message) ||
              plan.messages.some((entry) => entry.role === "user" && entry.content === message),
          );
          if (started)
            return {
              featureId: started.id,
              phase: started.planning?.phase ?? null,
              reused: true,
            };
          const empty = mine.find(
            (plan) => !plan.planning && !plan.messages.some((entry) => entry.role === "user"),
          );
          id = empty?.id ?? (await context.storage.kanban.createFeaturePlan(caller.projectId)).id;
        }
        const planning = await run<JsonRecord>(context, "start_feature_planning", {
          featureId: id,
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

/** What the coordinator needs to follow a looped review, without its sessions. */
function loopedSummary(workflow: {
  id: string;
  environmentId: string;
  phase: string;
  error?: string;
  rounds?: unknown;
  pr?: unknown;
}): JsonRecord {
  return {
    id: workflow.id,
    environmentId: workflow.environmentId,
    phase: workflow.phase,
    ...(workflow.error ? { error: workflow.error } : {}),
    rounds: Array.isArray(workflow.rounds) ? workflow.rounds.length : 0,
    ...(workflow.pr && typeof workflow.pr === "object"
      ? {
          pr: {
            status: (workflow.pr as JsonRecord).status,
            ...((workflow.pr as JsonRecord).url ? { url: (workflow.pr as JsonRecord).url } : {}),
          },
        }
      : {}),
  };
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
  if (tab?.type !== "agent-native" || typeof platform !== "string" || !context.nativeAgents)
    return null;
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

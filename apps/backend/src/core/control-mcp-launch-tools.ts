/**
 * The shared launch tools: `get_launch_options`, `launch_environment` and
 * `launch_job`, with the launch-base and launch-default helpers they use.
 */
import { STARTUP_AGENT_TAB_ID } from "@orkestrator/protocol/tab-initial-prompt";
import { savedControlJobAgent } from "./control-job-identity.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  COORDINATOR_MAIL_ADDRESS,
  COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
} from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_JOB_DELEGATION_INSTRUCTION,
  createCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { Schema } from "effect";
import { describe, str, toolInput, withDefault } from "./tool-schema.js";
import { coordinatorReplayFields } from "./control-mcp-results.js";
import {
  defaultLaunchAgent,
  launchEnvironmentCreateInput,
  launchOptions,
  launchSelectionReport,
  launchSettingsTiers,
  platformLaunchDefault,
  resolveLaunchAgent,
  validateSelection,
} from "./control-shared-actions.js";
import {
  assertCoordinatorLaunchBaseOnBranch,
  isRecord,
  nodeIdField,
  nonEmptyString,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./control-mcp-tool-support.js";
import {
  operatorLaunchEnvironment,
  operatorLaunchJob,
  operatorNode,
} from "./control-mcp-operator-tools.js";
import { withCoordinatorDelegationPresentation } from "./coordinator-delegation-authority.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";
import {
  MAX_PROMPT_LENGTH,
  COORDINATOR_WORKER_PROMPT_NOTE,
  asyncDelegationResult,
  tryOpenNodeDelegation,
  tryOpenCoordinatorDelegation,
  type ControlMcpToolContext,
} from "./control-mcp-tools-shared.js";

/**
 * The default launch base: the newest commit of the repository's configured
 * base branch, which is what a normal environment launch starts from too.
 */
function coordinatorLaunchBaseFromTip(tip: JsonRecord | null, failureReason?: string): JsonRecord {
  const branch = nonEmptyString(tip?.branch);
  const commit = nonEmptyString(tip?.commit);
  const available = Boolean(branch && commit);
  const unavailableReason =
    failureReason ??
    (available
      ? undefined
      : (nonEmptyString(tip?.unavailableReason) ?? "The base branch could not be resolved"));
  const fetchError = nonEmptyString(tip?.fetchError);
  return {
    baseBranch: branch,
    baseCommit: commit,
    available,
    source: "base-branch",
    ...(nonEmptyString(tip?.ref) ? { ref: tip?.ref } : {}),
    ...(available ? { remoteState: tip?.fetched === true ? "fresh" : "stale" } : {}),
    ...(fetchError ? { fetchError } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    requiredFor: "launch_environment",
    guidance: available
      ? "Default launch base: the latest commit of the repository's base branch. Pass baseBranch and baseCommit unchanged to launch_environment and start_build_pipeline. Refresh launch options before retrying if a launch reports a stale base."
      : `The repository's base branch could not be resolved${unavailableReason ? ` (${unavailableReason})` : ""}. Report this blocked state instead of guessing; use checkoutBase only if the user asks to build on the current checkout.`,
  };
}

/** The coordinator's own checkout, offered only as an explicit alternative. */
function checkoutLaunchBaseFromStatus(
  status: JsonRecord | null,
  failureReason?: string,
): JsonRecord {
  const branch = nonEmptyString(status?.branch);
  const commit = nonEmptyString(status?.headCommit);
  const available = Boolean(branch && commit);
  let unavailableReason = failureReason;
  if (!unavailableReason && !available) {
    if (!status) unavailableReason = "Repository status is not available yet";
    else if (status.unborn === true) unavailableReason = "unborn repository";
    else if (status.detached === true || !branch) unavailableReason = "detached HEAD";
    else unavailableReason = "checkout has no HEAD commit";
  }
  return {
    baseBranch: branch,
    baseCommit: commit,
    available,
    source: "checkout",
    ...(unavailableReason ? { unavailableReason } : {}),
    guidance: available
      ? "The coordinator checkout's current branch and HEAD. Use it instead of coordinatorBase only when the user asks to build on the current checkout. Uncommitted changes are never included."
      : `The current checkout does not expose a launchable branch and commit${unavailableReason ? ` (${unavailableReason})` : ""}.`,
  };
}

/**
 * What every model and effort field says about leaving it out.
 *
 * Coordinators used to fill these from `get_launch_options` on every call, so
 * every worker ran a model and effort the user never chose. The schema text is
 * what the model reads at the moment it decides, so the rule lives here too.
 */
export const LAUNCH_DEFAULTS_GUIDANCE =
  "Omit agent, modelId and reasoningId to use the user's configured defaults; set them only when the user asks for a specific agent, model or effort, or agrees to one the task needs.";
const AGENT_DESCRIPTION =
  "Optional. Omit to use the user's default agent (defaults.agent in get_launch_options). Set only when the user asks for a specific agent.";
const AGENT_PLATFORM_FIELD = Schema.optionalKey(
  describe(
    Schema.Literals(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
    AGENT_DESCRIPTION,
  ),
);
const MODEL_ID_DESCRIPTION =
  "Optional. Omit to use the user's configured default model. Set only when the user asks for a specific model.";
const REASONING_ID_DESCRIPTION =
  "Optional; requires modelId. Omit to use the user's configured default effort. Set only when the user asks for a specific effort.";
const FAST_MODE_DESCRIPTION =
  "Optional. Omit to use the user's configured speed. Set only when the user asks for one.";
/** Turns the per-agent defaults into lookups for marking catalogue rows. */
function launchDefaultsSummary(
  tiers: Parameters<typeof platformLaunchDefault>[0],
  enabledAgents: readonly AgentPlatform[],
  models: readonly AgentModel[],
): JsonRecord {
  return {
    agent: defaultLaunchAgent(tiers, enabledAgents),
    byAgent: Object.fromEntries(
      enabledAgents.map((agent) => [agent, platformLaunchDefault(tiers, agent, models)]),
    ),
    guidance: LAUNCH_DEFAULTS_GUIDANCE,
  };
}

/** The worker's half of the contract: one report, at the end, then stop. */
function workerAsyncContract(): string {
  return (
    `The coordinator is idle while you work and is woken once, when your turn ends. Send exactly one report — use reply_message for the message that assigned this work, or send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}" (no toTabId needed) — and then end your turn. ` +
    `Do not send progress updates: any message you send before your turn ends is held and delivered together with your final report.`
  );
}

/** A legacy result from another machine names it. */
function withNodeTag<T extends { structuredContent?: unknown; content: unknown[] }>(
  result: T,
  tag: JsonRecord,
): T {
  if (!("nodeId" in tag) || !isRecord(result.structuredContent) || "isError" in result)
    return result;
  const structuredContent = { ...result.structuredContent, ...tag };
  return {
    ...result,
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  };
}

/**
 * Launch options with the user's defaults, and the selection report every
 * launch carries, for one invoker.
 */
function launchSettingsHelpers(invoke: ControlMcpInvoker) {
  /**
   * Launch options plus what an omitted model and effort resolve to.
   *
   * The defaults are advisory, so a settings read that fails returns the
   * options unchanged instead of failing discovery.
   */
  const launchOptionsWithDefaults = async (
    projectId: string,
    environmentId?: string,
    inv: ControlMcpInvoker = invoke,
  ): Promise<JsonRecord> => {
    const options = await launchOptions(inv, projectId, environmentId);
    let defaults: JsonRecord;
    try {
      const environment = environmentId
        ? await inv<unknown>("get_environment", { environmentId })
        : undefined;
      const tiers = await launchSettingsTiers(
        inv,
        projectId,
        isRecord(environment) ? environment : undefined,
      );
      defaults = launchDefaultsSummary(tiers, options.enabledAgents, options.models);
    } catch {
      return options as unknown as JsonRecord;
    }
    const byAgent = defaults.byAgent as Partial<Record<AgentPlatform, { modelId: string | null }>>;
    const models = options.models.map((model) => {
      const defaultId = byAgent[model.platform]?.modelId;
      return defaultId && (model.id === defaultId || model.aliases?.includes(defaultId))
        ? { ...model, isDefault: true }
        : model;
    });
    return { ...options, models, defaults };
  };

  /** The selection a launch will run, reported so an override is never silent. */
  const selectionReport = async (
    projectId: string,
    environment: JsonRecord | undefined,
    models: readonly AgentModel[],
    input: { agent: AgentPlatform; modelId?: string; reasoningId?: string },
    filterInheritedEffort = true,
    inv: ControlMcpInvoker = invoke,
  ): Promise<JsonRecord> => {
    try {
      const tiers = await launchSettingsTiers(inv, projectId, environment);
      return { selection: launchSelectionReport(tiers, models, input, filterInheritedEffort) };
    } catch {
      return {};
    }
  };
  return { launchOptionsWithDefaults, selectionReport };
}

/** `get_launch_options`: the agents, models and launch bases a launch can use. */
export function registerLaunchOptionsTool(
  server: McpServer,
  { invoke, coordinatorScope, operator, onNode, onNodeResult }: ControlMcpToolContext,
): void {
  const { launchOptionsWithDefaults } = launchSettingsHelpers(invoke);

  server.registerTool(
    "get_launch_options",
    {
      title: "Get agent launch options",
      description:
        "List enabled agents and validated model choices for a project. defaults names what a launch runs when modelId and reasoningId are omitted, and isDefault marks each agent's default model. Omit them to use these defaults.",
      inputSchema: toolInput(
        Schema.Struct({
          projectId: str({ trim: true, min: 1, max: 200 }),
          environmentId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          nodeId: nodeIdField,
        }),
      ),
      annotations: coordinatorScope
        ? { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
        : readAnnotations(),
    },
    async ({ projectId, environmentId, nodeId }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        return toolResult({
          ...(await launchOptionsWithDefaults(projectId, environmentId, node.invoke)),
          ...node.tag,
        });
      }
      const target = await onNode(nodeId);
      if (target) {
        // That node's agents and models, its defaults, and its copy's base branch.
        if (environmentId) await target.environment(environmentId);
        const options = await launchOptionsWithDefaults(
          target.projectId,
          environmentId,
          target.invoke,
        );
        const [coordinatorBase, checkoutBase] = await Promise.all([
          target
            .call<unknown>("get_project_base_branch_tip", { projectId: target.projectId })
            .then((tip) => coordinatorLaunchBaseFromTip(isRecord(tip) ? tip : null))
            .catch((error: unknown) =>
              coordinatorLaunchBaseFromTip(
                null,
                `Base branch is unavailable on ${target.nodeName}: ${
                  error instanceof Error ? error.message : "base branch read failed"
                }`,
              ),
            ),
          target
            .call<unknown>("get_project_git_status", { projectId: target.projectId })
            .then((status) => checkoutLaunchBaseFromStatus(isRecord(status) ? status : null))
            .catch((error: unknown) =>
              checkoutLaunchBaseFromStatus(
                null,
                `Repository status is unavailable on ${target.nodeName}: ${
                  error instanceof Error ? error.message : "status read failed"
                }`,
              ),
            ),
        ]);
        return toolResult({ ...options, coordinatorBase, checkoutBase, ...onNodeResult(target) });
      }
      const options = await launchOptionsWithDefaults(projectId, environmentId);
      if (!coordinatorScope) return toolResult(options);
      // Fetching the base branch moves remote-tracking refs only. The checkout
      // side stays read-only: reuse the persisted coordinator snapshot rather
      // than running a lock-serialized, workspace-mutating git status.
      const [coordinatorBase, checkoutBase] = await Promise.all([
        invoke<unknown>("get_project_base_branch_tip", { projectId: coordinatorScope.projectId })
          .then((tip) => coordinatorLaunchBaseFromTip(isRecord(tip) ? tip : null))
          .catch((error: unknown) =>
            coordinatorLaunchBaseFromTip(
              null,
              `Base branch is unavailable: ${
                error instanceof Error ? error.message : "base branch read failed"
              }`,
            ),
          ),
        invoke<unknown>("get_project_coordinator", { projectId: coordinatorScope.projectId })
          .then((snapshot) => {
            const workspace =
              isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
            return checkoutLaunchBaseFromStatus(
              workspace && isRecord(workspace.repositoryStatus) ? workspace.repositoryStatus : null,
            );
          })
          .catch((error: unknown) =>
            checkoutLaunchBaseFromStatus(
              null,
              `Repository status is unavailable: ${
                error instanceof Error ? error.message : "coordinator snapshot failed"
              }`,
            ),
          ),
      ]);
      return toolResult({ ...options, coordinatorBase, checkoutBase });
    },
  );
}

/** `launch_environment` and `launch_job`. */
export function registerLaunchTools(
  server: McpServer,
  {
    invoke,
    coordinatorScope,
    operator,
    onNode,
    onNodeResult,
    environmentInvoker,
  }: ControlMcpToolContext,
): void {
  const { selectionReport } = launchSettingsHelpers(invoke);

  server.registerTool(
    "launch_environment",
    {
      title: "Launch an agent environment",
      description:
        "Create, configure, and start a prompt environment: an autonomous coding agent that can execute commands, modify workspace files, and use allowed network access. " +
        `${LAUNCH_DEFAULTS_GUIDANCE} The result's selection reports the model and effort; advisory selections are pending startup. ` +
        (coordinatorScope
          ? `Coordinator launches require baseBranch and baseCommit from get_launch_options. Use a prompt environment for investigation or interactive work; when the whole spec is known, start a pipeline environment with start_build_pipeline instead. ${COORDINATOR_WORKER_PROMPT_NOTE} `
          : "") +
        "Use a new requestId for each new launch; reuse one only to retry the same launch.",
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          projectId: str({ trim: true, min: 1, max: 200 }),
          environmentType: withDefault(Schema.Literals(["local", "containerized"]), "local"),
          name: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          agent: AGENT_PLATFORM_FIELD,
          modelId: Schema.optionalKey(
            describe(str({ trim: true, min: 1, max: 500 }), MODEL_ID_DESCRIPTION),
          ),
          reasoningId: Schema.optionalKey(
            describe(str({ trim: true, min: 1, max: 100 }), REASONING_ID_DESCRIPTION),
          ),
          fastMode: Schema.optionalKey(describe(Schema.Boolean, FAST_MODE_DESCRIPTION)),
          conversationMode: withDefault(Schema.Literals(["plan", "build"]), "build"),
          prompt: describe(
            str({ trim: true, min: 1, max: MAX_PROMPT_LENGTH }),
            COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
          ),
          networkAccessMode: Schema.optionalKey(Schema.Literals(["restricted", "full"])),
          baseBranch: coordinatorScope
            ? describe(
                str({ trim: true, min: 1, max: 500 }),
                "Required coordinator base branch; copy coordinatorBase.baseBranch from get_launch_options (checkoutBase.baseBranch only when the user asks to build on the current checkout).",
              )
            : Schema.optionalKey(
                describe(
                  str({ trim: true, min: 1, max: 500 }),
                  "Optional branch to use as the environment base.",
                ),
              ),
          baseCommit: coordinatorScope
            ? describe(
                str({ pattern: /^[0-9a-f]{40}$/i }),
                "Required coordinator base commit; copy coordinatorBase.baseCommit from get_launch_options (checkoutBase.baseCommit only when the user asks to build on the current checkout).",
              )
            : Schema.optionalKey(
                describe(
                  str({ pattern: /^[0-9a-f]{40}$/i }),
                  "Optional 40-character commit to use as the environment base.",
                ),
              ),
          nodeId: describe(
            nodeIdField,
            coordinatorScope
              ? "Launch on that node's copy of this project (a nodeId from list_nodes); take baseBranch and baseCommit from get_launch_options with the same nodeId. Omit for this node."
              : "Launch on that machine (a nodeId from list_nodes); projectId is that machine's project, from list_projects with the same nodeId. Omit for this machine.",
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
    async (input) => {
      if (operator) {
        const { nodeId, ...launch } = input;
        const node = await operatorNode(operator, nodeId);
        return withNodeTag(await operatorLaunchEnvironment(node.caller, launch), node.tag);
      }
      // Operator credentials launch through environment.launch above.
      if (!coordinatorScope) throw new Error("launch_environment needs a credential");
      if (!input.baseBranch || !input.baseCommit) {
        throw new Error("Coordinator launches require an explicit baseBranch and baseCommit");
      }
      const target = await onNode(input.nodeId);
      if (target && coordinatorScope) {
        // The base, the agent and the model are checked against that node's copy,
        // and an omitted agent is that node's default.
        await assertCoordinatorLaunchBaseOnBranch(target.invoke, target.projectId, input);
        const saved = await invoke<unknown>("get_coordinator_node_launch_environment", {
          scope: coordinatorScope,
          requestId: input.requestId,
          nodeId: target.nodeId,
        });
        const savedSettings =
          isRecord(saved) && isRecord(saved.agentSettings) ? saved.agentSettings : undefined;
        const { agent } = await resolveLaunchAgent(
          target.invoke,
          target.projectId,
          input.agent ??
            (isRecord(saved) && isRecord(saved.startupAgentSession)
              ? (saved.startupAgentSession.agent as AgentPlatform)
              : isRecord(saved) && typeof saved.initialAgentPlatform === "string"
                ? (saved.initialAgentPlatform as AgentPlatform)
                : (savedSettings?.defaultAgent as AgentPlatform | undefined)),
        );
        const options = saved
          ? { models: [] }
          : await validateSelection(target.invoke, {
              ...input,
              agent,
              projectId: target.projectId,
            });
        const { nodeId: _nodeId, ...launchInput } = input;
        const launch = await invoke<unknown>("launch_coordinator_node_environment", {
          scope: coordinatorScope,
          requestId: input.requestId,
          nodeId: target.nodeId,
          input: launchEnvironmentCreateInput({ ...launchInput, agent }),
          ...(input.agent === undefined ? { agentDefaulted: true } : {}),
        });
        const environment = isRecord(launch) ? launch.environment : null;
        if (!isRecord(environment) || typeof environment.id !== "string") {
          throw new Error("Environment creation returned no environment");
        }
        const startup = isRecord(environment.startupAgentSession)
          ? environment.startupAgentSession
          : undefined;
        const selection = startup
          ? {
              selection: {
                agent: startup.agent,
                model: startup.model ?? null,
                reasoning: startup.reasoningEffort ?? null,
                source: input.modelId || input.reasoningId ? "requested" : "default",
              },
            }
          : await selectionReport(
              target.projectId,
              environment,
              options.models,
              { ...input, agent },
              false,
              target.invoke,
            );
        if (!startup && isRecord(selection.selection)) selection.selection.advisory = true;
        const startError =
          isRecord(launch) && typeof launch.startError === "string" ? launch.startError : undefined;
        const delegationOpened =
          !startError && isRecord(launch) && launch.coordinatorDelegationOpened === true;
        return toolResult({
          environmentId: environment.id,
          ...onNodeResult(target),
          tabId: STARTUP_AGENT_TAB_ID,
          status: startError ? "created" : "accepted",
          ...coordinatorReplayFields(launch),
          ...selection,
          ...(delegationOpened ? asyncDelegationResult() : {}),
          delegationBaseBranch: input.baseBranch,
          delegationBaseCommit: input.baseCommit,
          ...(startError ? { error: startError } : {}),
        });
      }
      // Only a launch from the checkout's own HEAD can miss its uncommitted
      // changes; for that case the result says whether there are any.
      let checkoutHasUncommittedChanges: boolean | undefined;
      if (coordinatorScope) {
        await assertCoordinatorLaunchBaseOnBranch(invoke, coordinatorScope.projectId, input);
        const repository = await invoke<unknown>("get_project_git_status", {
          projectId: coordinatorScope.projectId,
        }).catch(() => null);
        if (
          isRecord(repository) &&
          nonEmptyString(repository.headCommit)?.toLowerCase() === input.baseCommit?.toLowerCase()
        ) {
          checkoutHasUncommittedChanges =
            Number(repository.trackedChanges ?? 0) + Number(repository.untrackedChanges ?? 0) > 0;
        }
      }
      // A new environment's own tier pins no model or agent, so repository and
      // app settings decide, exactly as the startup launch reads them.
      const saved = await invoke<unknown>("get_coordinator_launch_environment", {
        scope: coordinatorScope,
        requestId: input.requestId,
      });
      const savedSettings =
        isRecord(saved) && isRecord(saved.agentSettings) ? saved.agentSettings : undefined;
      const { agent } = await resolveLaunchAgent(
        invoke,
        input.projectId,
        input.agent ??
          (isRecord(saved) && isRecord(saved.startupAgentSession)
            ? (saved.startupAgentSession.agent as AgentPlatform)
            : isRecord(saved) && typeof saved.initialAgentPlatform === "string"
              ? (saved.initialAgentPlatform as AgentPlatform)
              : (savedSettings?.defaultAgent as AgentPlatform | undefined)),
      );
      const options = saved ? { models: [] } : await validateSelection(invoke, { ...input, agent });
      const createInput = launchEnvironmentCreateInput({ ...input, agent });
      const launch = await invoke<unknown>("launch_coordinator_environment", {
        scope: coordinatorScope,
        requestId: input.requestId,
        input: createInput,
        ...(input.agent === undefined ? { agentDefaulted: true } : {}),
      });
      const environment = isRecord(launch) ? launch.environment : null;
      if (!isRecord(environment) || typeof environment.id !== "string") {
        throw new Error("Environment creation returned no environment");
      }
      // Startup publishes the accepted controls durably. Replays report those
      // controls, rather than resolving the current settings again. Until then
      // defaults are advisory because reconciliation has not selected them yet.
      let startup = isRecord(environment.startupAgentSession)
        ? environment.startupAgentSession
        : undefined;
      if (!startup) {
        try {
          const session = await invoke<unknown>("get_native_agent_session", {
            environmentId: environment.id,
            agent,
            logicalSessionKey: `env-${environment.id}:${STARTUP_AGENT_TAB_ID}`,
          });
          if (isRecord(session) && isRecord(session.controls)) {
            startup = {
              agent: session.agent,
              model: session.controls.modelId,
              reasoningEffort: session.controls.reasoningId,
            };
          }
        } catch {
          // A pending startup may not have published a native session yet.
        }
      }
      const selection = startup
        ? {
            selection: {
              agent: startup.agent,
              model: startup.model ?? null,
              reasoning: startup.reasoningEffort ?? null,
              source: input.modelId || input.reasoningId ? "requested" : "default",
            },
          }
        : await selectionReport(
            input.projectId,
            environment,
            options.models,
            {
              ...input,
              agent,
              modelId:
                typeof environment.initialAgentModel === "string"
                  ? environment.initialAgentModel
                  : input.modelId,
              reasoningId:
                typeof environment.initialReasoningEffort === "string"
                  ? environment.initialReasoningEffort
                  : input.reasoningId,
            },
            false,
          );
      if (!startup && isRecord(selection.selection)) selection.selection.advisory = true;
      const startError =
        isRecord(launch) && typeof launch.startError === "string" ? launch.startError : undefined;
      const delegationOpened =
        coordinatorScope &&
        !startError &&
        isRecord(launch) &&
        launch.coordinatorDelegationOpened === true;
      return toolResult({
        environmentId: environment.id,
        tabId: STARTUP_AGENT_TAB_ID,
        status: startError ? "created" : "accepted",
        ...coordinatorReplayFields(launch),
        ...selection,
        ...(delegationOpened ? asyncDelegationResult() : {}),
        ...(coordinatorScope
          ? {
              delegationBaseBranch: input.baseBranch,
              delegationBaseCommit: input.baseCommit,
              ...(checkoutHasUncommittedChanges === undefined
                ? {}
                : { liveCheckoutHasUncommittedChanges: checkoutHasUncommittedChanges }),
            }
          : {}),
        ...(startError ? { error: startError } : {}),
      });
    },
  );

  server.registerTool(
    "launch_job",
    {
      title: "Launch a job in an existing environment",
      description:
        "Create a native-agent tab and exactly-once initial turn that can execute commands, modify workspace files, and use configured network access. " +
        `${LAUNCH_DEFAULTS_GUIDANCE} The result's selection reports the model and effort that will run.` +
        (coordinatorScope ? ` ${COORDINATOR_WORKER_PROMPT_NOTE}` : ""),
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          environmentId: str({ trim: true, min: 1, max: 200 }),
          agent: AGENT_PLATFORM_FIELD,
          modelId: Schema.optionalKey(
            describe(str({ trim: true, min: 1, max: 500 }), MODEL_ID_DESCRIPTION),
          ),
          reasoningId: Schema.optionalKey(
            describe(str({ trim: true, min: 1, max: 100 }), REASONING_ID_DESCRIPTION),
          ),
          fastMode: Schema.optionalKey(describe(Schema.Boolean, FAST_MODE_DESCRIPTION)),
          conversationMode: withDefault(Schema.Literals(["plan", "build"]), "build"),
          title: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          prompt: describe(
            str({ trim: true, min: 1, max: MAX_PROMPT_LENGTH }),
            COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
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
    async ({ nodeId, ...input }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        return withNodeTag(await operatorLaunchJob(node.caller, input), node.tag);
      }
      const { inv, target } = await environmentInvoker(nodeId, input.environmentId);
      const environment = await inv<unknown>("get_environment", {
        environmentId: input.environmentId,
      });
      if (!isRecord(environment) || typeof environment.projectId !== "string") {
        throw new Error(`Environment not found: ${input.environmentId}`);
      }
      // An omitted agent is this environment's default, as its new-tab button picks.
      const savedAgent =
        input.agent === undefined
          ? savedControlJobAgent(
              await inv("get_pane_layout", { environmentId: input.environmentId }),
              input.environmentId,
              input.requestId,
            )
          : undefined;
      const { agent } = await resolveLaunchAgent(
        inv,
        environment.projectId,
        input.agent ?? savedAgent,
        environment,
      );
      const options = await validateSelection(inv, {
        projectId: environment.projectId,
        environmentId: input.environmentId,
        agent,
        modelId: input.modelId,
        reasoningId: input.reasoningId,
        fastMode: input.fastMode,
      });
      const selection = await selectionReport(
        environment.projectId,
        environment,
        options.models,
        { ...input, agent },
        true,
        inv,
      );
      const delegation = coordinatorScope
        ? createCoordinatorDelegatedPrompt(
            {
              projectId: coordinatorScope.projectId,
              coordinatorId: coordinatorScope.coordinatorId,
              conversationId: coordinatorScope.conversationId,
              instruction: `${COORDINATOR_JOB_DELEGATION_INSTRUCTION}\n` + workerAsyncContract(),
            },
            input.prompt,
          )
        : null;
      const launchArgs = delegation
        ? withCoordinatorDelegationPresentation(
            {
              ...input,
              agent,
              agentDefaulted: input.agent === undefined,
              prompt: delegation.source,
              activateTab: false,
            },
            {
              kind: COORDINATOR_DELEGATION_PRESENTATION,
              frame: delegation.frame,
            },
          )
        : { ...input, agent, agentDefaulted: input.agent === undefined, activateTab: false };
      const job = target
        ? await target.call<unknown>("launch_control_job", launchArgs, `job:${input.requestId}`)
        : await invoke<unknown>("launch_control_job", launchArgs);
      if (!isRecord(job)) throw new Error("Job launch returned no result");
      const jobRequest = {
        summary: input.prompt,
        ...(isRecord(selection.selection) ? selection.selection : {}),
      };
      // Only against the tab the job actually landed in. A guessed tab id would
      // open a delegation nothing can ever close, leaving the conversation
      // shown as waiting on a worker that does not exist.
      const delegationOpened =
        coordinatorScope && typeof job.tabId === "string"
          ? target
            ? await tryOpenNodeDelegation(invoke, coordinatorScope, {
                nodeId: target.nodeId,
                environmentId: input.environmentId,
                tabId: job.tabId,
                requestId: input.requestId,
                request: jobRequest,
              })
            : await tryOpenCoordinatorDelegation(invoke, coordinatorScope, {
                environmentId: input.environmentId,
                tabId: job.tabId,
                requestId: input.requestId,
                request: jobRequest,
              })
          : false;
      return toolResult({
        ...job,
        ...onNodeResult(target),
        ...selection,
        ...(delegationOpened
          ? asyncDelegationResult()
          : coordinatorScope
            ? {
                delegationNote:
                  "The request was dispatched, but no delegation was opened (the request ID may already belong to another worker). Do not dispatch again under a new ID; inspect the existing job. You will not be woken automatically.",
              }
            : {}),
      });
    },
  );
}

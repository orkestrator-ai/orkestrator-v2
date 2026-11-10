/**
 * The shared project, environment, tab and prompt tools: `list_projects`,
 * the environment, tab, agent and transcript reads, and `send_prompt_to_tab`.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { COORDINATOR_WORKER_PROMPT_FORMAT_RULE } from "@orkestrator/protocol/coordinator";
import { isPipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { Schema } from "effect";
import { describe, int, str, toolInput, withDefault } from "./tool-schema.js";
import {
  agentRegistryFingerprint,
  environmentFingerprint,
  environmentListFingerprint,
  pollKey,
  tabStateFingerprint,
  transcriptFingerprint,
} from "./control-mcp-poll-guard.js";
import {
  allEnvironments,
  compactMessages,
  environmentSummary,
  MAX_TRANSCRIPT_MESSAGES,
  nativeTab,
  paneTabs,
  projectSummary,
  terminalSessionId,
} from "./control-shared-actions.js";
import { onNode as callerOnNode } from "./control-mcp-caller.js";
import { PUBLIC_ALL_NODES } from "@orkestrator/protocol/public-api";
import {
  asArray,
  isRecord,
  listNodeIdField,
  nodeIdField,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./control-mcp-tool-support.js";
import {
  ControlMcpNodeError,
  operatorAllNodes,
  operatorListProjects,
  operatorNode,
  operatorSendPrompt,
} from "./control-mcp-operator-tools.js";
import { goalForModel, type NativeAgentGoalView } from "@orkestrator/protocol/native-agent-goal";
import {
  coordinatorPrFields,
  nodePrHealth,
  prReadingFrom,
  summaryPrHealth,
  thisNodePrHealth,
} from "./coordinator-pr-status.js";
import {
  MAX_PROMPT_LENGTH,
  COORDINATOR_WORKER_PROMPT_NOTE,
  asyncDelegationResult,
  tryOpenNodeDelegation,
  tryOpenCoordinatorDelegation,
  coordinatorNodeRefused,
  coordinatorScopeTurnOrigin,
  type ControlMcpToolContext,
} from "./control-mcp-tools-shared.js";
import { createCoordinatorMailOriginPrompt } from "@orkestrator/protocol/review-evidence-frames";

const MAX_TERMINAL_OUTPUT_CHARS = 256 * 1024;
const TERMINAL_TAB_TYPES = new Set([
  "plain",
  "claude",
  "opencode",
  "codex",
  "cursor",
  "grok",
  "pi",
  "root",
  "claude-tmux",
]);

/** What a coordinator's environment reads say about a worker's pull request. */
const COORDINATOR_PR_FIELDS_NOTE =
  " A worker with a pull request also has prHasMergeConflicts, prMergeability, prChecks (passed, failed, pending and total counts, and requiredFailed: how many failing checks GitHub requires, null when it did not say) and prReadyToMerge (with prNotReadyReason when false), from the PR monitor; ready means only the user's merge is left.";

/** `list_projects`. */
export function registerProjectTools(
  server: McpServer,
  { invoke, coordinatorScope, operator }: ControlMcpToolContext,
): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Orkestrator projects",
      description: "List safe summaries of the projects configured in Orkestrator.",
      inputSchema: toolInput(Schema.Struct({ nodeId: operator ? listNodeIdField : nodeIdField })),
      annotations: readAnnotations(),
    },
    async ({ nodeId }) => {
      if (operator) return operatorListProjects(callerOnNode(operator, nodeId));
      coordinatorNodeRefused(nodeId);
      const projects = asArray(await invoke("get_projects"))
        .filter((project) => !coordinatorScope || project.id === coordinatorScope.projectId)
        .map(projectSummary);
      return toolResult({ projects, total: projects.length });
    },
  );
}

/** The environment, tab, agent and transcript reads. */
export function registerEnvironmentTools(
  server: McpServer,
  {
    invoke,
    coordinatorScope,
    operator,
    pollGuard,
    nodes,
    onNode,
    onNodeResult,
    environmentInvoker,
  }: ControlMcpToolContext,
): void {
  server.registerTool(
    "list_environments",
    {
      title: "List Orkestrator environments",
      description:
        "List environment lifecycle and agent activity summaries." +
        (coordinatorScope ? COORDINATOR_PR_FIELDS_NOTE : ""),
      inputSchema: toolInput(
        Schema.Struct({
          projectId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          status: Schema.optionalKey(
            Schema.Literals(["running", "stopped", "error", "creating", "stopping"]),
          ),
          nodeId: operator ? listNodeIdField : nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ projectId, status, nodeId }) => {
      if (operator) {
        if (nodeId === PUBLIC_ALL_NODES && projectId) {
          throw new ControlMcpNodeError(
            "invalid-input",
            "A projectId belongs to one machine: pass its nodeId instead of all",
          );
        }
        const { reachable, unavailable } =
          nodeId === PUBLIC_ALL_NODES
            ? await operatorAllNodes(operator)
            : { reachable: [await operatorNode(operator, nodeId)], unavailable: [] };
        const failed: JsonRecord[] = [...unavailable];
        const groups = await Promise.all(
          reachable.map((node) =>
            allEnvironments(node.invoke, projectId)
              .then((all) =>
                all
                  .filter((environment) => !status || environment.status === status)
                  .map((environment) => ({ ...environmentSummary(environment), ...node.tag })),
              )
              .catch((error: unknown) => {
                // One machine failing must not hide the others' environments.
                if (nodeId !== PUBLIC_ALL_NODES) throw error;
                failed.push({
                  ...node.tag,
                  reason: error instanceof Error ? error.message.slice(0, 300) : "read failed",
                });
                return [];
              }),
          ),
        );
        const environments = groups.flat();
        return toolResult({
          environments,
          total: environments.length,
          ...(failed.length > 0 ? { unavailableNodes: failed } : {}),
        });
      }
      const target = await onNode(nodeId);
      const all = target
        ? await allEnvironments(target.invoke, target.projectId)
        : await allEnvironments(invoke, projectId ?? coordinatorScope?.projectId);
      const listed = all
        .filter((environment) => !status || environment.status === status)
        .filter((environment) => !target || environment.projectHome !== true);
      // Conflicts, mergeability, checks and readiness need the owning monitor's health.
      const health = target
        ? await nodePrHealth(invoke, target.nodeId)
        : await thisNodePrHealth(invoke, projectId ?? coordinatorScope?.projectId, listed);
      const environments = listed.map((environment) => ({
        ...environmentSummary(environment),
        ...coordinatorPrFields(prReadingFrom(environment, health.get(String(environment.id)))),
        ...onNodeResult(target),
        // The model can tell the user's own checkout from a worker before acting on it.
        ...(coordinatorScope && environment.projectHome === true ? { projectHome: true } : {}),
      }));
      // A coordinator also sees where else this project runs (names and state
      // only); nodeId on any environment tool acts there.
      const otherNodes =
        nodes && !nodeId
          ? await invoke<unknown>("get_node_summaries")
              .then(async (summaries) => {
                const hint = await nodes.ownRepository();
                const list =
                  isRecord(summaries) && Array.isArray(summaries.nodes) ? summaries.nodes : [];
                return list.flatMap((node: JsonRecord) => {
                  const project = (Array.isArray(node.projects) ? node.projects : []).find(
                    (entry: JsonRecord) => hint && entry.repositoryHint === hint,
                  ) as JsonRecord | undefined;
                  const ref = project && isRecord(project.ref) ? project.ref : null;
                  if (!ref) return [];
                  const rows = (Array.isArray(node.environments) ? node.environments : [])
                    .filter(
                      (environment: JsonRecord) =>
                        environment.projectId === ref.projectId &&
                        !environment.isProjectHome &&
                        (!status || environment.status === status),
                    )
                    .map((environment: JsonRecord) => ({
                      environmentId: isRecord(environment.ref)
                        ? environment.ref.environmentId
                        : undefined,
                      name: environment.name,
                      status: environment.status,
                      activity: environment.activity,
                      ...(environment.branch ? { branch: environment.branch } : {}),
                      // States and counts only: node summaries never carry the PR URL.
                      ...(environment.prState ? { prState: environment.prState } : {}),
                      ...coordinatorPrFields(
                        prReadingFrom(environment, summaryPrHealth(node, environment)),
                      ),
                    }));
                  return [
                    {
                      nodeId: node.nodeId,
                      node: isRecord(node.view) ? node.view.displayName : node.nodeId,
                      available: node.available === true,
                      environments: rows,
                    },
                  ];
                });
              })
              .catch(() => [])
          : [];
      const result = {
        environments,
        total: environments.length,
        ...(otherNodes.length > 0 ? { otherNodes } : {}),
      };
      // A coordinator re-listing unchanged environments is polling its workers.
      const guidance = pollGuard?.(
        pollKey("list_environments", projectId, status, nodeId),
        environmentListFingerprint(result),
      );
      return toolResult(guidance ? { ...result, ...guidance } : result);
    },
  );

  server.registerTool(
    "get_environment",
    {
      title: "Get an Orkestrator environment",
      description:
        "Read the authoritative lifecycle and activity state of one environment." +
        (coordinatorScope ? COORDINATOR_PR_FIELDS_NOTE : ""),
      inputSchema: toolInput(
        Schema.Struct({
          environmentId: str({ trim: true, min: 1, max: 200 }),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ environmentId, nodeId }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        const environment = await node.invoke<unknown>("get_environment", { environmentId });
        if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
        return toolResult({ environment: { ...environmentSummary(environment), ...node.tag } });
      }
      const target = await onNode(nodeId);
      const environment = target
        ? await target.environment(environmentId)
        : await invoke<unknown>("get_environment", { environmentId });
      if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
      const health = target
        ? await nodePrHealth(invoke, target.nodeId)
        : await thisNodePrHealth(invoke, coordinatorScope?.projectId, [environment]);
      const summary = {
        ...environmentSummary(environment),
        ...coordinatorPrFields(prReadingFrom(environment, health.get(environmentId))),
        ...onNodeResult(target),
      };
      const guidance = pollGuard?.(
        pollKey("get_environment", environmentId, nodeId),
        environmentFingerprint(summary),
      );
      return toolResult({ environment: summary, ...guidance });
    },
  );

  server.registerTool(
    "list_tabs",
    {
      title: "List environment tabs",
      description: "List tabs from the backend-owned pane layout of an environment.",
      inputSchema: toolInput(
        Schema.Struct({
          environmentId: str({ trim: true, min: 1, max: 200 }),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ environmentId, nodeId }) => {
      const { inv, where, layout: readLayout } = await environmentInvoker(nodeId, environmentId);
      const layout = await readLayout();
      // A fresh environment may have no layout yet; a bogus ID must not read as "no tabs".
      if (!layout && !isRecord(await inv<unknown>("get_environment", { environmentId }))) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      const tabs = paneTabs(layout);
      return toolResult({ environmentId, ...where, tabs, total: tabs.length });
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "Every agent tab in the project's environments, and its coordinator conversations, with what each is doing now: working, waiting (on a person), idle, stopped (its environment is not running) or unknown. Native tabs carry the sessionId the session tools take. Includes per-environment counts. Read it to answer a one-off question, not to wait: re-reading an unchanged answer is polling, and a delegated worker's answer comes back to you without it.",
      inputSchema: toolInput(
        Schema.Struct({
          projectId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          environmentId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ projectId, environmentId, nodeId }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        const snapshot = await node.invoke<unknown>("get_agent_registry", {
          ...(projectId ? { projectId } : {}),
          ...(environmentId ? { environmentId } : {}),
        });
        if (!isRecord(snapshot)) throw new Error("Agent registry returned no result");
        return toolResult({ ...snapshot, ...node.tag });
      }
      const target = await onNode(nodeId);
      if (target) {
        if (environmentId) await target.environment(environmentId);
        const remote = await target.call<unknown>("get_agent_registry", {
          projectId: target.projectId,
          ...(environmentId ? { environmentId } : {}),
        });
        if (!isRecord(remote)) throw new Error("Agent registry returned no result");
        // That node's own coordinator conversations are not this coordinator's agents.
        const entries = asArray(remote.entries).filter(
          (entry) => entry.ownerKind !== "coordinator",
        );
        const result = { ...remote, entries, ...onNodeResult(target) };
        const guidance = pollGuard?.(
          pollKey("list_agents", nodeId, environmentId),
          agentRegistryFingerprint(result),
        );
        return toolResult({ ...result, ...guidance });
      }
      const snapshot = await invoke<unknown>("get_agent_registry", {
        ...(coordinatorScope
          ? { projectId: coordinatorScope.projectId }
          : projectId
            ? { projectId }
            : {}),
        ...(environmentId ? { environmentId } : {}),
      });
      if (!isRecord(snapshot)) throw new Error("Agent registry returned no result");
      const guidance = pollGuard?.(
        pollKey("list_agents", undefined, environmentId),
        agentRegistryFingerprint(snapshot),
      );
      return toolResult({ ...snapshot, ...guidance });
    },
  );

  server.registerTool(
    "get_tab_state",
    {
      title: "Get tab state",
      description:
        "Read native-agent state for a tab without returning its transcript. state.interactions lists what the tab is waiting on: each pending question or approval with its id, kind, questions and options (a coordinator may propose an answer to a question with answer_worker_question).",
      inputSchema: toolInput(
        Schema.Struct({
          environmentId: str({ trim: true, min: 1, max: 200 }),
          tabId: str({ trim: true, min: 1, max: 200 }),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ environmentId, tabId, nodeId }) => {
      // Re-reading the same tab's state unchanged is polling the worker.
      const answer = (result: JsonRecord) =>
        toolResult({
          ...result,
          ...pollGuard?.(
            pollKey("get_tab_state", environmentId, tabId, nodeId),
            tabStateFingerprint(result),
          ),
        });
      const {
        inv,
        where: node,
        layout: readLayout,
      } = await environmentInvoker(nodeId, environmentId);
      const where = { environmentId, tabId, ...node };
      const [layout, environment] = await Promise.all([
        readLayout(),
        inv<unknown>("get_environment", { environmentId }),
      ]);
      const tab = paneTabs(layout).find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`Tab not found: ${tabId}`);
      const native = nativeTab(layout, tabId);
      if (!native) {
        if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
        if (typeof tab.type !== "string" || !TERMINAL_TAB_TYPES.has(tab.type)) {
          return answer({ ...where, tab, state: { kind: "persisted" } });
        }
        const state = await inv<unknown>("get_terminal_session", {
          sessionId: terminalSessionId(environment, environmentId, tabId),
        });
        return answer({ ...where, tab, state });
      }
      const projection = await inv<unknown>("get_native_agent_projection", {
        environmentId,
        agent: native.agent,
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        messageLimit: 1,
      });
      if (!isRecord(projection)) {
        return answer({ ...where, agent: native.agent, connection: "connecting" });
      }
      const { messages: _messages, ...state } = projection;
      return answer({
        ...where,
        agent: native.agent,
        state: {
          ...state,
          // A coordinator is a model: what the worker wrote reaches it framed.
          ...(coordinatorScope && isRecord(state.goal)
            ? { goal: goalForModel(state.goal as unknown as NativeAgentGoalView) }
            : {}),
        },
      });
    },
  );

  server.registerTool(
    "get_tab_transcript",
    {
      title: "Read a tab transcript",
      description:
        "Read a bounded normalized transcript for a native tab, a bounded terminal-output tail for a terminal tab, or a build pipeline worker's own transcript when tabId is a worker's mailbox address (pipeline-worker:…, from list_mailboxes or get_build_pipeline), running or finished.",
      inputSchema: toolInput(
        Schema.Struct({
          environmentId: str({ trim: true, min: 1, max: 200 }),
          tabId: str({ trim: true, min: 1, max: 200 }),
          limit: withDefault(int({ min: 1, max: MAX_TRANSCRIPT_MESSAGES }), 50),
          nodeId: nodeIdField,
        }),
      ),
      annotations: readAnnotations(),
    },
    async ({ environmentId, tabId, limit, nodeId }) => {
      // Re-reading the same transcript unchanged is polling the worker.
      const answer = (result: JsonRecord) =>
        toolResult({
          ...result,
          ...pollGuard?.(
            pollKey("get_tab_transcript", environmentId, tabId, nodeId),
            transcriptFingerprint(result),
          ),
        });
      const { inv, where, layout: readLayout } = await environmentInvoker(nodeId, environmentId);
      if (isPipelineWorkerTabId(tabId)) {
        // A pipeline worker has no pane tab: its stage session's transcript.
        const read = await inv<unknown>("get_build_pipeline_worker_transcript", {
          environmentId,
          tabId,
          limit,
        });
        if (!isRecord(read)) throw new Error("The worker's transcript is unavailable");
        const { messages, ...rest } = read;
        return answer({
          ...rest,
          ...where,
          kind: "pipeline-worker",
          ...compactMessages(Array.isArray(messages) ? messages : []),
        });
      }
      const [layout, environment] = await Promise.all([
        readLayout(),
        inv<unknown>("get_environment", { environmentId }),
      ]);
      const native = nativeTab(layout, tabId);
      if (native) {
        const projection = await inv<unknown>("get_native_agent_projection", {
          environmentId,
          agent: native.agent,
          logicalSessionKey: `env-${environmentId}:${tabId}`,
          messageLimit: limit,
        });
        if (!isRecord(projection)) {
          return answer({
            environmentId,
            tabId,
            ...where,
            agent: native.agent,
            connection: "error",
            error: "The transcript is unavailable right now",
            messages: [],
          });
        }
        const compact = compactMessages(
          Array.isArray(projection.messages) ? projection.messages : [],
        );
        return answer({
          environmentId,
          tabId,
          ...where,
          agent: native.agent,
          ...compact,
          connection: projection.connection,
          ...(isRecord(projection.turn) && projection.turn.error
            ? { error: projection.turn.error }
            : {}),
          messageWindow: projection.messageWindow,
          revision: projection.revision,
          generation: projection.generation,
        });
      }
      if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
      const tab = paneTabs(layout).find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`Tab not found: ${tabId}`);
      if (typeof tab.type !== "string" || !TERMINAL_TAB_TYPES.has(tab.type)) {
        throw new Error(`Transcript is unavailable for tab type: ${String(tab.type)}`);
      }
      const sessionId = terminalSessionId(environment, environmentId, tabId);
      const snapshot = await inv<unknown>("get_terminal_output_snapshot", { sessionId });
      const output =
        isRecord(snapshot) && typeof snapshot.output === "string" ? snapshot.output : "";
      const stripped = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      return answer({
        environmentId,
        tabId,
        ...where,
        kind: "terminal-output",
        output: stripped.slice(-MAX_TERMINAL_OUTPUT_CHARS),
        truncated:
          stripped.length > MAX_TERMINAL_OUTPUT_CHARS ||
          (isRecord(snapshot) && snapshot.truncated === true),
        revision: isRecord(snapshot) ? snapshot.revision : undefined,
        generation: isRecord(snapshot) ? snapshot.generation : undefined,
      });
    },
  );
}

/** `send_prompt_to_tab`. */
export function registerPromptTool(
  server: McpServer,
  { invoke, coordinatorScope, operator, onNodeResult, environmentInvoker }: ControlMcpToolContext,
): void {
  server.registerTool(
    "send_prompt_to_tab",
    {
      title: "Send a prompt to an existing agent tab",
      description:
        "Dispatch an exactly-once prompt to an autonomous coding agent that can execute commands, modify workspace files, and use configured network access." +
        (coordinatorScope ? ` ${COORDINATOR_WORKER_PROMPT_NOTE}` : ""),
      inputSchema: toolInput(
        Schema.Struct({
          requestId: str({ trim: true, min: 1, max: 256 }),
          environmentId: str({ trim: true, min: 1, max: 200 }),
          tabId: str({ trim: true, min: 1, max: 200 }),
          prompt: describe(
            str({ trim: true, min: 1, max: MAX_PROMPT_LENGTH }),
            COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
          ),
          conversationMode: Schema.optionalKey(Schema.Literals(["plan", "build"])),
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
    async ({ requestId, environmentId, tabId, prompt, conversationMode, nodeId }) => {
      if (operator) {
        return operatorSendPrompt(callerOnNode(operator, nodeId), {
          requestId,
          environmentId,
          tabId,
          prompt,
          ...(conversationMode ? { conversationMode } : {}),
        });
      }
      const { inv, target } = await environmentInvoker(nodeId, environmentId);
      if (coordinatorScope) {
        await invoke(
          target
            ? "assert_coordinator_node_delegation_available"
            : "assert_coordinator_delegation_available",
          {
            scope: coordinatorScope,
            ...(target ? { nodeId: target.nodeId } : {}),
            environmentId,
            tabId,
            requestId,
          },
        );
      }
      const layout = await inv<unknown>("get_pane_layout", { environmentId });
      const native = nativeTab(layout, tabId);
      if (!native) throw new Error(`Native agent tab not found: ${tabId}`);
      // From a turn the user did not start, the worker is told so, as mail is.
      const framed =
        coordinatorScope && (await coordinatorScopeTurnOrigin(invoke, coordinatorScope)) === "mail"
          ? createCoordinatorMailOriginPrompt(prompt).source
          : prompt;
      const intent = {
        environmentId,
        agent: native.agent,
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        requestId,
        prompt: framed,
        ...(conversationMode ? { mode: conversationMode } : {}),
      };
      const outcome = target
        ? await target.call<unknown>("dispatch_native_agent_intent", intent, `prompt:${requestId}`)
        : await invoke<unknown>("dispatch_native_agent_intent", intent);
      if (!isRecord(outcome)) throw new Error("Prompt dispatch returned no result");
      const delegationOpened = !coordinatorScope
        ? false
        : target
          ? await tryOpenNodeDelegation(invoke, coordinatorScope, {
              nodeId: target.nodeId,
              environmentId,
              tabId,
              requestId,
              request: { summary: prompt, agent: native.agent },
            })
          : await tryOpenCoordinatorDelegation(invoke, coordinatorScope, {
              environmentId,
              tabId,
              requestId,
              request: { summary: prompt, agent: native.agent },
            });
      return toolResult({
        environmentId,
        tabId,
        ...onNodeResult(target),
        ...outcome,
        ...(delegationOpened ? asyncDelegationResult() : {}),
      });
    },
  );
}

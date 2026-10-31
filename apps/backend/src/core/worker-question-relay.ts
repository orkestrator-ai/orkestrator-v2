import { createHash } from "node:crypto";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  isAgentInteractionRequest,
  isAgentInteractionResolution,
  type AgentInteractionQuestionAnswer,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { nativeTabLogicalSessionKey } from "@orkestrator/protocol/public-api-resources";
import {
  parseWorkerQuestionAnswers,
  WORKER_QUESTION_RELAY_LIMITS,
  workerQuestionAnswerProblem,
  workerQuestionRefusal,
  workerQuestionViews,
  type WorkerQuestionRelay,
} from "@orkestrator/protocol/worker-question-relay";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { coordinatorNodeTarget } from "./commands-registry-coordinator-nodes.js";
import { coordinatorCaller, withCoordinatorReceipt } from "./coordinator-action-scope.js";
import { nativeTabsOfLayout } from "./public-api/summaries.js";
import { optionalText, requireProjectWorker, surfaceRecord } from "./worker-surface-runs.js";

/**
 * The user-confirmed answer relay (`answer_worker_question`): a main
 * coordinator proposes an answer to a question a worker is waiting on, and
 * only the user's approval of the `answer-worker-question` node action
 * request answers it.
 *
 * - `request_coordinator_worker_answer` (coordinator scope): reads the
 *   pending question from the worker tab (this node, or a connected node
 *   through the node link), refuses anything that is not a question, checks
 *   the proposal against it and creates the request. It answers nothing.
 * - `answer_project_worker_question` (this node) and
 *   `answer_controller_worker_question` (node link only): run only from an
 *   approved request; the coordinator's command invoker refuses both by name.
 *   They re-read the worker's pending interactions where the worker lives and
 *   answer through `resolve_native_agent_interaction`, the command the
 *   worker's tab uses. A question that is no longer pending, or changed, is
 *   `stale` and nothing is sent; anything malformed is refused, never coerced.
 *
 * Receipts and results are content-free: the answer lives in the request
 * record the user reviews and in the worker's interaction.
 */

type JsonRecord = Record<string, unknown>;
type Invoke = <T>(command: string, args?: JsonRecord) => Promise<T>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, name: string, max: number): string {
  const text = optionalText(value, name, max);
  if (!text) throw new Error(`Expected ${name}`);
  return text;
}

/** The resolution the worker's tab would send for these answers. */
export function workerAnswerResolution(
  request: AgentInteractionRequest,
  answers: AgentInteractionQuestionAnswer[],
  now = Date.now(),
): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId: request.id,
    sessionId: request.sessionId,
    action: "answer",
    answer: {
      version: AGENT_INTERACTION_CONTRACT_VERSION,
      interactionId: request.id,
      sessionId: request.sessionId,
      answers,
    },
    resolvedAt: Math.max(now, request.createdAt),
  };
}

/** Why `answers` cannot answer `request`, or null when they can. */
function answerProblem(
  request: AgentInteractionRequest,
  answers: AgentInteractionQuestionAnswer[],
): string | null {
  const refusal = workerQuestionRefusal(request);
  if (refusal) return refusal;
  const problem = workerQuestionAnswerProblem(workerQuestionViews(request), answers);
  if (problem) return problem;
  return isAgentInteractionResolution(workerAnswerResolution(request, answers), request)
    ? null
    : "The answer does not match the question's options or limits.";
}

/**
 * The pending interaction `interactionId` of one worker tab, read through
 * `inv` (this node's commands, or a connected node's through the node link)
 * from the same projection the tab shows.
 */
async function readPendingInteraction(
  inv: Invoke,
  environmentId: string,
  tabId: string,
  interactionId: string,
): Promise<{ request: AgentInteractionRequest; tabName?: string }> {
  const layout = await inv<unknown>("get_pane_layout", { environmentId });
  const tab = nativeTabsOfLayout(layout).find((candidate) => candidate.tabId === tabId);
  if (!tab) throw new Error("That tab is not an agent tab of that worker; call list_tabs.");
  const projection = await inv<unknown>("get_native_agent_projection", {
    environmentId,
    agent: tab.agent,
    logicalSessionKey: nativeTabLogicalSessionKey(environmentId, tabId),
    messageLimit: 1,
  });
  const interactions =
    isRecord(projection) && Array.isArray(projection.interactions) ? projection.interactions : [];
  const request = interactions.find(
    (candidate) => isRecord(candidate) && candidate.id === interactionId,
  );
  if (!request || !isRecord(request) || request.state !== "pending")
    throw new Error(
      "That tab has no pending interaction with that id (it was answered, withdrawn or its turn ended). Read state.interactions from get_tab_state.",
    );
  if (!isAgentInteractionRequest(request))
    throw new Error("That interaction cannot be read; the user answers it in the worker's tab.");
  return { request, ...(tab.title ? { tabName: tab.title } : {}) };
}

export type WorkerAnswerOutcome = { result: "answered" } | { result: "stale"; reason: string };

/**
 * Answer one worker question with answers the user approved, where the
 * worker lives. Never answers anything but the pending question revision the
 * request named; every doubt refuses or settles stale.
 */
export async function answerWorkerQuestion(
  context: CommandContext,
  run: <T>(context: CommandContext, command: string, args: JsonRecord) => Promise<T>,
  args: JsonRecord,
): Promise<WorkerAnswerOutcome> {
  const projectId = asNonBlankString(args.projectId, "projectId");
  const environmentId = asNonBlankString(args.environmentId, "environmentId");
  const tabId = requiredText(args.tabId, "tabId", 200);
  const interactionId = requiredText(args.interactionId, "interactionId", 512);
  const revision = args.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Expected the question's revision");
  const answers = parseWorkerQuestionAnswers(args.answers);
  if (!(await context.storage.getEnvironment(environmentId)))
    return { result: "stale", reason: "The worker environment no longer exists." };
  const environment = await requireProjectWorker(context, projectId, environmentId);
  const layout = await context.storage.getPaneLayout(environment.id);
  const tab = nativeTabsOfLayout(layout).find((candidate) => candidate.tabId === tabId);
  if (!tab) return { result: "stale", reason: "The worker's tab was closed." };
  const native = context.nativeAgents;
  if (!native) throw new Error("Agent sessions are unavailable on this node; nothing was sent.");
  const identity = {
    environmentId: environment.id,
    agent: tab.agent,
    logicalSessionKey: nativeTabLogicalSessionKey(environment.id, tabId),
  };
  const pending = await native.sessionPendingInteractions(identity);
  if (pending === null)
    throw new Error("The worker's pending questions cannot be read right now; nothing was sent.");
  const request = pending.find((candidate) => candidate.id === interactionId);
  if (!request || request.state !== "pending")
    return {
      result: "stale",
      reason:
        "The question was no longer waiting (answered in the tab, withdrawn, or its turn ended).",
    };
  if (request.revision !== revision)
    return { result: "stale", reason: "The question changed after the coordinator read it." };
  if (typeof request.expiresAt === "number" && request.expiresAt <= Date.now())
    return { result: "stale", reason: "The question had expired." };
  const problem = answerProblem(request, answers);
  if (problem) throw new Error(`${problem} Nothing was sent.`);
  const outcome = await run<{ result?: unknown }>(context, "resolve_native_agent_interaction", {
    ...identity,
    interactionId: request.id,
    resolution: workerAnswerResolution(request, answers),
  });
  if (outcome?.result === "applied") return { result: "answered" };
  if (outcome?.result === "stale" || outcome?.result === "already-resolved")
    return {
      result: "stale",
      reason: "The question was answered or replaced in the meantime.",
    };
  if (outcome?.result === "provider-unavailable")
    throw new Error(
      "The worker's agent is unavailable; the question is still pending and nothing was sent.",
    );
  throw new Error("The worker's agent refused the answer; the question is still pending.");
}

export function registerWorkerQuestionRelayCommands(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const run = async <T>(context: CommandContext, command: string, args: JsonRecord): Promise<T> => {
    const handler = dependencies.commands.get(command);
    if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
    return (await handler(args, context)) as T;
  };

  register("request_coordinator_worker_answer", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = surfaceRecord(args.input, "the proposed answer");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const tabId = requiredText(input.tabId, "tabId", 200);
    const interactionId = requiredText(
      input.interactionId,
      "interactionId",
      WORKER_QUESTION_RELAY_LIMITS.idChars,
    );
    const reason = requiredText(input.reason, "reason", 500).replace(/\s+/g, " ");
    const answers = parseWorkerQuestionAnswers(input.answers);
    const nodeId = optionalText(input.nodeId, "nodeId", 200);
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
      caller.coordinatorId,
    );
    const conversation = workspace?.conversations.find((item) => item.id === caller.conversationId);
    if (!conversation) throw new Error("This coordinator conversation has no mailbox");
    // The capability check already keeps side agents out; this is the backstop.
    if (conversation.role === "side")
      throw new Error("Only the main coordinator can propose an answer to a worker");
    const selfId = (await context.nodes?.status())?.nodeId;
    const remote =
      nodeId && nodeId !== selfId
        ? await coordinatorNodeTarget(context, caller.projectId, nodeId)
        : undefined;
    const environment = remote
      ? await remote.environment(asNonBlankString(input.environmentId, "environmentId"))
      : await requireProjectWorker(context, caller.projectId, input.environmentId);
    const environmentId = String(environment.id);
    return withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "request-worker-answer",
        payload: {
          environmentId,
          tabId,
          interactionId,
          answers,
          reason,
          ...(remote ? { nodeId: remote.nodeId } : {}),
        },
      },
      async () => {
        const inv: Invoke = remote
          ? (command, commandArgs = {}) => remote.call(command, commandArgs)
          : (command, commandArgs = {}) => run(context, command, commandArgs);
        const { request, tabName } = await readPendingInteraction(
          inv,
          environmentId,
          tabId,
          interactionId,
        );
        const problem = answerProblem(request, answers);
        if (problem) throw new Error(problem);
        const relay: WorkerQuestionRelay = {
          tabId,
          ...(tabName ? { tabName } : {}),
          interactionId: request.id,
          revision: request.revision,
          title: request.presentation.title.slice(0, WORKER_QUESTION_RELAY_LIMITS.titleChars),
          questions: workerQuestionViews(request),
          proposed: answers,
        };
        const self = remote ? null : await run<JsonRecord>(context, "get_node_status", {});
        const created = await run<JsonRecord>(context, "create_node_action_request", {
          requestId: `worker-answer-coordinator-${createHash("sha256")
            .update(`${caller.coordinatorId}\0${requestId}`)
            .digest("hex")
            .slice(0, 24)}`,
          kind: "answer-worker-question",
          targets: [
            {
              nodeId: remote ? remote.nodeId : self?.nodeId,
              nodeName: remote ? remote.nodeName : "this machine",
              environmentId,
              ...(typeof environment.name === "string"
                ? { environmentName: environment.name }
                : {}),
              projectId: remote ? remote.projectId : caller.projectId,
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
          workerQuestion: relay,
        });
        return {
          environmentId,
          tabId,
          interactionId: request.id,
          ...(remote ? { nodeId: remote.nodeId } : {}),
          approvalRequestId: created.requestId,
          state: "pending",
        };
      },
    );
  });

  /** Runs only from an approved `answer-worker-question` request for a worker here. */
  register("answer_project_worker_question", (args, context) =>
    answerWorkerQuestion(context, run, args),
  );

  /**
   * The same, for a command node's approved request: reachable only through
   * the node link (`isWorkspaceExcludedCommand`), and the request's own
   * node checks the worker's project here again.
   */
  register("answer_controller_worker_question", (args, context) =>
    answerWorkerQuestion(context, run, args),
  );
}

/**
 * What the shared Control MCP tool modules have in common: the context
 * `createControlMcp` gives them and the delegation helpers more than one
 * of them uses.
 */
import { coordinatorCallTurnOrigin } from "@orkestrator/protocol/coordinator";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { ControlMcpCaller } from "./control-mcp-caller.js";
import type { createNodeTargets, NodeTarget } from "./control-mcp-nodes.js";
import type { CoordinatorPollGuard } from "./control-mcp-poll-guard.js";
import { isRecord, type JsonRecord } from "./control-mcp-tool-support.js";
import type { CoordinatorControlScope } from "./control-mcp-tools.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

const log = createLogger("control-mcp");

export const MAX_PROMPT_LENGTH = 100_000;

/**
 * What `createControlMcp` hands each tool module: the invoker, the caller's
 * scope, and the node routing it builds once per request.
 */
export interface ControlMcpToolContext {
  invoke: ControlMcpInvoker;
  coordinatorScope?: CoordinatorControlScope;
  /** An operator credential's caller; absent for coordinators. */
  operator?: ControlMcpCaller;
  /** This conversation's poll guard; absent outside a coordinator request. */
  pollGuard?: CoordinatorPollGuard;
  messagingEnabled: boolean;
  nodes: ReturnType<typeof createNodeTargets> | null;
  onNode(nodeId: string | undefined): Promise<NodeTarget | null>;
  onNodeResult(target: NodeTarget | null): JsonRecord;
  nodeTickets(
    nodeId: string | undefined,
    projectId: string,
    action: "create" | "get" | "list" | "update" | "comment",
    input: JsonRecord,
  ): Promise<JsonRecord | null>;
  environmentInvoker(
    nodeId: string | undefined,
    environmentId: string,
  ): Promise<{
    inv: ControlMcpInvoker;
    target: NodeTarget | null;
    where: JsonRecord;
    layout(): Promise<unknown>;
  }>;
}

/**
 * Whether a coordinator call's delegated prompt says it arose from agent mail:
 * the scope's own origin (a scheduled fire's), else the conversation's newest
 * turn. A conversation that cannot be read counts as mail, so a failed read
 * marks the prompt rather than sending it as the user's.
 */
export async function coordinatorScopeTurnOrigin(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): Promise<"mail" | undefined> {
  if (scope.turnOrigin) return coordinatorCallTurnOrigin(undefined, scope.turnOrigin);
  const snapshot = await invoke<unknown>("get_project_coordinator", {
    projectId: scope.projectId,
  }).catch((error: unknown) => {
    log.warn("delegation.turn-origin-unreadable", { error: formatLogError(error) });
    return null;
  });
  const workspace = isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
  const conversation =
    workspace?.id === scope.coordinatorId && Array.isArray(workspace.conversations)
      ? workspace.conversations.find(
          (item: unknown) => isRecord(item) && item.id === scope.conversationId,
        )
      : undefined;
  return coordinatorCallTurnOrigin(
    isRecord(conversation) ? conversation.lastTurnOrigin : undefined,
  );
}

/**
 * What every coordinator delegation tool says about what happens next.
 *
 * Carried on the result rather than left to the prompt because this is the
 * answer to the question the model is actually asking at that moment — "is it
 * done yet?" — and a tool that returns `accepted` with nothing else invites a
 * poll loop as the only obvious way to find out.
 */
export function asyncDelegationResult(): JsonRecord {
  return {
    delivery: "async",
    wake: "This conversation will be woken with a message when the worker's turn ends. Progress the worker sends before then is held and delivered with that wake, so silence means it is still working.",
    nextStep: "Finish your turn now. Do not poll.",
  };
}

/** The same as `tryOpenCoordinatorDelegation`, for a worker on another node. */
export async function tryOpenNodeDelegation(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
  worker: {
    nodeId: string;
    environmentId: string;
    tabId: string;
    requestId: string;
    request: unknown;
  },
): Promise<boolean> {
  try {
    const result = await invoke<unknown>("open_coordinator_node_delegation", {
      scope,
      ...worker,
    });
    return isRecord(result) && result.opened === true;
  } catch (error) {
    log.warn("delegation.remote-open-failed", { error: formatLogError(error) });
    return false;
  }
}

export async function tryOpenCoordinatorDelegation(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
  input: { environmentId: string; tabId: string; requestId: string; request: unknown },
): Promise<boolean> {
  try {
    const result = await invoke<unknown>("open_coordinator_delegation", { scope, ...input });
    return isRecord(result) && result.opened === true;
  } catch (error) {
    log.warn("delegation.open-failed", { error: formatLogError(error) });
    return false;
  }
}

/** Mailbox listings and projects of a coordinator are its own node's. */
export function coordinatorNodeRefused(nodeId: string | undefined): void {
  if (nodeId) {
    throw new Error(
      "This tool acts on the coordinator's own node; other nodes take mail, tickets and launches.",
    );
  }
}

/** A coordinator's worker prompts ask for commits and focused checks, never a pull request (see COORDINATOR_PR_RULE, COORDINATOR_VALIDATION_RULE). */
export const COORDINATOR_WORKER_PROMPT_NOTE =
  "Never ask the worker to open a pull request: ask it to commit and report back; the pull request comes from a PR tab after review. State whether review follows. When review follows, ask for focused checks rather than a full test suite: review runs full validation itself. When no review follows, explicitly request all validation required by the repository before handoff.";

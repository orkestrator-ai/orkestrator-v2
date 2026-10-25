/**
 * Transcript-artifact authority for dispatched turns, shared by the native
 * agent service and the backend workflows that drive providers directly
 * (Multi Review reviewers, build-pipeline stages, feature planning).
 *
 * Every turn goes through the same `ArtifactTurnDispatch` the backend wires
 * once (`core/index.ts`): `beginTurn` attributes the conversation's artifact
 * calls to the turn and, when asked, mints the turn's artifact-only grant;
 * `settleTurn` revokes it. Ownership is the conversation key and environment
 * the caller passes, which is always the backend's own record of the session
 * (a workflow session's key, a native logical session key), never anything a
 * model supplied.
 *
 * A workflow turn has no tab-scoped credential, so it always needs a grant,
 * and the grant reaches the agent the way its provider can carry it:
 *
 *  - OpenCode keeps its environment-wide `orkestrator` registration beside
 *    the workflow-result broker, so the grant travels as the prompt's trusted
 *    system instruction (`artifactGrant`), exactly as a native OpenCode turn.
 *  - The HTTP bridges replace their `orkestrator` server with the attempt's
 *    restricted workflow-result server in tool mode. The grant is added to
 *    that connection as `agentMcp.artifacts`, and the bridge adds a second,
 *    artifact-only `orkestrator-artifacts` server authenticated by it. The
 *    workflow-result credential itself never gains artifact authority.
 *
 * A turn with neither path (an HTTP bridge turn without a tool-mode
 * connection) gets no grant at all rather than one nobody can use.
 */
import type { AgentToolConnection } from "./agent-tools.js";

/** The backend's per-turn artifact bookkeeping (`NativeAgentServiceOptions.artifactDispatch`). */
export interface ArtifactTurnDispatch {
  beginTurn(input: {
    environmentId: string;
    projectId: string;
    conversationKey: string;
    turnId: string;
    providerSessionId: string;
    needsGrant: boolean;
  }): { grant?: string };
  settleTurn(environmentId: string, conversationKey: string, turnId: string): void;
  /**
   * Whether artifact tools are served at all (publication rollout). A
   * workflow turn gets no grant and no artifact server while they are not,
   * so a bridge never connects to a server that would refuse it.
   */
  toolsEnabled?(): boolean;
}

export type ArtifactTurnInput = Parameters<ArtifactTurnDispatch["beginTurn"]>[0];

/** Begin a turn's artifact bookkeeping. Best-effort: it never blocks a prompt. */
export function beginArtifactDispatchTurn(
  dispatch: ArtifactTurnDispatch | undefined,
  input: ArtifactTurnInput,
): string | undefined {
  if (!dispatch) return undefined;
  try {
    return dispatch.beginTurn(input).grant;
  } catch {
    return undefined;
  }
}

/** Revoke a turn's grants. Grants also expire on their own; best-effort. */
export function settleArtifactDispatchTurn(
  dispatch: ArtifactTurnDispatch | undefined,
  environmentId: string,
  conversationKey: string,
  turnId: string,
): void {
  try {
    dispatch?.settleTurn(environmentId, conversationKey, turnId);
  } catch {
    // Settlement is best-effort.
  }
}

/** Send options that carry a workflow turn's artifact grant to its agent. */
export interface WorkflowArtifactTurnOptions {
  /** The turn's connection with its artifact-only server added (HTTP bridges). */
  agentMcp?: AgentToolConnection;
  /** Trusted per-turn instruction (OpenCode). */
  artifactGrant?: string;
}

export interface WorkflowArtifactTurnInput {
  environmentId: string;
  projectId: string;
  /** The workflow session's own durable key; the publication's conversation. */
  conversationKey: string;
  /** The dispatched request id; grants are revoked when it settles. */
  turnId: string;
  providerSessionId: string;
  agent: string;
  /** The turn's own Orkestrator connection (tool mode), if any. */
  agentMcp?: AgentToolConnection;
}

/**
 * Begin a workflow turn's artifact authority and return the send options
 * that deliver it, or undefined when the provider has no path for it.
 */
export function beginWorkflowArtifactTurn(
  dispatch: ArtifactTurnDispatch | undefined,
  input: WorkflowArtifactTurnInput,
): WorkflowArtifactTurnOptions | undefined {
  const opencode = input.agent === "opencode";
  if (!dispatch || (!opencode && !input.agentMcp)) return undefined;
  try {
    if (dispatch.toolsEnabled?.() === false) return undefined;
  } catch {
    return undefined;
  }
  const grant = beginArtifactDispatchTurn(dispatch, {
    environmentId: input.environmentId,
    projectId: input.projectId,
    conversationKey: input.conversationKey,
    turnId: input.turnId,
    providerSessionId: input.providerSessionId,
    needsGrant: true,
  });
  if (!grant) return undefined;
  if (opencode) return { artifactGrant: grant };
  return { agentMcp: { ...input.agentMcp!, artifacts: { token: grant } } };
}

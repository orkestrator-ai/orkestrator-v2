import type { AgentActivityState } from "./agent-activity.js";
import type { CoordinatorWorkspace } from "./coordinator.js";

/**
 * What a project's coordinator icon shows, the same states an environment
 * row's marker uses: a spinner while any of its open conversations works, a
 * pulsing halo while one waits on the user and none works. Idle is absence.
 */
export type CoordinatorActivityState = Exclude<AgentActivityState, "idle">;

/**
 * Every project on this backend whose coordinator is not idle, keyed by
 * project id. Read from the backend's activity observer, so it is the same
 * observation the environment markers and mail delivery use.
 */
export interface CoordinatorActivitySnapshot {
  projects: Record<string, CoordinatorActivityState>;
}

export const COORDINATOR_ACTIVITY_COMMAND = "list_coordinator_activity";

/** The one session an open, assigned conversation is observed through. */
export interface CoordinatorConversationSession {
  conversationId: string;
  agent: NonNullable<CoordinatorWorkspace["conversations"][number]["agent"]>;
  logicalSessionKey: string;
}

/**
 * Reduce each workspace's open conversations to one state. Working outranks
 * waiting, as `aggregateAgentActivityState` does for an environment. A
 * workspace that is not `ready` is not swept by the observer, so whatever it
 * last recorded is stale and is not shown.
 */
export function coordinatorActivityByProject(
  workspaces: readonly CoordinatorWorkspace[],
  observe: (
    workspace: CoordinatorWorkspace,
    session: CoordinatorConversationSession,
  ) => AgentActivityState | "unknown",
): Record<string, CoordinatorActivityState> {
  const projects: Record<string, CoordinatorActivityState> = {};
  for (const workspace of workspaces) {
    if (workspace.lifecycleState !== "ready") continue;
    for (const conversation of workspace.conversations) {
      if (conversation.closedAt || !conversation.agent) continue;
      const state = observe(workspace, {
        conversationId: conversation.id,
        agent: conversation.agent,
        logicalSessionKey: conversation.logicalSessionKey,
      });
      if (state === "working") {
        projects[workspace.projectId] = "working";
        break;
      }
      if (state === "waiting") projects[workspace.projectId] = "waiting";
    }
  }
  return projects;
}

/** Accepts a snapshot from any backend; anything malformed reads as no activity. */
export function parseCoordinatorActivitySnapshot(value: unknown): CoordinatorActivitySnapshot {
  const projects: Record<string, CoordinatorActivityState> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { projects };
  const raw = (value as { projects?: unknown }).projects;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { projects };
  for (const [projectId, state] of Object.entries(raw)) {
    if (projectId && (state === "working" || state === "waiting")) projects[projectId] = state;
  }
  return { projects };
}

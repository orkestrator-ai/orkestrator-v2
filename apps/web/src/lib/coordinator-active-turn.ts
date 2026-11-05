import { coordinatorRuntimeId, type CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import type {
  NativeAgentSessionProjection,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import { createSessionKey } from "@/lib/utils";

/** How the project home is named where a conversation's title would be. */
export const PROJECT_HOME_TURN_LABEL = "Home";

export function isCoordinatorTurnPhaseActive(phase: NativeAgentTurnPhase | undefined): boolean {
  return (
    phase === "running" || phase === "blocked" || phase === "cancelling" || phase === "recovering"
  );
}

export interface CoordinatorActiveTurnScope {
  workspace: CoordinatorWorkspace | undefined;
  /** Only these conversations; every open one when absent. */
  conversationIds?: ReadonlySet<string>;
  homeEnvironmentIds: ReadonlySet<string>;
  projections: ReadonlyMap<string, NativeAgentSessionProjection>;
}

/**
 * Who is running a turn, by the name the user knows them by: a conversation's
 * title or {@link PROJECT_HOME_TURN_LABEL}. A string or null, so a store selector
 * built on this does not re-render on every projection change.
 *
 * A projection is written only by a mounted tab, so one whose tab has gone behind
 * another keeps its last phase. Callers that have the backend's answer read
 * this for the conversations they have mounted, and not for the rest.
 */
export function activeCoordinatorTurnLabel({
  workspace,
  conversationIds,
  homeEnvironmentIds,
  projections,
}: CoordinatorActiveTurnScope): string | null {
  for (const item of workspace?.conversations ?? []) {
    if (item.closedAt || !item.agent || (conversationIds && !conversationIds.has(item.id))) {
      continue;
    }
    const sessionKey = createSessionKey(coordinatorRuntimeId(workspace!.id, item.id), item.tabId);
    if (isCoordinatorTurnPhaseActive(projections.get(sessionKey)?.turn.phase)) return item.title;
  }
  if (homeEnvironmentIds.size > 0) {
    for (const projection of projections.values()) {
      if (
        homeEnvironmentIds.has(projection.environmentId) &&
        isCoordinatorTurnPhaseActive(projection.turn.phase)
      ) {
        return PROJECT_HOME_TURN_LABEL;
      }
    }
  }
  return null;
}

/** The environments that are this project's home, whose turns also hold its checkout. */
export function projectHomeEnvironmentIds(
  environments: readonly { id: string; projectId: string; projectHome?: boolean }[],
  projectId: string,
): ReadonlySet<string> {
  return new Set(
    environments
      .filter((environment) => environment.projectId === projectId && environment.projectHome)
      .map((environment) => environment.id),
  );
}

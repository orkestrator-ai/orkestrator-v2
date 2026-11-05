import type { CoordinatorCheckoutTurn } from "@orkestrator/protocol/coordinator-activity";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NativeAgentService } from "./native-agent-service.js";
import type { StorageService } from "./storage.js";

const ACTIVE_PROJECTION_PHASES = ["running", "blocked", "cancelling", "recovering"];

export interface CoordinatorCheckoutTurnSources {
  storage: Pick<StorageService, "getEnvironmentsByProject" | "coordinators">;
  nativeAgents: Pick<
    NativeAgentService,
    "hasActiveCheckoutWork" | "sessionTurnActivitySnapshot" | "getProjection"
  >;
  /**
   * Also read each conversation's projection when the observer has not seen it
   * working. A mutation admission wants that certainty; a view does not, because
   * a projection read reaches the session and this may be re-read on every
   * activity hint.
   */
  confirmWithProjections: boolean;
}

/**
 * The turn holding the project's checkout, or null. The one definition behind
 * both the refusal of a branch switch or sync and the panel's disabled controls.
 */
export async function findCoordinatorCheckoutTurn(
  projectId: string,
  { storage, nativeAgents, confirmWithProjections }: CoordinatorCheckoutTurnSources,
): Promise<CoordinatorCheckoutTurn | null> {
  for (const home of await storage.getEnvironmentsByProject(projectId)) {
    if (home.projectHome && (await nativeAgents.hasActiveCheckoutWork(home.id))) {
      return { kind: "project-home" };
    }
  }
  const workspace = await storage.coordinators.getCoordinatorWorkspace(projectId);
  if (!workspace) return null;
  for (const conversation of workspace.conversations) {
    if (conversation.closedAt || !conversation.agent) continue;
    const runtimeId = coordinatorRuntimeId(workspace.id, conversation.id);
    // The turn view, not the indicator view: a coordinator conversation
    // whose composer is free is not holding this project's git, even when
    // a background task it launched keeps the environment pulsing.
    const observed = nativeAgents.sessionTurnActivitySnapshot(
      runtimeId,
      conversation.agent,
      conversation.logicalSessionKey,
    );
    const turn = { kind: "conversation", conversationId: conversation.id } as const;
    if (observed === "working" || observed === "waiting") return turn;
    if (!confirmWithProjections) continue;
    const projection = await nativeAgents
      .getProjection({
        environmentId: runtimeId,
        agent: conversation.agent,
        logicalSessionKey: conversation.logicalSessionKey,
        messageLimit: 1,
      })
      .catch(() => null);
    if (projection && ACTIVE_PROJECTION_PHASES.includes(projection.turn.phase)) return turn;
  }
  return null;
}

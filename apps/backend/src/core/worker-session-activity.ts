import type { NativeAgentService } from "./native-agent-service.js";
import type { StorageService } from "./storage.js";

/** Read the same worker session and turn views locally and over the node link. */
export async function workerSessionActivity(
  storage: StorageService,
  nativeAgents:
    Pick<NativeAgentService, "sessionActivitySnapshot" | "sessionTurnActivitySnapshot"> | undefined,
  environmentId: string,
  tabId: string,
) {
  const key = `env-${environmentId}:${tabId}`;
  const session = (await storage.listNativeAgentSessions()).find(
    (candidate) => candidate.environmentId === environmentId && candidate.logicalSessionKey === key,
  );
  if (!session || !nativeAgents)
    return {
      turn: "unknown" as const,
      backgroundWorkPending: false,
      requestPending: Boolean(session?.pendingDispatch),
    };
  const turn = nativeAgents.sessionTurnActivitySnapshot(environmentId, session.agent, key);
  return {
    turn,
    requestPending: Boolean(session.pendingDispatch),
    // This signal also includes long-lived servers/watchers, so callers must bound the hold.
    backgroundWorkPending:
      turn === "idle" &&
      nativeAgents.sessionActivitySnapshot(environmentId, session.agent, key) === "working",
  };
}

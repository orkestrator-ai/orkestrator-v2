import { sessionGoal, type NativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";
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
  if (!session || !nativeAgents) return { turn: "unknown" as const, backgroundWorkPending: false };
  const turn = nativeAgents.sessionTurnActivitySnapshot(environmentId, session.agent, key);
  return {
    turn,
    // This signal also includes long-lived servers/watchers, so callers must bound the hold.
    backgroundWorkPending:
      turn === "idle" &&
      nativeAgents.sessionActivitySnapshot(environmentId, session.agent, key) === "working",
  };
}

/** The goal on a worker tab's session record. Durable, so it holds across a restart. */
export async function workerSessionGoal(
  storage: Pick<StorageService, "listNativeAgentSessions">,
  environmentId: string,
  tabId: string,
): Promise<NativeAgentGoal | undefined> {
  const key = `env-${environmentId}:${tabId}`;
  const session = (await storage.listNativeAgentSessions()).find(
    (candidate) => candidate.environmentId === environmentId && candidate.logicalSessionKey === key,
  );
  return session ? sessionGoal(session) : undefined;
}

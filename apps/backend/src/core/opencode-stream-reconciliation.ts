import {
  boundedOpenCodeMessageHistory,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
} from "@orkestrator/protocol/opencode-message-id";
import { OpenCodeSessionLifecycle } from "./opencode-session-lifecycle.js";
import { OpenCodeStreamState } from "./opencode-stream-state.js";

export async function reconcileOpenCodeStreamState(options: {
  disposed: () => boolean;
  lifecycle: OpenCodeSessionLifecycle;
  streamState: OpenCodeStreamState;
  now: () => number;
  invalidateMetadata: () => void;
  readMessages: (sessionId: string, limit: number) => Promise<unknown[]>;
  reconciled: (sessionId: string) => void;
}): Promise<void> {
  if (options.disposed()) return;
  const sessionIds = Array.from(options.lifecycle.ownedSessions);
  if (sessionIds.length === 0) return;
  options.streamState.markGap();
  const eventVersions = new Map(
    sessionIds.map((sessionId) => [sessionId, options.streamState.eventVersion(sessionId)]),
  );
  options.invalidateMetadata();
  const reconcileStartedAt = options.now();
  const lifecycle = await options.lifecycle.readSessionLifecycle(sessionIds, true, true);
  // A reconnect read predating a new dispatch cannot end that new turn.
  for (const sessionId of sessionIds) {
    if (lifecycle.get(sessionId) === "running") continue;
    const turnStartedAt = options.streamState.turnStartedAt(sessionId);
    if (
      eventVersions.get(sessionId) === options.streamState.eventVersion(sessionId) &&
      (turnStartedAt === undefined || turnStartedAt <= reconcileStartedAt)
    ) {
      options.streamState.endTurn(sessionId);
      options.reconciled(sessionId);
    }
  }
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (!options.disposed()) {
      const sessionId = sessionIds[cursor++];
      if (!sessionId) return;
      try {
        const eventVersion = options.streamState.eventVersion(sessionId);
        const messages = [
          ...boundedOpenCodeMessageHistory(
            await options.readMessages(sessionId, OPEN_CODE_MESSAGE_HISTORY_LIMIT),
            { count: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
          ),
        ];
        options.streamState.replaceMessages(sessionId, messages, eventVersion);
      } catch {
        // A dirty transcript is retried by the next authoritative read.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sessionIds.length) }, () => worker()));
}

import type { SessionState } from "../../types/index.js";
import { sessions } from "../session-manager-core.js";
import { createPromptStreamState } from "../session-manager-prompt-stream.js";
import {
  captureTurnStartup,
  createTurnState,
  type TurnState,
} from "../session-manager-prompt-turn.js";

/**
 * A running turn on a bare session, for driving handlers directly. Not a
 * suite itself: `.ts`, not `.test.ts`. Call `dispose` once the test is done.
 */
export function turnFixture(options: { registered?: boolean } = {}): {
  session: SessionState;
  turn: TurnState;
  dispose: () => void;
} {
  const session = {
    id: `session-handler-${crypto.randomUUID()}`,
    messages: [],
    status: "running",
    createdAt: new Date(),
    lastActivity: new Date(),
  } as unknown as SessionState;
  const stream = createPromptStreamState(session, session.id, {
    flushIntervalMs: 100,
    maxBlockIndex: 4_095,
  });
  const turn = createTurnState(session, session.id, {
    options: undefined,
    structuredRequestId: undefined,
    userMessage: {
      id: "prompt",
      role: "user",
      content: "hi",
      parts: [{ type: "text", content: "hi" }],
      createdAt: new Date().toISOString(),
    },
    dispatchRequestId: undefined,
    beforeStartup: captureTurnStartup(session),
    abortController: new AbortController(),
    turnGeneration: 1,
    stream,
    bootstrapClaudeUsage: false,
    transcriptHydrationFailed: false,
  });
  if (options.registered) sessions.set(session.id, session);
  return {
    session,
    turn,
    dispose: () => {
      stream.clearFlushTimer();
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    },
  };
}

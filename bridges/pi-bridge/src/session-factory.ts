/**
 * Fresh bridge session state.
 *
 * Kept apart from `agent-session.ts` so persistence can rebuild a restored
 * session without importing the session lifecycle that itself schedules
 * persistence.
 */
import { randomBytes } from "node:crypto";
import { RuntimeHealthRecorder } from "@orkestrator/protocol/runtime-health";
import { emptyComposer } from "./models.js";
import type { SessionState } from "./state.js";

export function newSessionState(
  clientSessionKey?: string,
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy,
): SessionState {
  return {
    id: randomBytes(16).toString("hex"),
    ...(policy ? { policy } : {}),
    ...(clientSessionKey ? { clientSessionKey } : {}),
    status: "idle",
    messages: [],
    droppedMessages: 0,
    droppedParts: 0,
    transcriptTruncated: false,
    revision: 0,
    structured: new Map(),
    promptJournal: new Map(),
    // Fail safe: only `createSession`'s fresh path and a clean restore of a
    // complete record may set it.
    promptJournalComplete: false,
    steerJournal: new Map(),
    pendingSteerDeliveries: [],
    approvals: new Map(),
    todos: [],
    composer: emptyComposer(),
    session: null,
    dispatching: false,
    promptSequence: 0,
    openTextParts: new Map(),
    toolInputs: new Map(),
    uncheckedTranscriptBytes: 0,
    queue: { steering: [], followUp: [] },
    slashCommands: [],
    commandCatalogue: { status: "stale", revision: 0 },
    compacting: false,
    lastAccessed: Date.now(),
    health: new RuntimeHealthRecorder(),
  };
}

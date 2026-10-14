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
    steerJournal: new Map(),
    steerJournalBytes: 0,
    activeSubagentDescriptors: new Map(),
    subagentLimitExceeded: false,
    todos: [],
    composer: emptyComposer(),
    agent: null,
    dispatching: false,
    promptSequence: 0,
    openTextParts: new Map(),
    uncheckedTranscriptBytes: 0,
    currentTurnOutput: null,
    lastAccessed: Date.now(),
    observedMcpTools: new Set(),
    health: new RuntimeHealthRecorder(),
  };
}

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { boundTranscriptResponse } from "@orkestrator/protocol/transcript-window";
import {
  MAX_PERSISTED_PROMPT_JOURNAL_BYTES,
  MAX_PERSISTED_SESSION_CONFIG_BYTES,
  MAX_PERSISTED_STRUCTURED_BYTES,
  MAX_STATE_FILE_BYTES,
  PERSISTED_WINDOW_METADATA_RESERVE_BYTES,
  persistenceScheduled,
  persistenceTail,
  provider,
  sessions,
  setPersistenceScheduled,
  setPersistenceTail,
  stateFile,
} from "./acp-context.js";
import type { PersistedState, PromptJournalEntry } from "./acp-context.js";
import type { AcpNormalizedSessionConfig } from "./session-config.js";

/**
 * Writing the bounded state file, and the coalescing scheduler the rest of
 * the bridge signals through.
 *
 * Deliberately separate from `acp-persistence`, which *restores* state and so
 * legitimately sits above `acp-tools` and `acp-transcript`. Those two modules
 * only ever need to say "state changed, save it eventually", and hosting
 * `schedulePersist` alongside the restore path made them back-edges into it.
 * Nothing here may import `acp-persistence`, `acp-tools` or `acp-transcript`.
 */

export function boundPersistedSnapshot(snapshot: PersistedState): PersistedState {
  const bounded: PersistedState = {
    ...snapshot,
    sessions: snapshot.sessions.map((session) => ({
      ...session,
      messages: [...session.messages],
      structured: [...session.structured],
    })),
  };
  const metadataOnly: PersistedState = {
    ...bounded,
    sessions: bounded.sessions.map((session) => ({ ...session, messages: [] })),
  };
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadataOnly)) + 1;
  if (metadataBytes > MAX_STATE_FILE_BYTES) {
    throw new Error("ACP persisted session metadata exceeds its byte limit");
  }

  const candidates = bounded.sessions.map((session, index) => ({
    index,
    extraBytes: Math.max(0, Buffer.byteLength(JSON.stringify(session.messages)) - 2),
  }));
  let remaining = Math.max(
    0,
    MAX_STATE_FILE_BYTES - metadataBytes - PERSISTED_WINDOW_METADATA_RESERVE_BYTES,
  );
  const allocations = new Map<number, number>();
  let pending = candidates.filter((candidate) => candidate.extraBytes > 0);
  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const fitting = pending.filter((candidate) => candidate.extraBytes <= share);
    if (fitting.length === 0) {
      for (const candidate of pending) allocations.set(candidate.index, share);
      remaining = 0;
      break;
    }
    const fittingIndexes = new Set(fitting.map((candidate) => candidate.index));
    for (const candidate of fitting) {
      allocations.set(candidate.index, candidate.extraBytes);
      remaining -= candidate.extraBytes;
    }
    pending = pending.filter((candidate) => !fittingIndexes.has(candidate.index));
  }

  for (const candidate of candidates) {
    const session = bounded.sessions[candidate.index]!;
    const allocation = allocations.get(candidate.index) ?? 0;
    if (candidate.extraBytes <= allocation) continue;
    const targetBytes = allocation + 2;
    const originalCount = session.messages.length;
    const windowed = boundTranscriptResponse(session.messages, targetBytes, {
      envelopeReserveBytes: 0,
      contentFallbackBytes: Math.max(0, Math.min(
        1024 * 1024,
        targetBytes - 4 * 1024,
      )),
    });
    session.messages = windowed.overflowed ? [] : windowed.messages;
    const omittedMessages = windowed.overflowed
      ? originalCount
      : windowed.messageWindow.omittedMessages ?? 0;
    const omittedParts = windowed.overflowed
      ? 0
      : windowed.messageWindow.omittedParts ?? 0;
    session.droppedMessages = (session.droppedMessages ?? 0) + omittedMessages;
    session.droppedParts = (session.droppedParts ?? 0) + omittedParts;
    session.transcriptTruncated = true;
  }
  return bounded;
}

export function persistedSnapshot(): PersistedState {
  let retainedStructuredBytes = 0;
  let retainedPromptJournalBytes = 0;
  let retainedSessionConfigBytes = 0;
  const structuredBySession = new Map<string, Array<[string, unknown]>>();
  const promptJournalBySession = new Map<string, PromptJournalEntry[]>();
  const sessionConfigBySession = new Map<string, AcpNormalizedSessionConfig>();
  const newestSessions = [...sessions.values()].reverse();
  // Prefer the newest sessions and newest results while enforcing one global
  // budget for the single state file that owns all of them.
  for (const state of newestSessions) {
    const retained: Array<[string, unknown]> = [];
    for (const entry of [...state.structured.entries()].reverse()) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (retainedStructuredBytes + bytes > MAX_PERSISTED_STRUCTURED_BYTES) continue;
      retained.unshift(entry);
      retainedStructuredBytes += bytes;
    }
    structuredBySession.set(state.id, retained);
    promptJournalBySession.set(state.id, []);

    const configBytes = Buffer.byteLength(JSON.stringify(state.sessionConfig));
    if (retainedSessionConfigBytes + configBytes <= MAX_PERSISTED_SESSION_CONFIG_BYTES) {
      sessionConfigBySession.set(state.id, state.sessionConfig);
      retainedSessionConfigBytes += configBytes;
    }
  }
  const retainJournalEntries = (unfinished: boolean): void => {
    for (const state of newestSessions) {
      const retained = promptJournalBySession.get(state.id)!;
      for (const rawEntry of [...state.promptJournal.values()].reverse()) {
        const isUnfinished = rawEntry.state === "prepared" || rawEntry.state === "accepted";
        if (isUnfinished !== unfinished) continue;
        const entry = isUnfinished
          ? { ...rawEntry, state: "ambiguous" as const }
          : rawEntry;
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        if (retainedPromptJournalBytes + bytes > MAX_PERSISTED_PROMPT_JOURNAL_BYTES) continue;
        retained.unshift(entry);
        retainedPromptJournalBytes += bytes;
      }
    }
  };
  // A live prepared or accepted dispatch becomes ambiguous after restart and
  // must win over completed history: dropping it could execute the same prompt
  // a second time.
  retainJournalEntries(true);
  retainJournalEntries(false);
  const snapshot: PersistedState = {
    version: 3,
    provider,
    sessions: [...sessions.values()].map((state) => ({
      id: state.id,
      ...(state.clientSessionKey ? { clientSessionKey: state.clientSessionKey } : {}),
      acpSessionId: state.acpSessionId,
      status: state.status === "running" ? "error" : state.status,
      ...(state.status === "running"
        ? { error: `${provider} prompt outcome is unknown after bridge restart` }
        : state.error ? { error: state.error } : {}),
      messages: state.messages,
      ...(state.droppedMessages > 0 ? { droppedMessages: state.droppedMessages } : {}),
      ...(state.droppedParts > 0 ? { droppedParts: state.droppedParts } : {}),
      ...(state.transcriptTruncated ? { transcriptTruncated: true } : {}),
      revision: state.revision,
      structured: structuredBySession.get(state.id) ?? [],
      promptJournal: promptJournalBySession.get(state.id) ?? [],
      ...(sessionConfigBySession.has(state.id)
        ? { sessionConfig: sessionConfigBySession.get(state.id)! }
        : {}),
      ...(state.usage ? { usage: state.usage } : {}),
      ...(state.commandCount === undefined ? {} : { commandCount: state.commandCount }),
      ...(state.subagentLimitExceeded ? { subagentLimitExceeded: true } : {}),
    })),
  };
  return boundPersistedSnapshot(snapshot);
}

export function schedulePersist(): void {
  if (!stateFile || persistenceScheduled) return;
  setPersistenceScheduled(true);
  const operation = persistenceTail.then(async () => {
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 25);
      timer.unref();
    });
    setPersistenceScheduled(false);
    await writePersistedState();
  }, async () => {
    setPersistenceScheduled(false);
    await writePersistedState();
  });
  setPersistenceTail(operation.catch((error) => {
    console.warn(
      `[acp-bridge] Failed to persist bounded state: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }));
}

export function persistState(): Promise<void> {
  const operation = persistenceTail.then(writePersistedState, writePersistedState);
  setPersistenceTail(operation.catch(() => undefined));
  return operation;
}

export async function writePersistedState(): Promise<void> {
  const file = stateFile;
  if (!file) return;
  const payload = `${JSON.stringify(persistedSnapshot())}\n`;
  if (Buffer.byteLength(payload) > MAX_STATE_FILE_BYTES) {
    throw new Error("ACP persisted state exceeds its byte limit");
  }
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, payload, { mode: 0o600 });
  await fs.rename(temporary, file);
}

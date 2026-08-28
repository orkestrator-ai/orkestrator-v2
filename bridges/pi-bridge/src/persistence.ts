/**
 * Durable bridge state across restarts.
 *
 * What survives is the rendered transcript, the composer selection, the prompt
 * journal and the pointer to Pi's own session file — the things a renderer or a
 * caller would otherwise have no way to recover. What does not survive is
 * anything about the process that produced them: an attached session, an
 * in-flight turn, a parked approval, a cancel handle. A promise from a dead
 * process means nothing to its successor, and an approval it was holding was
 * denied on the way out.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_STATE_FILE_BYTES, stateFilePath } from "./config.js";
import { emptyComposer } from "./models.js";
import { readTodos } from "./tool-rendering.js";
import {
  clientSessionKeys,
  isObject,
  nonBlank,
  setSteerJournal,
  sessions,
  type PersistedSession,
  type PersistedState,
  type SessionState,
} from "./state.js";
import { newSessionState } from "./agent-session.js";

let tail: Promise<void> = Promise.resolve();
let scheduled = false;
let shuttingDown = false;

/**
 * Queue a write, coalescing bursts.
 *
 * Persistence runs behind a single tail promise so two concurrent turns cannot
 * interleave writes to the same file, and `scheduled` collapses a streaming
 * turn's thousands of revisions into one write per drain.
 */
export function schedulePersist(): void {
  if (!stateFilePath() || scheduled || shuttingDown) return;
  scheduled = true;
  tail = tail
    .then(async () => {
      scheduled = false;
      await persistNow();
    })
    .catch(() => {
      scheduled = false;
    });
}

/**
 * Publish every mutation made before this call before allowing dispatch.
 *
 * A prepared prompt journal is the crash boundary for at-most-once delivery.
 * Merely scheduling its write is not enough: Pi could accept the prompt while
 * the state file still described no journal entry, and a restart would then
 * dispatch the same request id again. Chaining an explicit write behind the
 * normal persistence tail preserves serialization while surfacing failure to
 * the caller instead of swallowing it like a best-effort streaming write.
 */
export async function persistBarrier(): Promise<void> {
  if (!stateFilePath()) return;
  const operation = tail.then(() => persistNow());
  tail = operation.catch(() => undefined);
  await operation;
}

/** Flush and stop accepting further writes. Used on shutdown. */
export async function drainPersistence(): Promise<void> {
  if (!stateFilePath()) return;
  // Closed to new writes *first*. Draining before this flag was set let a
  // write scheduled during the drain (a turn settling as shutdown denies its
  // approvals) chain onto the tail and run concurrently with the final write
  // below — two writers truncating the same `.tmp` file, with the rename
  // publishing whichever interleaving won.
  shuttingDown = true;
  await tail.catch(() => undefined);
  await persistNow().catch(() => undefined);
}

/**
 * Bring an oversized payload under the file bound by shedding transcripts.
 *
 * Transcripts are trimmed per session, never in aggregate, so enough sessions
 * will always eventually exceed the whole-file bound. Skipping the write there
 * — which is what this used to do — is silently permanent: nothing shrinks the
 * aggregate afterwards, so every later write is skipped too and a restart
 * loses every session pointer *and* the at-most-once prompt journal.
 *
 * What is shed is only the rendered transcript, oldest-touched session first.
 * The session id, its Pi session file, its journal and its composer are what
 * make a session recoverable, and they are tiny — a shed session re-attaches
 * to the same Pi conversation, it just starts with an empty rendered copy.
 * Live state is deliberately untouched: the tab the user is looking at keeps
 * its transcript.
 */
function shedToFit(payload: PersistedState, order: Map<string, number>): boolean {
  const byOldest = [...payload.sessions].sort(
    (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0),
  );
  let shed = 0;
  for (const session of byOldest) {
    if (session.messages.length === 0) continue;
    session.droppedMessages = (session.droppedMessages ?? 0) + session.messages.length;
    session.messages = [];
    session.transcriptTruncated = true;
    shed += 1;
    if (Buffer.byteLength(JSON.stringify(payload)) <= MAX_STATE_FILE_BYTES) {
      console.warn(
        `[pi-bridge] state file over budget; persisted ${shed} session(s) without their transcript`,
      );
      return true;
    }
  }
  // Every transcript is gone and it still does not fit, which means the
  // non-transcript state alone is over budget. Report it rather than failing
  // silently forever.
  console.warn(
    `[pi-bridge] state file still over budget after shedding ${shed} transcript(s); skipping write`,
  );
  return false;
}

async function persistNow(): Promise<void> {
  const stateFile = stateFilePath();
  if (!stateFile) return;
  const live = Array.from(sessions.values());
  const payload: PersistedState = {
    version: 1,
    provider: "pi",
    sessions: live.map(toPersisted),
  };
  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_STATE_FILE_BYTES) {
    const order = new Map(live.map((state) => [state.id, state.lastAccessed]));
    if (!shedToFit(payload, order)) {
      // Best-effort callers swallow this through the queue tail. A durability
      // barrier does not: dispatch must stop when no state file was published.
      throw new Error("Pi bridge state exceeds its persistence budget");
    }
    serialized = JSON.stringify(payload);
  }
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.tmp`;
  // Write-then-rename: a bridge killed mid-write must not leave a truncated
  // file that the next start reads as a session with no history.
  await writeFile(temporary, serialized, { mode: 0o600 });
  await rename(temporary, stateFile);
}

function toPersisted(state: SessionState): PersistedSession {
  return {
    id: state.id,
    ...(state.clientSessionKey ? { clientSessionKey: state.clientSessionKey } : {}),
    ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
    ...(state.piSessionId ? { piSessionId: state.piSessionId } : {}),
    // A session that was mid-turn when the process died is not running now.
    // Recording it as `running` would have the next start report a turn that
    // nothing is executing.
    status: state.status === "running" ? "idle" : state.status,
    ...(state.error ? { error: state.error } : {}),
    ...(state.title ? { title: state.title } : {}),
    messages: state.messages,
    droppedMessages: state.droppedMessages,
    droppedParts: state.droppedParts,
    transcriptTruncated: state.transcriptTruncated,
    revision: state.revision,
    structured: Array.from(state.structured.entries()),
    promptJournal: Array.from(state.promptJournal.values()).map((entry) =>
      // An accepted turn whose outcome this process never recorded is exactly
      // the ambiguous case: the successor must refuse to reuse the id rather
      // than re-dispatch work that may already have run.
      entry.state === "accepted" || entry.state === "prepared"
        ? { ...entry, state: "ambiguous" as const }
        : entry,
    ),
    steerJournal: Array.from(state.steerJournal.values()).map((entry) =>
      entry.state === "prepared" || entry.state === "queued"
        ? { ...entry, state: "ambiguous" as const }
        : entry,
    ),
    composer: state.composer,
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

export async function loadPersistedState(): Promise<void> {
  const stateFile = stateFilePath();
  if (!stateFile) return;
  const raw = await readFile(stateFile, "utf8").catch(() => undefined);
  if (!raw || Buffer.byteLength(raw) > MAX_STATE_FILE_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt file loads as "no sessions" rather than throwing: a bad write
    // must never wedge every environment that shares this bridge.
    return;
  }
  if (!isObject(parsed) || parsed.provider !== "pi" || !Array.isArray(parsed.sessions)) return;

  for (const entry of parsed.sessions) {
    // Persistence is shared by every Pi session. One structurally malformed
    // entry must not prevent valid siblings from re-attaching to their own
    // conversation files after a restart.
    try {
      const restored = restoreSession(entry);
      if (!restored) continue;
      sessions.set(restored.id, restored);
      if (restored.clientSessionKey) clientSessionKeys.set(restored.clientSessionKey, restored.id);
    } catch {
      continue;
    }
  }
}

function restoreSession(entry: unknown): SessionState | undefined {
  if (!isObject(entry) || !nonBlank(entry.id)) return undefined;
  const state = newSessionState(
    nonBlank(entry.clientSessionKey) ? entry.clientSessionKey : undefined,
  );
  state.id = entry.id;
  if (nonBlank(entry.sessionFile)) state.sessionFile = entry.sessionFile;
  if (nonBlank(entry.piSessionId)) state.piSessionId = entry.piSessionId;
  state.status = entry.status === "error" ? "error" : "idle";
  if (nonBlank(entry.error)) state.error = entry.error;
  if (nonBlank(entry.title)) state.title = entry.title;
  state.messages = Array.isArray(entry.messages)
    ? (entry.messages as SessionState["messages"])
    : [];
  state.droppedMessages = readCount(entry.droppedMessages);
  state.droppedParts = readCount(entry.droppedParts);
  state.transcriptTruncated = entry.transcriptTruncated === true;
  state.revision = readCount(entry.revision);
  state.composer = restoreComposer(entry.composer);
  const usage = restoreUsage(entry.usage);
  if (usage) state.usage = usage;
  // The whole transcript is unmeasured after a restore, so the first read
  // re-bounds it rather than trusting a budget this process never charged.
  state.uncheckedTranscriptBytes = Buffer.byteLength(JSON.stringify(state.messages));

  if (Array.isArray(entry.structured)) {
    for (const pair of entry.structured) {
      if (Array.isArray(pair) && nonBlank(pair[0])) state.structured.set(pair[0], pair[1]);
    }
  }
  if (Array.isArray(entry.promptJournal)) {
    for (const journalEntry of entry.promptJournal) {
      if (!isObject(journalEntry) || !nonBlank(journalEntry.requestId)) continue;
      state.promptJournal.set(journalEntry.requestId, {
        requestId: journalEntry.requestId,
        state: readJournalState(journalEntry.state),
        acceptedAt: readCount(journalEntry.acceptedAt),
      });
    }
  }
  if (Array.isArray(entry.steerJournal)) {
    for (const journalEntry of entry.steerJournal) {
      if (
        !isObject(journalEntry) ||
        !nonBlank(journalEntry.requestId) ||
        !nonBlank(journalEntry.inputDigest) ||
        !nonBlank(journalEntry.expectedRunId)
      ) {
        continue;
      }
      setSteerJournal(state, {
        requestId: journalEntry.requestId,
        inputDigest: journalEntry.inputDigest,
        expectedRunId: journalEntry.expectedRunId,
        state:
          journalEntry.state === "delivered"
            ? "delivered"
            : journalEntry.state === "dropped"
              ? "dropped"
              : "ambiguous",
        createdAt: readCount(journalEntry.createdAt),
      });
    }
  }
  state.todos = restoreTodos(state);
  return state;
}

/**
 * Restore only the composer fields a user actually chose.
 *
 * The model list is deliberately not restored: it is a live catalogue read, and
 * reviving a stale one would offer models whose provider the account may no
 * longer be signed into. The selection survives, so the picker still shows the
 * user's choice while the catalogue refreshes behind it.
 */
function restoreComposer(value: unknown): SessionState["composer"] {
  const composer = emptyComposer();
  if (!isObject(value)) return composer;
  return {
    ...composer,
    ...(nonBlank(value.selectedModelId) ? { selectedModelId: value.selectedModelId } : {}),
    ...(nonBlank(value.selectedReasoningId)
      ? { selectedReasoningId: value.selectedReasoningId }
      : {}),
  };
}

function restoreUsage(value: unknown): SessionState["usage"] {
  if (!isObject(value) || !isObject(value.turn)) return undefined;
  const turn: NonNullable<SessionState["usage"]>["turn"] = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const) {
    const count = value.turn[key];
    if (typeof count === "number" && Number.isFinite(count)) turn[key] = count;
  }
  if (Object.keys(turn).length === 0) return undefined;
  return {
    turn,
    ...(nonBlank(value.modelId) ? { modelId: value.modelId } : {}),
    ...readNumber(value, "durationMs"),
    ...readNumber(value, "costUsd"),
    ...readNumber(value, "contextTokens"),
    ...readNumber(value, "contextWindow"),
    updatedAt: nonBlank(value.updatedAt) ? value.updatedAt : new Date().toISOString(),
  };
}

function readNumber(value: Record<string, unknown>, key: string): Record<string, number> {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? { [key]: candidate } : {};
}

/**
 * Rebuild the session todo list from the newest card that carried one.
 *
 * Persisting a second copy would let the two disagree after a transcript trim;
 * the card is the only place the list was ever displayed from, so it is the
 * one that decides.
 */
function restoreTodos(state: SessionState): SessionState["todos"] {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const parts = state.messages[index]!.parts;
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]!;
      if (part.type !== "tool-invocation") continue;
      const todos = readTodos(part.toolArgs?.todos);
      if (todos.length > 0) return todos;
    }
  }
  return [];
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readJournalState(value: unknown): "completed" | "failed" | "ambiguous" {
  if (value === "completed" || value === "failed") return value;
  return "ambiguous";
}

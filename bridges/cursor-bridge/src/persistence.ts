/**
 * Durable session state across bridge restarts.
 *
 * What survives is the transcript, the composer selection and the prompt
 * journal — the things a renderer or a caller would otherwise have no way to
 * recover. What does not survive is anything about the process that produced
 * them: an attached agent, an in-flight turn, a cancel handle. A promise from
 * a dead process means nothing to its successor.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isNativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { MAX_CLOSING_TOMBSTONES, MAX_STATE_FILE_BYTES, stateFilePath } from "./config.js";
import { emptyComposer } from "./models.js";
import { seedObservedMcpTools } from "./mcp.js";
import {
  PersistenceError,
  serializeWithinBudget,
  type BudgetedSession,
  type EssentialRecord,
} from "./persistence-budget.js";
import { persistedSteerJournal, restoreSteerJournal } from "./steer-journal.js";
import { setStructuredResult } from "./structured-results.js";
import { readTodos } from "./tool-rendering.js";
import { settleAbandonedToolParts, settleDetachedSubagentPart } from "./translate.js";
import {
  clientSessionKeys,
  closingTombstones,
  isObject,
  nonBlank,
  sessions,
  type ClosingTombstone,
  type PersistedState,
  type SessionState,
} from "./state.js";
import { newSessionState } from "./agent-session.js";

export { PersistenceError } from "./persistence-budget.js";

/**
 * Every write to the state file, in order. Never rejects: each operation's own
 * promise carries its failure to whoever needs it, and only a caught
 * continuation becomes the tail, so one failed write cannot poison the next.
 */
let tail: Promise<void> = Promise.resolve();
/**
 * A queued write that has not yet taken its snapshot. Anyone who needs their
 * mutation published can join it: the snapshot is taken when it starts, which
 * is after they asked. This is what bounds the queue to one running and one
 * waiting write however many callers pile up.
 */
let pending: Promise<void> | undefined;
/** Rollbacks that must run before a failed write releases the next queued snapshot. */
let pendingFailureHooks: Set<() => void> | undefined;
/** Shutdown has begun. Best-effort writes stop; mandatory ones are refused. */
let admissionClosed = false;
/** Callers currently waiting in {@link persistBarrier}. */
let barrierWaiters = 0;

/**
 * The filesystem calls a publication makes. Replaceable only so a test can
 * hold or fail one of them — the write, the flush, the rename, the directory
 * flush — while serialization, the queue and the routes stay real.
 */
const realFs = {
  mkdir,
  writeFile,
  /** Flush a written file's data and metadata to stable storage. */
  fsyncFile: async (path: string): Promise<void> => {
    // `r+`: Windows refuses to flush a handle opened read-only. fsync applies
    // to the file, not the descriptor, so a fresh handle flushes what the
    // write through another one left dirty.
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
  /** Flush a directory entry change (the rename) to stable storage. */
  fsyncDirectory: async (path: string): Promise<void> => {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  unlink,
  readdir: (path: string): Promise<string[]> => readdir(path),
  stat,
};
let fs: typeof realFs = realFs;

export function usePersistenceFsForTests(overrides: Partial<typeof realFs>): () => void {
  const previous = fs;
  fs = { ...realFs, ...overrides };
  return () => {
    fs = previous;
  };
}

/**
 * Errors a directory flush reports where a directory cannot be flushed at all
 * (Windows has no directory handle to flush; some network and FUSE
 * filesystems reject the call). The rename itself succeeded; there is simply
 * no stronger guarantee to be had there.
 */
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP"]);

/** Distinguishes this process's temporary files from each other. */
let temporarySequence = 0;

/**
 * A name unique to this write, `state.json.<pid>.<seq>.<random>.tmp`, beside
 * the state file so the rename stays within one filesystem.
 */
function temporaryPath(stateFile: string): string {
  temporarySequence += 1;
  return `${stateFile}.${process.pid}.${temporarySequence}.${randomBytes(4).toString("hex")}.tmp`;
}

const TEMPORARY_NAME = /^(\d+)\.\d+\.[0-9a-f]+$/;
/** How often leftover temporary files are looked for. */
const TEMPORARY_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;
/**
 * Another process's temporary file younger than this may still be mid-write
 * (a bridge being replaced can briefly overlap its successor). Older ones are
 * crash leftovers: no write of a bounded state file takes this long.
 */
const STALE_TEMPORARY_MS = 5 * 60 * 1_000;
/** Deletions one sweep performs at most. */
const MAX_TEMPORARY_SWEEP = 32;
let lastTemporarySweep: number | undefined;

/**
 * Remove temporary files a killed bridge left beside the state file.
 *
 * Bounded and best-effort: at most once per interval, at most
 * {@link MAX_TEMPORARY_SWEEP} deletions, and only names this module writes
 * (plus the fixed `state.json.tmp` of earlier versions). It runs inside the
 * write queue, between this process's writes, so none of its own temporaries
 * is in flight; another process's is left alone until it is clearly stale. A
 * failure here never fails a publication.
 */
async function sweepTemporaries(stateFile: string): Promise<void> {
  const now = Date.now();
  if (lastTemporarySweep !== undefined && now - lastTemporarySweep < TEMPORARY_SWEEP_INTERVAL_MS) {
    return;
  }
  lastTemporarySweep = now;
  const directory = dirname(stateFile);
  const prefix = `${basename(stateFile)}.`;
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (removed >= MAX_TEMPORARY_SWEEP) break;
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const middle = name.slice(prefix.length, -".tmp".length);
    const match = TEMPORARY_NAME.exec(middle);
    if (middle !== "" && !match) continue;
    const path = join(directory, name);
    // This process's own name while none of its writes is in flight: a
    // leftover of a failed cleanup, or of an earlier process that had the
    // same pid (routine for a container's entrypoint).
    if (match?.[1] !== String(process.pid)) {
      const modified = await fs.stat(path).then(
        (info) => info.mtimeMs,
        () => undefined,
      );
      if (modified === undefined || now - modified < STALE_TEMPORARY_MS) continue;
    }
    const unlinked = await fs.unlink(path).then(
      () => true,
      () => false,
    );
    if (unlinked) removed += 1;
  }
}

/** Identity each session had in the last snapshot that actually reached disk. */
const durableIdentities = new WeakMap<SessionState, string>();
/**
 * The failure episode in progress, so a saturated stream produces one notice,
 * not one per token. `noticed` holds the notice text each session has already
 * been shown during this episode; an episode ends with the next success.
 */
let failing: { key: string; failures: number; noticed: WeakMap<SessionState, string> } | undefined;
/** Sessions whose transcript the last published snapshot left out. */
let lastShed = new Set<string>();

/**
 * Queue a best-effort write, coalescing bursts.
 *
 * A streaming turn produces thousands of revisions; they collapse into the
 * one queued write. A failure here is recorded as a bounded health notice and
 * is otherwise not this caller's concern — anything that must not proceed
 * without publication uses {@link persistBarrier} instead.
 */
export function schedulePersist(): void {
  if (!stateFilePath() || admissionClosed) return;
  void enqueue().catch(() => undefined);
}

/**
 * Publish every mutation made before this call, or throw.
 *
 * This is the at-most-once crash boundary: a prepared prompt or steer record
 * and the identity of the agent it will go to must be on disk before the SDK
 * can act on them, and a session the backend is told exists must be one a
 * restarted bridge can reload. Resolving without a write — because an earlier
 * write failed and was swallowed, or because the file was too large — is
 * exactly the false guarantee this function exists to rule out.
 *
 * Stateless mode (no state directory configured) has nothing to publish and
 * resolves. A configured directory that cannot be written is a failure, not
 * stateless mode.
 */
export async function persistBarrier(onFailure?: () => void): Promise<void> {
  if (!stateFilePath()) return;
  if (admissionClosed) {
    throw new PersistenceError("persistence-closed", "Cursor bridge is shutting down");
  }
  barrierWaiters += 1;
  try {
    await enqueue(onFailure);
  } finally {
    barrierWaiters -= 1;
  }
}

/**
 * How many callers are blocked on a mandatory publication right now. Lets a
 * test prove a route is waiting on the barrier — rather than sleeping and
 * hoping it got there.
 */
export function persistBarrierWaitersForTests(): number {
  return barrierWaiters;
}

function enqueue(onFailure?: () => void): Promise<void> {
  if (pending) {
    if (onFailure) pendingFailureHooks?.add(onFailure);
    return pending;
  }
  const failureHooks = new Set<() => void>();
  if (onFailure) failureHooks.add(onFailure);
  pendingFailureHooks = failureHooks;
  const operation = tail
    .then(() => {
      // The snapshot is taken synchronously at the start of `persistNow`, so
      // from this point a new caller's mutation is not covered and must queue
      // a write of its own.
      pending = undefined;
      pendingFailureHooks = undefined;
      return persistNow();
    })
    .catch((error) => {
      for (const rollback of failureHooks) rollback();
      throw error;
    });
  pending = operation;
  tail = operation.catch(() => undefined);
  return operation;
}

/**
 * Flush and stop accepting further writes. Used on shutdown.
 *
 * Admission closes first. Draining before closing let a write scheduled during
 * the drain chain onto the tail behind the final write; closing first means
 * the final snapshot is the last thing written and a barrier that arrives
 * afterwards is refused rather than resolved as if it had been published.
 */
export async function drainPersistence(): Promise<void> {
  if (!stateFilePath()) return;
  admissionClosed = true;
  pending = undefined;
  const final = tail.then(() => persistNow());
  tail = final.catch(() => undefined);
  await final.catch(() => undefined);
}

/** Re-open admission after a drain. Test harnesses only. */
export function reopenPersistenceForTests(): void {
  admissionClosed = false;
  pending = undefined;
  pendingFailureHooks = undefined;
  failing = undefined;
  lastShed = new Set();
  lastTemporarySweep = undefined;
}

/**
 * Whether the identity a caller is about to acknowledge is already on disk.
 *
 * A warm attach that changed nothing need not rewrite the whole file; one that
 * adopted a new provider agent (or whose last publication failed) must.
 */
export function identityPublished(state: SessionState): boolean {
  return durableIdentities.get(state) === identityKey(state);
}

function identityKey(state: SessionState): string {
  return `${state.agentId ?? ""}\u0000${state.configResumePending ? 1 : 0}`;
}

/**
 * Publish one snapshot: write a uniquely named temporary file, flush it,
 * rename it over the state file, then flush the directory.
 *
 * Durability, precisely. When this resolves the new file has atomically
 * replaced the old one, so a process crash (or `kill -9`) at any point leaves
 * either the previous complete snapshot or this one — never a torn file that
 * the next start reads as a session with no history. The file is flushed
 * before the rename and the directory after it, so on Linux the snapshot also
 * survives power loss. Elsewhere it is as durable as the platform's `fsync`:
 * macOS `fsync` does not flush the drive's own cache (Node exposes no
 * `F_FULLFSYNC`), and where a directory cannot be flushed at all (Windows,
 * some network filesystems) the rename's durability is the filesystem's. So a
 * barrier guarantees process-crash durability everywhere and power-loss
 * durability on Linux.
 *
 * A failure before the rename removes the temporary file and leaves the
 * previous snapshot authoritative. A directory flush that fails for any reason
 * other than being unsupported is reported as a failed publication although
 * the rename happened: the caller asked for a durable write and did not get
 * one, and refusing is the side that cannot dispatch twice.
 */
async function persistNow(): Promise<void> {
  const stateFile = stateFilePath();
  if (!stateFile) return;
  // Everything up to the first await is the snapshot. Building it is
  // synchronous, so it cannot interleave with a mutation it did not see.
  let snapshot: ReturnType<typeof buildSnapshot>;
  try {
    snapshot = buildSnapshot();
  } catch (error) {
    throw noteFailure(error);
  }
  const directory = dirname(stateFile);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw noteFailure(error);
  }
  await sweepTemporaries(stateFile);
  // Unique per write and created exclusively, so no write can truncate or
  // rename a temporary file another write — or another process — is producing.
  const temporary = temporaryPath(stateFile);
  try {
    await fs.writeFile(temporary, snapshot.serialized, { mode: 0o600, flag: "wx" });
    await fs.fsyncFile(temporary);
    await fs.rename(temporary, stateFile);
  } catch (error) {
    // `EEXIST` means the exclusive create found a file this write did not
    // make; it is not this write's to remove.
    if ((error as { code?: unknown } | undefined)?.code !== "EEXIST") {
      await fs.unlink(temporary).catch(() => undefined);
    }
    throw noteFailure(error);
  }
  try {
    await fs.fsyncDirectory(directory);
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || !UNSUPPORTED_DIRECTORY_SYNC.has(code)) {
      throw noteFailure(error);
    }
  }
  for (const [state, identity] of snapshot.identities) durableIdentities.set(state, identity);
  noteSuccess(snapshot.shed);
}

function buildSnapshot(): {
  serialized: string;
  identities: Array<[SessionState, string]>;
  shed: string[];
} {
  const live: SessionState[] = [];
  const closing: ClosingTombstone[] = Array.from(closingTombstones.values());
  for (const state of sessions.values()) {
    if (!state.closed) {
      live.push(state);
    } else if (!state.closeFenced) {
      // Mid-close: published as a tombstone, never as a session a restart
      // could reopen. A fenced close has nothing left to publish at all.
      closing.push({
        id: state.id,
        ...(state.agentId ? { agentId: state.agentId } : {}),
        since: Date.now(),
      });
    }
  }
  const envelope: Omit<PersistedState, "sessions"> = {
    version: 1,
    provider: "cursor",
    ...(closing.length > 0 ? { closing } : {}),
  };
  if (closing.length > MAX_CLOSING_TOMBSTONES) {
    throw new PersistenceError(
      "persistence-budget-exceeded",
      "Too many pending Cursor session closes to publish safely",
    );
  }
  // Every session is re-encoded on every write, deliberately. Reusing an
  // encoding across writes needs a key that every mutation of persisted state
  // moves, and none exists: `revision` tracks the rendered transcript only
  // (journals, structured results, composer, status and the sub-agent latch
  // change without it, and a history rebuild pushes messages across awaits
  // before its bump), so a cache keyed on it could publish stale recovery
  // state. Each write encodes each record and each considered message once.
  const budgeted: BudgetedSession[] = live.map((state) => ({
    id: state.id,
    lastAccessed: state.lastAccessed,
    essential: toEssential(state),
    messages: state.messages,
  }));
  const { serialized, shed } = serializeWithinBudget(envelope, budgeted, MAX_STATE_FILE_BYTES);
  return {
    serialized,
    identities: live.map((state) => [state, identityKey(state)]),
    shed,
  };
}

/**
 * Record a failed publication and return the error its caller should see.
 *
 * Logged and surfaced on the transition into failure, not on every write: a
 * streaming turn against a full disk would otherwise log once per token.
 * Content-free — a filesystem error names paths, so only its code is kept.
 */
function noteFailure(error: unknown): PersistenceError {
  const typed =
    error instanceof PersistenceError
      ? error
      : new PersistenceError(
          "persistence-failed",
          "Cursor bridge could not save its session state",
          { cause: error },
        );
  // A budget refusal whose largest sessions changed is a new transition: the
  // notice has to follow the space to where it now is.
  const key = `${typed.code}\u0000${typed.sessionIds.join("\u0000")}`;
  if (failing?.key === key) {
    failing.failures += 1;
    return typed;
  }
  failing = failing
    ? { key, failures: failing.failures + 1, noticed: failing.noticed }
    : { key, failures: 1, noticed: new WeakMap() };
  const errno = (error as { code?: unknown } | undefined)?.code;
  const offenders = new Set(typed.sessionIds);
  console.warn(
    `[cursor-bridge] state publication failing (${typed.code}${
      typeof errno === "string" ? `, ${errno.slice(0, 32)}` : ""
    }${
      offenders.size > 0 ? `; ${offenders.size} largest session(s) marked` : ""
    }); new prompts and steers are refused until it recovers`,
  );
  for (const state of sessions.values()) {
    const offender = offenders.has(state.id);
    // Content-free: which session, never what its saved state holds.
    const message = offender ? LARGEST_SESSION_NOTICE : typed.message;
    // A session already showing this exact notice in this episode has nothing
    // new to see. Recording it again would add an occurrence, and bumping its
    // revision would invalidate every client's transcript token for it —
    // which is what a changed largest-session set used to do to every tab.
    if (failing.noticed.get(state) === message) continue;
    failing.noticed.set(state, message);
    state.health.recordNotice({
      message,
      method: "persistence",
      severity: "error",
      detail: offender ? `${typed.code}; largest-session` : typed.code,
    });
    // Error notices are rendered as transcript advisories, which a client
    // only re-reads when the revision moves.
    state.revision += 1;
  }
  return typed;
}

const LARGEST_SESSION_NOTICE =
  "This session's saved state (structured results and prompt records) is among the largest keeping the Cursor bridge from saving. Close this tab, or other unused Cursor tabs, to free space.";

function noteSuccess(shed: readonly string[]): void {
  if (failing) {
    console.warn(
      `[cursor-bridge] state publication recovered after ${failing.failures} failed write(s)`,
    );
    failing = undefined;
  }
  const newlyShed = shed.filter((id) => !lastShed.has(id));
  lastShed = new Set(shed);
  if (newlyShed.length === 0) return;
  console.warn(
    `[cursor-bridge] state file at its size limit; saved ${newlyShed.length} session(s) with a shortened transcript copy`,
  );
  for (const id of newlyShed) {
    sessions.get(id)?.health.recordNotice({
      message:
        "The saved copy of this transcript keeps only its newest messages, to keep bridge state within its size limit. The conversation itself is kept; a bridge restart shows the transcript as truncated.",
      method: "persistence",
      severity: "info",
    });
  }
}

function toEssential(state: SessionState): EssentialRecord {
  return {
    id: state.id,
    ...(state.policy ? { policy: state.policy } : {}),
    ...(typeof state.readOnly === "boolean" ? { readOnly: state.readOnly } : {}),
    ...(state.clientSessionKey ? { clientSessionKey: state.clientSessionKey } : {}),
    ...(state.agentId ? { agentId: state.agentId } : {}),
    ...(state.configResumePending ? { configResumePending: true } : {}),
    // A session that was mid-turn when the process died is not running now.
    // Recording it as `running` would have the next start report a turn that
    // nothing is executing.
    status: state.status === "running" ? "idle" : state.status,
    ...(state.error ? { error: state.error } : {}),
    droppedMessages: state.droppedMessages,
    droppedParts: state.droppedParts,
    transcriptTruncated: state.transcriptTruncated,
    revision: state.revision,
    structured: Array.from(state.structured.entries()),
    promptJournal: Array.from(state.promptJournal.values()).map(({ sendFailed, ...entry }) => {
      // An accepted turn whose outcome this process never recorded is exactly
      // the ambiguous case: the successor must refuse to reuse the id rather
      // than re-dispatch work that may already have run. `sendFailed` is this
      // process's own licence to retry under the same idempotency key; a
      // successor has no such knowledge, so it is never written.
      void sendFailed;
      return entry.state === "accepted" || entry.state === "prepared"
        ? { ...entry, state: "ambiguous" as const }
        : entry;
    }),
    ...persistedSteerJournal(state),
    composer: state.composer,
    ...(state.usage ? { usage: state.usage } : {}),
    ...(state.subagentLimitExceeded ? { subagentLimitExceeded: true } : {}),
  };
}

export async function loadPersistedState(): Promise<void> {
  const stateFile = stateFilePath();
  if (!stateFile) return;
  const raw = await readFile(stateFile, "utf8").catch(() => undefined);
  if (!raw) return;
  const fileBytes = Buffer.byteLength(raw);
  if (fileBytes > MAX_STATE_FILE_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt file loads as "no sessions" rather than throwing: a bad write
    // must never wedge every environment that shares this bridge.
    return;
  }
  if (!isObject(parsed) || parsed.provider !== "cursor" || !Array.isArray(parsed.sessions)) return;

  // A close that had not finished publishing its removal. It is never
  // restored as a session — the user asked for it to be closed — and a
  // retried close completes it (see `closeRestoredTombstone`).
  const closing = new Set<string>();
  if (Array.isArray(parsed.closing)) {
    for (const entry of parsed.closing) {
      if (!isObject(entry) || !nonBlank(entry.id) || entry.id.length > 128) continue;
      closing.add(entry.id);
      closingTombstones.set(entry.id, {
        id: entry.id,
        ...(nonBlank(entry.agentId) && entry.agentId.length <= 1_024
          ? { agentId: entry.agentId }
          : {}),
        since: readCount(entry.since),
      });
    }
  }
  for (const entry of parsed.sessions) {
    const restored = restoreSession(entry, fileBytes);
    if (!restored || closing.has(restored.id)) continue;
    sessions.set(restored.id, restored);
    if (restored.clientSessionKey) clientSessionKeys.set(restored.clientSessionKey, restored.id);
  }
}

function restoreSession(entry: unknown, fileBytes: number): SessionState | undefined {
  if (!isObject(entry) || !nonBlank(entry.id)) return undefined;
  const state = newSessionState(
    nonBlank(entry.clientSessionKey) ? entry.clientSessionKey : undefined,
  );
  state.id = entry.id;
  if (isNativeAgentExecutionPolicy(entry.policy)) state.policy = entry.policy;
  if (typeof entry.readOnly === "boolean") state.readOnly = entry.readOnly;
  if (nonBlank(entry.agentId)) state.agentId = entry.agentId;
  if (entry.configResumePending === true) state.configResumePending = true;
  state.status = entry.status === "error" ? "error" : "idle";
  if (nonBlank(entry.error)) state.error = entry.error;
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
  state.subagentLimitExceeded = entry.subagentLimitExceeded === true;
  // The whole transcript is unmeasured after a restore, so the first read
  // re-bounds it rather than trusting a budget this process never charged.
  // Charged at the size of the file it came from: an upper bound on this
  // transcript's encoding that costs nothing to know, where re-encoding every
  // restored transcript here would serialize the whole file a second time at
  // startup. The first bound measures it exactly and resets the charge.
  state.uncheckedTranscriptBytes = state.messages.length > 0 ? fileBytes : 0;

  if (Array.isArray(entry.structured)) {
    // Through the same count and byte bounds a live result obeys, oldest
    // evicted first, so a file from before the byte bound cannot restore a
    // session whose recovery state alone would block publication.
    for (const pair of entry.structured) {
      if (Array.isArray(pair) && nonBlank(pair[0])) setStructuredResult(state, pair[0], pair[1]);
    }
  }
  if (Array.isArray(entry.promptJournal)) {
    for (const journalEntry of entry.promptJournal) {
      if (!isObject(journalEntry) || !nonBlank(journalEntry.requestId)) continue;
      state.promptJournal.set(journalEntry.requestId, {
        requestId: journalEntry.requestId,
        state: readJournalState(journalEntry.state),
        acceptedAt: readCount(journalEntry.acceptedAt),
        ...(journalEntry.local === true ? { local: true } : {}),
      });
    }
  }
  restoreSteerJournal(state, entry.steerJournal, entry.steerFence);
  state.todos = restoreTodos(state);
  seedObservedMcpTools(state);
  settleRestoredSubagents(state);
  // A mid-turn persist records the session as idle. Pending tool cards from
  // that write would otherwise render as still running after a restart.
  settleAbandonedToolParts(state);
  return state;
}

/**
 * Close out sub-agent cards that were live when the previous process died.
 *
 * `activeSubagentDescriptors` is deliberately not persisted — a live child
 * belongs to the process that launched it — so nothing after a restart can
 * ever settle a card left at `agentState: "active"`. Left alone it renders as
 * a sub-agent that has been running since before the bridge started, and
 * disagrees with `/activity`, which correctly reports the session idle.
 */
function settleRestoredSubagents(state: SessionState): void {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation" || part.agentState !== "active") continue;
      settleDetachedSubagentPart(part);
    }
  }
}

/**
 * Restore only the composer fields a user actually chose.
 *
 * The model list is deliberately not restored: it is a live catalogue read,
 * and reviving a stale one would offer models the account may no longer have.
 * The selection survives, so the picker still shows the user's choice while
 * the catalogue refreshes behind it.
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
    ...(value.selectedModeId === "plan" || value.selectedModeId === "build"
      ? { selectedModeId: value.selectedModeId }
      : {}),
  };
}

function restoreTurnUsage(value: unknown): NonNullable<SessionState["usage"]>["turn"] | undefined {
  if (!isObject(value)) return undefined;
  const turn: NonNullable<SessionState["usage"]>["turn"] = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const) {
    const count = value[key];
    if (typeof count === "number" && Number.isFinite(count)) turn[key] = count;
  }
  return Object.keys(turn).length > 0 ? turn : undefined;
}

function restoreUsage(value: unknown): SessionState["usage"] {
  if (!isObject(value)) return undefined;
  const turn = restoreTurnUsage(value.turn);
  if (!turn) return undefined;
  const context = restoreTurnUsage(value.context);
  const turns = Array.isArray(value.turns)
    ? value.turns.slice(-20).filter((entry) => isObject(entry) && nonBlank(entry.turnId))
    : [];
  const account = Array.isArray(value.account)
    ? value.account.slice(-16).filter((entry) => isObject(entry) && nonBlank(entry.window))
    : [];
  return {
    turn,
    ...(context ? { context } : {}),
    ...(nonBlank(value.modelId) ? { modelId: value.modelId } : {}),
    ...(typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
      ? { durationMs: value.durationMs }
      : {}),
    ...(typeof value.sessionTokens === "number" &&
    Number.isFinite(value.sessionTokens) &&
    value.sessionTokens >= 0
      ? { sessionTokens: value.sessionTokens }
      : {}),
    ...(typeof value.sessionTokenFloor === "number" &&
    Number.isFinite(value.sessionTokenFloor) &&
    value.sessionTokenFloor >= 0
      ? { sessionTokenFloor: value.sessionTokenFloor }
      : {}),
    ...(typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0
      ? { costUsd: value.costUsd }
      : {}),
    ...(turns.length > 0
      ? { turns: turns as NonNullable<NonNullable<SessionState["usage"]>["turns"]> }
      : {}),
    ...(account.length > 0
      ? { account: account as NonNullable<NonNullable<SessionState["usage"]>["account"]> }
      : {}),
    updatedAt: nonBlank(value.updatedAt) ? value.updatedAt : new Date().toISOString(),
  };
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
      if (part.type !== "tool-invocation" || part.toolName !== "updateTodos") continue;
      const todos = readTodos(part.toolArgs?.todos);
      if (todos.length > 0) return todos;
    }
  }
  return [];
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readJournalState(value: unknown): "completed" | "failed" | "ambiguous" | "discarded" {
  if (value === "completed" || value === "failed" || value === "discarded") return value;
  return "ambiguous";
}

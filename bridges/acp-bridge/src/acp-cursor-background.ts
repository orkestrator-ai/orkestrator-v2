import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname } from "node:path";
import {
  CURSOR_BACKGROUND_CONTINUATION_PREFIX,
  MAX_CURSOR_CHILD_RESULT_BYTES,
  MAX_CURSOR_SETTLED_CLAIMS,
  MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN,
  MAX_MESSAGE_TEXT_BYTES,
  isObject,
  provider,
  type SessionState,
} from "./acp-context.js";
import { schedulePersist } from "./acp-persist-writer.js";
import { boundTranscript, truncateUtf8 } from "./acp-transcript.js";
import { finishSubagentTool, terminalAgentState, toolPartAgentId } from "./acp-tools.js";
import {
  syncCursorChildTranscriptParts,
  type CursorChildTranscriptState,
} from "./acp-cursor-transcript-parts.js";
import {
  bindDiscoveredCursorChildren,
  cursorChildTranscriptPath,
  cursorTranscriptRoot,
} from "./acp-cursor-child-discovery.js";

// Path derivation moved to the discovery module, which owns the transcript
// root. Re-exported so existing callers and tests keep one import site.
export {
  cursorChildTranscriptPath,
  cursorTranscriptRoot,
  isSafeCursorAgentId,
} from "./acp-cursor-child-discovery.js";

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_POLL_MS = 250;
/** One entry per watched child path; a session cannot exceed the hydrate cap. */
const MAX_TRANSCRIPT_READ_CACHE_ENTRIES = 64;

interface TranscriptReadCacheEntry {
  size: number;
  mtimeMs: number;
  terminalPresent: boolean;
  appliedState: CursorChildTranscriptState;
}

interface TerminalProbeEntry {
  size: number;
  mtimeMs: number;
  terminal: "finished" | "failed" | undefined;
}

const transcriptReadCache = new Map<string, TranscriptReadCacheEntry>();
/**
 * Terminal state per child transcript, keyed by path.
 *
 * Separate from `transcriptReadCache` on purpose: that one records what a
 * *projection* applied, and a probe that wrote its `size`/`mtimeMs` without
 * projecting anything would make the next hydration skip a file it never read.
 */
const terminalProbeCache = new Map<string, TerminalProbeEntry>();
/**
 * What the last probe-driven discovery pass for a session was computed
 * against. See `bindDiscoveredChildrenForProbe`.
 */
const probeDiscoveryMemo = new WeakMap<
  SessionState,
  { rootMtimeMs: number; activeCount: number }
>();

export interface WatchableCursorChild {
  toolUseId: string;
  agentId: string;
  description?: string;
  transcriptPath: string;
}

export interface CursorChildWaitOutcome {
  toolUseId: string;
  agentId: string;
  description?: string;
  agentState: "finished" | "failed";
  resultText: string;
  timedOut: boolean;
}

/**
 * Cursor-only. Default on so a background Task's parent generation stays
 * running until the child's transcript ends. Tests force this off in
 * `spawnBridge` unless they opt in. Grok settles through `subagent_finished`
 * and must not enter this path even when the env var is set.
 */
export function cursorBackgroundContinueEnabled(): boolean {
  if (provider !== "cursor") return false;
  const raw = process.env.ACP_CURSOR_BACKGROUND_CONTINUE?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

/**
 * Live children this session can follow on disk.
 *
 * `includeDiscovered` decides whether inferred bindings count. Projection wants
 * them — that is the whole point of the inference — but the continuation waiter
 * must not: holding `session/prompt` open on a guess would stall the parent
 * turn for the entire wait budget if the guess were wrong.
 */
export function listWatchableCursorChildren(
  state: SessionState,
  options: { includeDiscovered?: boolean } = {},
): WatchableCursorChild[] {
  const includeDiscovered = options.includeDiscovered ?? true;
  const children: WatchableCursorChild[] = [];
  for (const toolUseId of state.activeSubagentToolIds) {
    const descriptor = state.activeSubagentDescriptors.get(toolUseId);
    const agentId = descriptor?.agentId?.trim();
    if (!descriptor || !agentId) continue;
    if (descriptor.agentIdDiscovered && !includeDiscovered) continue;
    // An unusable id is treated exactly like a missing one: no watch, no
    // hydration, and the parent turn does not block on a child it cannot find.
    const transcriptPath = cursorChildTranscriptPath(agentId);
    if (!transcriptPath) continue;
    children.push({
      toolUseId,
      agentId,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      transcriptPath,
    });
  }
  return children;
}

/**
 * Project Cursor child JSONL activity onto Task cards when the UI reads a
 * snapshot. `/activity` must not call this: it is a liveness probe, and this
 * re-parses whole transcripts. `settleTerminalCursorChildren` is the bounded
 * part of it that a probe may run.
 */
export function hydrateCursorChildTranscripts(state: SessionState): void {
  if (provider !== "cursor") return;
  // A foreground child is never named on the wire until it ends, so the read
  // that is about to project activity is also the moment to work out which
  // transcript a still-running card belongs to.
  bindDiscoveredCursorChildren(state);
  const children: WatchableCursorChild[] = [];
  const seen = new Set<string>();
  for (const child of listWatchableCursorChildren(state)) {
    seen.add(child.toolUseId);
    children.push(child);
    if (children.length >= MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN) break;
  }
  if (children.length < MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN) {
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index];
      if (!message) continue;
      for (const part of message.parts) {
        if (part.type !== "tool-invocation" || seen.has(part.toolUseId) || part.parentTaskUseId) {
          continue;
        }
        const agentId = toolPartAgentId(part);
        if (!agentId) continue;
        const transcriptPath = cursorChildTranscriptPath(agentId);
        if (!transcriptPath) continue;
        seen.add(part.toolUseId);
        children.push({ toolUseId: part.toolUseId, agentId, transcriptPath });
        if (children.length >= MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN) break;
      }
      if (children.length >= MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN) break;
    }
  }

  for (const child of children) {
    try {
      hydrateOneCursorChild(state, child);
    } catch {
      // A missing or unreadable child file leaves the card empty.
    }
  }
  // The reads above already know which of those children ended, so the card
  // they belong to is settled from the same pass rather than waiting for a
  // frame Cursor may never send for a background launch.
  settleTerminalCursorChildren(state);
}

/**
 * Settle Task cards whose child has ended on disk.
 *
 * A Cursor background launch completes as soon as the child is *spawned*, so
 * `{ isBackground: true }` with no later status keeps the card `active`
 * forever unless something else reports the end. `cursor/task` and a later
 * `tool_call_update` are the two frames that can, and neither is guaranteed:
 * an unnamed background child produces exactly the launch payload and nothing
 * more. The child's own transcript is the remaining authority, and a terminal
 * record in it is a statement about the child, not a guess.
 *
 * Cheap enough for `/session/:id/activity`, which the backend polls for every
 * persisted session every two seconds: one `stat` per active child, capped at
 * `MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN`, and a bounded tail read only when
 * a file changed since the last look. It touches no liveness, hydrates no
 * transcript and re-attaches nothing.
 */
export function settleTerminalCursorChildren(state: SessionState): boolean {
  if (provider !== "cursor") return false;
  if (state.activeSubagentToolIds.size === 0) return false;
  // A live turn owns its own children: `waitForWatchableCursorChildren` settles
  // them and then injects their results. Settling one from here first would
  // drop it out of the registry before the waiter listed it, and the parent
  // would continue without ever being told what its child found.
  if (state.status === "running") return false;
  // An unnamed background child has no `agentId` on the wire at all, which is
  // exactly the case that strands a card, so the probe has to be able to infer
  // one — cheaply.
  bindDiscoveredChildrenForProbe(state);
  let settled = false;
  let inspected = 0;
  for (const child of listWatchableCursorChildren(state)) {
    if (inspected >= MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN) break;
    inspected += 1;
    const terminal = probeCursorChildTerminalState(child.transcriptPath);
    // No terminal record is not evidence the child died. It stays active, and
    // the card stays live, exactly as before.
    if (!terminal) continue;
    // Before the settle, not after: `finishSubagentTool` deletes the descriptor
    // that holds a discovered `agentId`, and this probe never projects the
    // child's JSONL, so this set is the only place the claim survives. Without
    // it the directory reads as unclaimed and the next unnamed launch within
    // the discovery skew window binds a transcript that is already terminal.
    rememberSettledCursorAgentId(state, child.agentId);
    finishSubagentTool(state, child.toolUseId, terminal);
    settled = true;
  }
  return settled;
}

/**
 * Retain a consumed child directory's claim past the card that owned it.
 *
 * Oldest-first eviction: a claim only matters against launches inside
 * `CURSOR_CHILD_DISCOVERY_SKEW_MS`, so the entries that fall out are the ones
 * no live launch could still reach.
 */
function rememberSettledCursorAgentId(state: SessionState, agentId: string): void {
  if (state.settledCursorAgentIds.has(agentId)) return;
  while (state.settledCursorAgentIds.size >= MAX_CURSOR_SETTLED_CLAIMS) {
    const oldest = state.settledCursorAgentIds.values().next();
    if (oldest.done) break;
    state.settledCursorAgentIds.delete(oldest.value);
  }
  state.settledCursorAgentIds.add(agentId);
}

/**
 * `bindDiscoveredCursorChildren`, but only when its answer can have changed.
 *
 * That function walks every message of every session to work out which child
 * directories are already claimed. A visible tab pays for it twice a second and
 * gets a projection back; the activity sweep runs for *every persisted session*
 * whether or not anyone is looking, so paying the same cost there for an answer
 * that cannot have moved is exactly the poll cost `/activity` is supposed not
 * to have. A new binding needs either a new directory under the transcript root
 * — which changes the root's mtime — or a change in what this session is
 * waiting on. Neither is true in the steady state, so this settles to one
 * `stat`.
 */
function bindDiscoveredChildrenForProbe(state: SessionState): void {
  let rootMtimeMs: number;
  try {
    rootMtimeMs = statSync(cursorTranscriptRoot()).mtimeMs;
  } catch {
    // No transcript root means no directory to bind anything to.
    return;
  }
  const activeCount = state.activeSubagentToolIds.size;
  const memo = probeDiscoveryMemo.get(state);
  if (memo && memo.rootMtimeMs === rootMtimeMs && memo.activeCount === activeCount) return;
  probeDiscoveryMemo.set(state, { rootMtimeMs, activeCount });
  bindDiscoveredCursorChildren(state);
}

/**
 * Terminal state of one child transcript, from a `stat` alone when the file
 * has not changed since the last look. A child that is still writing changes
 * its file, so the read this pays for is bounded by the child's own progress.
 */
export function probeCursorChildTerminalState(
  transcriptPath: string,
): "finished" | "failed" | undefined {
  let stats;
  try {
    stats = statSync(transcriptPath);
  } catch {
    // Same rule as the projection cache: a path that disappears drops its
    // entry so a later file at the same path is never read as unchanged.
    terminalProbeCache.delete(transcriptPath);
    return undefined;
  }
  const cached = terminalProbeCache.get(transcriptPath);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return cached.terminal;
  }
  let terminal: "finished" | "failed" | undefined;
  try {
    terminal = cursorTranscriptTerminalState(readTranscriptTail(transcriptPath));
  } catch {
    return undefined;
  }
  rememberTerminalProbe(transcriptPath, stats.size, stats.mtimeMs, terminal);
  return terminal;
}

function rememberTerminalProbe(
  transcriptPath: string,
  size: number,
  mtimeMs: number,
  terminal: "finished" | "failed" | undefined,
): void {
  if (
    terminalProbeCache.size >= MAX_TRANSCRIPT_READ_CACHE_ENTRIES &&
    !terminalProbeCache.has(transcriptPath)
  ) {
    const oldest = terminalProbeCache.keys().next();
    if (!oldest.done) terminalProbeCache.delete(oldest.value);
  }
  terminalProbeCache.set(transcriptPath, { size, mtimeMs, terminal });
}

/**
 * `/session/:id/messages` is polled twice a second per visible tab, and the
 * neighbouring `boundTranscriptForRead` exists precisely because a poll must
 * not pay a whole extra pass over the transcript. Re-reading and re-parsing up
 * to `MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN` × 256 KiB on every poll would do
 * exactly that, so a `stat` gates the read: an unchanged file whose derived
 * state is also unchanged costs one syscall and nothing else.
 *
 * The derived state has to be part of that check. A child leaving the active
 * registry moves it from `live` to `abandoned` without touching the file, and
 * a file-only cache would strand its trailing tools as `pending` forever.
 */
function hydrateOneCursorChild(state: SessionState, child: WatchableCursorChild): void {
  let stats;
  try {
    stats = statSync(child.transcriptPath);
  } catch {
    // A path that disappears must drop its entry, or a later file at the same
    // path could be mistaken for an unchanged read.
    transcriptReadCache.delete(child.transcriptPath);
    return;
  }
  const active = state.activeSubagentToolIds.has(child.toolUseId);
  const cached = transcriptReadCache.get(child.transcriptPath);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    // Terminal-ness cannot change while the bytes do not, so the cached flag
    // is enough to re-derive the state without re-reading or re-parsing.
    const unread = cursorChildStateFrom(cached.terminalPresent, active);
    if (unread === cached.appliedState) return;
  }

  const contents = readTranscriptTail(child.transcriptPath);
  const terminal = cursorTranscriptTerminalState(contents);
  // This read is the expensive one; the probe cache rides along on it so the
  // `/activity` poll behind `settleTerminalCursorChildren` never repeats it.
  rememberTerminalProbe(child.transcriptPath, stats.size, stats.mtimeMs, terminal);
  const terminalPresent = terminal !== undefined;
  const childState = cursorChildStateFrom(terminalPresent, active);
  syncCursorChildTranscriptParts(state, child, contents, childState);
  if (
    transcriptReadCache.size >= MAX_TRANSCRIPT_READ_CACHE_ENTRIES &&
    !transcriptReadCache.has(child.transcriptPath)
  ) {
    const oldest = transcriptReadCache.keys().next();
    if (!oldest.done) transcriptReadCache.delete(oldest.value);
  }
  transcriptReadCache.set(child.transcriptPath, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    terminalPresent,
    appliedState: childState,
  });
}

/**
 * Only the transcript can say a child *completed*. The registry distinguishes
 * the two remaining cases, and it must not be consulted first: it is rebuilt
 * empty on load, so a registry-first test would report every restored child as
 * finished and mark whatever tool it died inside as successful.
 */
function cursorChildStateFrom(
  terminalPresent: boolean,
  active: boolean,
): CursorChildTranscriptState {
  if (terminalPresent) return "ended";
  return active ? "live" : "abandoned";
}

export function cursorTranscriptTerminalState(contents: string): "finished" | "failed" | undefined {
  const lines = contents.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!isObject(parsed)) continue;
      if (parsed.type !== "turn_ended" && parsed.type !== "result") continue;
      const status =
        typeof parsed.status === "string"
          ? parsed.status
          : typeof parsed.subtype === "string"
            ? parsed.subtype
            : undefined;
      if (parsed.is_error === true || cursorTranscriptErrorPresent(parsed.error)) {
        return "failed";
      }
      const named = terminalAgentState(status);
      if (named) return named;
      // Unknown non-empty statuses fail closed. A terminal record with no
      // status still means the child ended, which is the historical default.
      return status ? "failed" : "finished";
    } catch {
      // A tail read can start mid-line; skip anything that is not a record.
    }
  }
  return undefined;
}

export function cursorTranscriptAssistantText(contents: string): string {
  const chunks: string[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isObject(parsed)) continue;
      const text = assistantRecordText(parsed);
      if (text) chunks.push(text);
    } catch {
      // Same mid-line skip as the terminal-state scan.
    }
  }
  return truncateUtf8(chunks.join("\n\n").trim(), MAX_CURSOR_CHILD_RESULT_BYTES);
}

export async function waitForCursorChildTranscript(
  transcriptPath: string,
  timeoutMs: number,
  signal: AbortSignal,
  onContents?: (contents: string, terminal: "finished" | "failed" | undefined) => void,
): Promise<"finished" | "failed" | "timeout" | "cancelled"> {
  const inspect = (): "finished" | "failed" | undefined => {
    if (!existsSync(transcriptPath)) return undefined;
    try {
      const contents = readTranscriptTail(transcriptPath);
      const terminal = cursorTranscriptTerminalState(contents);
      onContents?.(contents, terminal);
      return terminal;
    } catch {
      return undefined;
    }
  };
  const immediate = inspect();
  if (immediate) return immediate;
  if (signal.aborted) return "cancelled";

  return await new Promise((resolvePromise) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    let dirWatcher: FSWatcher | undefined;
    const finish = (value: "finished" | "failed" | "timeout" | "cancelled"): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      watcher?.close();
      dirWatcher?.close();
      resolvePromise(value);
    };
    const onAbort = (): void => finish("cancelled");
    signal.addEventListener("abort", onAbort);
    const poll = setInterval(() => {
      const terminal = inspect();
      if (terminal) finish(terminal);
    }, TRANSCRIPT_POLL_MS);
    poll.unref();
    const timer = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs));
    timer.unref();
    try {
      const directory = dirname(transcriptPath);
      if (existsSync(directory)) {
        dirWatcher = watch(directory, () => {
          const terminal = inspect();
          if (terminal) finish(terminal);
        });
      }
      if (existsSync(transcriptPath)) {
        watcher = watch(transcriptPath, () => {
          const terminal = inspect();
          if (terminal) finish(terminal);
        });
      }
    } catch {
      // Polling is enough when the platform cannot watch the path.
    }
  });
}

export async function waitForWatchableCursorChildren(
  state: SessionState,
  children: WatchableCursorChild[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CursorChildWaitOutcome[]> {
  const started = Date.now();
  return Promise.all(
    children.map(async (child) => {
      const remaining = Math.max(0, timeoutMs - (Date.now() - started));
      const waited = await waitForCursorChildTranscript(
        child.transcriptPath,
        remaining,
        signal,
        (contents, terminal) => {
          // The wait itself is the proof the child is live, so the only two
          // states reachable here are `ended` and `live` — never `abandoned`.
          syncCursorChildTranscriptParts(
            state,
            child,
            contents,
            terminal !== undefined ? "ended" : "live",
          );
        },
      );
      const contents = existsSync(child.transcriptPath)
        ? readTranscriptTail(child.transcriptPath)
        : "";
      const timedOut = waited === "timeout";
      const cancelled = waited === "cancelled";
      const agentState = waited === "finished" ? "finished" : "failed";
      const resultText = timedOut
        ? "The child's transcript did not report completion within the wait budget. Treat the result as unavailable."
        : cancelled
          ? "The parent turn was cancelled before the child reported completion."
          : cursorTranscriptAssistantText(contents) ||
            (waited === "failed" ? "The child ended without a text result." : "");
      return {
        toolUseId: child.toolUseId,
        agentId: child.agentId,
        ...(child.description ? { description: child.description } : {}),
        agentState,
        resultText,
        timedOut,
      };
    }),
  );
}

export function formatCursorBackgroundContinuation(outcomes: CursorChildWaitOutcome[]): string {
  const body = outcomes
    .map((outcome) => {
      const lines = [
        `Id: ${outcome.agentId}`,
        ...(outcome.description ? [`Task: ${outcome.description}`] : []),
        `Status: ${outcome.timedOut ? "timeout" : outcome.agentState}`,
        "",
        outcome.resultText,
      ];
      return lines.join("\n");
    })
    .join("\n\n");
  return [
    CURSOR_BACKGROUND_CONTINUATION_PREFIX,
    "",
    body,
    "",
    "Continue the original request. Do not relaunch these subagents. Use the results above.",
  ].join("\n");
}

export function pushContinuationUserMessage(state: SessionState, text: string): void {
  const content = truncateUtf8(text, MAX_MESSAGE_TEXT_BYTES);
  const userMessageId = randomBytes(12).toString("hex");
  state.messages.push({
    id: userMessageId,
    role: "user",
    content,
    parts: [
      {
        type: "text",
        content,
        sourcePartId: `${userMessageId}:0`,
        sourceMessageId: userMessageId,
      },
    ],
    createdAt: new Date().toISOString(),
  });
  state.revision += 1;
  boundTranscript(state);
  schedulePersist();
}

function cursorTranscriptErrorPresent(error: unknown): boolean {
  if (error == null || error === false) return false;
  if (typeof error === "string") return error.trim().length > 0;
  return true;
}

function assistantRecordText(parsed: Record<string, unknown>): string | undefined {
  const role = parsed.role === "assistant" || parsed.type === "assistant";
  if (!role) return undefined;
  const message = isObject(parsed.message) ? parsed.message : parsed;
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .map((part) => {
      if (!isObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (isObject(part.content) && typeof part.content.text === "string") {
        return part.content.text;
      }
      return "";
    })
    .join("");
  return text.trim() || undefined;
}

function readTranscriptTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Test-only: drops the stat caches so a rewritten fixture is re-read. */
export function resetCursorTranscriptReadCache(): void {
  transcriptReadCache.clear();
  terminalProbeCache.clear();
}

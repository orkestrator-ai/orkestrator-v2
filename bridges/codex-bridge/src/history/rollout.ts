/**
 * Reading Codex's own on-disk state: rollout transcripts and the session index.
 *
 * `thread/list` / `thread/read` are the primary history source; this is the
 * documented fallback. It stays because legacy, archived, malformed and
 * partially-written rollouts are only visible on disk, and because a thread's
 * transcript is hydrated from its rollout when it is re-attached after being
 * detached.
 *
 * Metadata scans read only the **head** of each rollout — they touch every file on
 * disk, so full reads cost ~5.3GB of retained heap against a 1.6GB Codex home.
 * Full reads are reserved for hydrating one specific thread.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readCachedTranscript, readTranscriptHead } from "../transcript-cache.js";
import {
  buildFallbackSessionTitle,
  readPersistedSessionTitleEntries,
  type PersistedSessionTitleSource,
} from "../session-titles.js";
import {
  createMessageId,
  type MessageRole,
  type NormalizedMessage,
  type NormalizedPart,
  type ToolState,
} from "../messages/types.js";
import {
  applyTranscriptToolOutput,
  normalizeTranscriptToolArgs,
} from "../subagent-transcript.js";

export interface PersistedSessionIndexEntry {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
}

export interface PersistedSessionMeta {
  id: string;
  title?: string;
  titleSource?: "codex" | PersistedSessionTitleSource;
  updatedAt: string;
  cwd?: string;
  transcriptPath?: string;
}

export interface TranscriptCatalog {
  metas: PersistedSessionMeta[];
  metaByPath: Map<string, PersistedSessionMeta>;
  transcriptPathByThreadId: Map<string, string>;
}


export function getCodexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function getWorkingDirectory(explicitCwd?: string): string {
  return explicitCwd || process.env.CWD || process.cwd();
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
  let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkJsonlFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && absolutePath.endsWith(".jsonl")) {
      files.push(absolutePath);
    }
  }

  return files;
}

export async function listTranscriptPaths(): Promise<string[]> {
  const searchRoots = [
    join(getCodexHomeDir(), "sessions"),
    join(getCodexHomeDir(), "archived_sessions"),
  ];
  return (await Promise.all(searchRoots.map((root) => walkJsonlFiles(root)))).flat();
}

/**
 * Either an already-materialized path snapshot or a lazy loader for one.
 *
 * The lazy form is what lets `findTranscriptPath` answer from its cache without
 * paying for a directory walk that would then be thrown away: the walk touches
 * every rollout under the Codex home (thousands of files), and this lookup runs
 * on every render tick of a streaming turn.
 */
export type TranscriptPathSource =
  | readonly string[]
  | (() => Promise<readonly string[]>);

interface CachedTranscriptPath {
  path: string | null;
  checkedAt: number;
}

/**
 * threadId → rollout path, keyed by Codex home so a changed `CODEX_HOME` cannot
 * serve paths from another store. Positive entries are revalidated with a stat —
 * a rollout is never renamed while in use, so existence is sufficient. Negative
 * entries expire quickly: a freshly spawned thread's rollout appears on disk
 * moments after the miss.
 */
const cachedTranscriptPaths = new Map<string, CachedTranscriptPath>();
export const TRANSCRIPT_PATH_NEGATIVE_TTL_MS = 5_000;
export const MAX_CACHED_TRANSCRIPT_PATHS = 4_096;

interface TranscriptPathCacheLimits {
  negativeTtlMs: number;
  maxEntries: number;
}

const DEFAULT_PATH_CACHE_LIMITS: TranscriptPathCacheLimits = {
  negativeTtlMs: TRANSCRIPT_PATH_NEGATIVE_TTL_MS,
  maxEntries: MAX_CACHED_TRANSCRIPT_PATHS,
};

let pathCacheLimits: TranscriptPathCacheLimits = DEFAULT_PATH_CACHE_LIMITS;

export function setTranscriptPathCacheLimitsForTesting(
  overrides?: Partial<TranscriptPathCacheLimits>,
): void {
  pathCacheLimits = { ...DEFAULT_PATH_CACHE_LIMITS, ...overrides };
}

/**
 * The NUL separator is written as an escape on purpose: a raw NUL byte in the
 * source makes git classify this file as binary, which costs every future
 * diff, blame and merge on it.
 */
function transcriptPathCacheKey(threadId: string): string {
  return `${getCodexHomeDir()}\u0000${threadId}`;
}

function rememberTranscriptPath(threadId: string, path: string | null): void {
  const key = transcriptPathCacheKey(threadId);
  cachedTranscriptPaths.delete(key);
  cachedTranscriptPaths.set(key, { path, checkedAt: Date.now() });
  while (cachedTranscriptPaths.size > pathCacheLimits.maxEntries) {
    const oldest = cachedTranscriptPaths.keys().next().value;
    if (oldest === undefined) break;
    cachedTranscriptPaths.delete(oldest);
  }
}

export function clearTranscriptPathCache(): void {
  cachedTranscriptPaths.clear();
}

export function getTranscriptPathCacheStats(): { entries: number } {
  return { entries: cachedTranscriptPaths.size };
}

export async function findTranscriptPath(
  threadId: string,
  transcriptPaths?: TranscriptPathSource,
): Promise<string | null> {
  // An explicit snapshot is authoritative for this call; do not cache results
  // derived from it, since the caller may have scoped or filtered the listing.
  if (typeof transcriptPaths === "object") {
    return transcriptPaths.find((file) => file.includes(threadId)) ?? null;
  }

  const key = transcriptPathCacheKey(threadId);
  const cached = cachedTranscriptPaths.get(key);
  if (cached) {
    if (cached.path !== null) {
      try {
        await stat(cached.path);
        return cached.path;
      } catch {
        cachedTranscriptPaths.delete(key);
      }
    } else if (Date.now() - cached.checkedAt < pathCacheLimits.negativeTtlMs) {
      return null;
    }
  }

  const paths = transcriptPaths ? await transcriptPaths() : await listTranscriptPaths();
  const found = paths.find((file) => file.includes(threadId)) ?? null;
  rememberTranscriptPath(threadId, found);
  return found;
}

/**
 * Reads a JSONL file's non-empty lines without going through the transcript
 * cache. The cache retains parsed records only; the one remaining raw-line
 * consumer is `session_index.jsonl`, a small file where a plain read is
 * cheaper than caching it alongside multi-MB rollouts.
 *
 * Returns `[]` for a missing or unreadable index: an absent session index is
 * the normal state for a fresh Codex home, not an error.
 */
export async function readTranscriptLines(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Builds a session-list entry from a rollout.
 *
 * Reads only the **head** of the file. Everything needed — `session_meta` and the
 * first user message — sits at the start, but this function is called for every
 * rollout on disk, so reading them in full loaded the entire Codex history into
 * memory: measured at ~5.3GB of heap for a 1.6GB store, retained for the life of
 * the bridge. Full reads are reserved for hydrating one specific thread.
 */
export async function getSessionMetaFromTranscriptPath(
  transcriptPath: string,
  fallbackTitle?: string,
  fallbackUpdatedAt?: string,
): Promise<PersistedSessionMeta | null> {
  const { records } = await readTranscriptHead(transcriptPath);
  const sessionMetaRecord = records.find((record) => record.type === "session_meta");

  if (!sessionMetaRecord?.payload) {
    return null;
  }

  const payload = sessionMetaRecord.payload;
  const id =
    typeof payload.id === "string" && payload.id.length > 0
      ? payload.id
      : null;

  if (!id) {
    return null;
  }

  let firstUserText: string | null = null;
  for (const record of records) {
    if (
      record.type !== "response_item"
      || record.payload?.type !== "message"
      || record.payload?.role !== "user"
    ) {
      continue;
    }
    firstUserText = extractPersistedMessageText(record.payload.content, "user");
    if (firstUserText) break;
  }
  const transcriptTitle = firstUserText
    ? buildFallbackSessionTitle(firstUserText)
    : undefined;

  return {
    id,
    title: fallbackTitle ?? transcriptTitle,
    titleSource: fallbackTitle ? "codex" : (transcriptTitle ? "prompt" : undefined),
    updatedAt:
      typeof payload.timestamp === "string"
        ? payload.timestamp
        : (fallbackUpdatedAt ?? new Date().toISOString()),
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    transcriptPath,
  };
}

export async function buildTranscriptCatalog(): Promise<TranscriptCatalog> {
  const metas: PersistedSessionMeta[] = [];
  const metaByPath = new Map<string, PersistedSessionMeta>();
  const transcriptPathByThreadId = new Map<string, string>();

  for (const root of [
    join(getCodexHomeDir(), "sessions"),
    join(getCodexHomeDir(), "archived_sessions"),
  ]) {
    const files = await walkJsonlFiles(root);
    for (const transcriptPath of files) {
      const meta = await getSessionMetaFromTranscriptPath(transcriptPath);
      if (!meta) {
        continue;
      }

      metas.push(meta);
      metaByPath.set(transcriptPath, meta);

      const fileThreadId = basename(transcriptPath, ".jsonl");
      if (!transcriptPathByThreadId.has(fileThreadId)) {
        transcriptPathByThreadId.set(fileThreadId, transcriptPath);
      }
      if (!transcriptPathByThreadId.has(meta.id)) {
        transcriptPathByThreadId.set(meta.id, transcriptPath);
      }
    }
  }

  return {
    metas,
    metaByPath,
    transcriptPathByThreadId,
  };
}

export async function getPersistedSessionMeta(
  threadId: string,
  fallbackTitle?: string,
  fallbackUpdatedAt?: string,
  transcriptCatalog?: TranscriptCatalog,
  transcriptPaths?: TranscriptPathSource,
): Promise<PersistedSessionMeta | null> {
  const transcriptPath = transcriptCatalog
    ? transcriptCatalog.transcriptPathByThreadId.get(threadId) ??
      transcriptCatalog.metas.find((meta) => meta.transcriptPath?.includes(threadId))
        ?.transcriptPath ??
      null
    : await findTranscriptPath(threadId, transcriptPaths);
  if (!transcriptPath) {
    return fallbackUpdatedAt
      ? {
          id: threadId,
          title: fallbackTitle,
          titleSource: fallbackTitle ? "codex" : undefined,
          updatedAt: fallbackUpdatedAt,
        }
      : null;
  }

  const cachedMeta = transcriptCatalog?.metaByPath.get(transcriptPath);
  const meta = cachedMeta
    ? {
        ...cachedMeta,
        title: fallbackTitle ?? cachedMeta.title,
        titleSource: fallbackTitle ? "codex" as const : cachedMeta.titleSource,
        updatedAt: cachedMeta.updatedAt || fallbackUpdatedAt || new Date().toISOString(),
      }
    : await getSessionMetaFromTranscriptPath(
        transcriptPath,
        fallbackTitle,
        fallbackUpdatedAt,
      );
  if (!meta) {
    return {
      id: threadId,
      title: fallbackTitle,
      titleSource: fallbackTitle ? "codex" : undefined,
      updatedAt: fallbackUpdatedAt || new Date().toISOString(),
      transcriptPath,
    };
  }

  if (meta.id !== threadId) {
    meta.id = threadId;
  }

  return meta;
}

export function createSharedTranscriptMetaLoader(
  loadPaths: () => Promise<string[]> = listTranscriptPaths,
  loadMeta: (
    threadId: string,
    transcriptPaths: () => Promise<readonly string[]>,
  ) => Promise<PersistedSessionMeta | null> = (threadId, transcriptPaths) =>
    getPersistedSessionMeta(
      threadId,
      undefined,
      undefined,
      undefined,
      transcriptPaths,
    ),
): (threadId: string) => Promise<PersistedSessionMeta | null> {
  // Lazy on purpose: when every requested thread answers from the path cache,
  // the directory walk never happens at all. The promise is still shared, so
  // concurrent misses within one load pay for at most one walk.
  let transcriptPathsPromise: Promise<string[]> | undefined;
  const listPathsOnce = () => (transcriptPathsPromise ??= loadPaths());
  return async (threadId) => loadMeta(threadId, listPathsOnce);
}

export async function listPersistedSessionsForCwd(cwd: string): Promise<PersistedSessionMeta[]> {
  const indexPath = join(getCodexHomeDir(), "session_index.jsonl");
  const lines = await readTranscriptLines(indexPath);
  const sessions = new Map<string, PersistedSessionMeta>();
  const transcriptCatalog = await buildTranscriptCatalog();

  for (const line of lines) {
    let entry: PersistedSessionIndexEntry;
    try {
      entry = JSON.parse(line) as PersistedSessionIndexEntry;
    } catch {
      continue;
    }

    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (!id) continue;

    const meta = await getPersistedSessionMeta(
      id,
      typeof entry.thread_name === "string" ? entry.thread_name : undefined,
      typeof entry.updated_at === "string" ? entry.updated_at : undefined,
      transcriptCatalog,
    );

    if (!meta || meta.cwd !== cwd) {
      continue;
    }

    sessions.set(meta.id, meta);
  }

  // Active sessions can exist on disk before Codex appends them to session_index.jsonl,
  // so scan transcript files directly and merge any missing matches for this cwd.
  for (const meta of transcriptCatalog.metas) {
    if (meta.cwd !== cwd) {
      continue;
    }
    mergePersistedSessionMeta(sessions, meta);
  }

  const generatedTitles = await readPersistedSessionTitleEntries(getCodexHomeDir());
  for (const session of sessions.values()) {
    const generatedTitle = generatedTitles.get(session.id);
    if (generatedTitle && session.titleSource !== "codex") {
      session.title = generatedTitle.title;
      session.titleSource = generatedTitle.source;
    }
  }

  return Array.from(sessions.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function mergePersistedSessionMeta(
  sessionsById: Map<string, PersistedSessionMeta>,
  meta: PersistedSessionMeta,
): void {
  const indexed = sessionsById.get(meta.id);
  if (!indexed) {
    sessionsById.set(meta.id, { ...meta });
    return;
  }

  if (new Date(meta.updatedAt).getTime() > new Date(indexed.updatedAt).getTime()) {
    indexed.updatedAt = meta.updatedAt;
  }
}

function isSyntheticPersistedUserText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("# AGENTS.md instructions for ")
    || trimmed.startsWith(
      "<recommended_plugins>\nHere is a list of plugins that are available but not installed.",
    );
}

export function extractPersistedMessageText(
  content: unknown,
  role: MessageRole,
): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const key = role === "assistant" ? "output_text" : "input_text";
  const segments = content
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return record.type === key && typeof record.text === "string"
        ? record.text
        : null;
    })
    .filter((segment): segment is string => typeof segment === "string");

  if (segments.length === 0) {
    return null;
  }

  const text = segments.join("\n").trim();
  if (!text) {
    return null;
  }

  if (role === "user" && isSyntheticPersistedUserText(text)) {
    return null;
  }

  return text;
}

/**
 * Reads a Codex turn id from a rollout record payload.
 *
 * Codex writes it as `turn_id`; accept the camelCase spelling too so a future
 * rollout-format change degrades to "no fork point" rather than silently
 * assigning messages to the previous turn.
 */
function readTurnId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["turn_id", "turnId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function readTurnModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return asNonEmptyString((payload as Record<string, unknown>).model);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * The outcome a rollout *call* record claims. `"pending"` means it claimed none.
 *
 * `function_call` records carry no `status` field at all (92,495 of 92,495 across
 * this repo's full Codex history), so every one starts `"pending"` — "in flight,
 * and this record does not say how it ended". `custom_tool_call` records do carry
 * one, always `"completed"` in 34,640 sampled records; `"failed"` is the
 * counterpart in the same field and is kept as a guard rather than deleted.
 *
 * Mirrors `parseChildTranscript`, which reads the same records from child rollouts.
 */
function persistedToolState(value: unknown): ToolState {
  return value === "failed"
    ? "failure"
    : value === "completed"
      ? "success"
      : "pending";
}

function createPersistedToolPart(
  payload: Record<string, unknown>,
): NormalizedPart {
  const toolName = asNonEmptyString(payload.name) ?? "tool";
  const rawArgs = payload.type === "custom_tool_call"
    ? payload.input
    : payload.arguments;
  const toolState = persistedToolState(payload.status);
  const part: NormalizedPart = {
    type: "tool-invocation",
    content: toolName,
    toolName,
    toolArgs: normalizeTranscriptToolArgs(toolName, rawArgs),
    toolState,
    toolTitle: toolName,
  };

  // Only a `custom_tool_call` can carry both a terminal outcome and an inline
  // result on the call record itself; a `function_call` never does.
  return payload.type === "custom_tool_call" && toolState !== "pending"
    ? applyTranscriptToolOutput(part, payload.output, toolState)
    : part;
}

/**
 * The outcome to carry over when a `*_call_output` record is folded in.
 *
 * `null` means "the rollout never recorded an outcome", which clears `toolState`
 * instead of asserting success. A `function_call_output` is written whether the
 * command succeeded or failed and carries no status, exit code, or error marker
 * (12,785 sampled outputs: no candidate marker appeared in more than 0.2%), so
 * inferring success from its presence would paint a green badge on every failed
 * command. `custom_tool_call_output` keeps whatever its call record claimed.
 */
function persistedOutputState(
  payloadType: unknown,
  part: NormalizedPart,
): ToolState | null {
  return payloadType === "custom_tool_call_output" ? (part.toolState ?? null) : null;
}

export async function hydrateMessagesFromPersistedSession(
  threadId: string,
): Promise<{
  messages: NormalizedMessage[];
  title?: string;
  titleSource?: PersistedSessionMeta["titleSource"];
}> {
  const meta = (await listPersistedSessionsForCwd(getWorkingDirectory()))
    .find((session) => session.id === threadId)
    ?? await getPersistedSessionMeta(threadId);
  if (!meta?.transcriptPath) {
    return { messages: [], title: meta?.title, titleSource: meta?.titleSource };
  }

  const { records } = await readCachedTranscript(meta.transcriptPath);
  const messages: NormalizedMessage[] = [];
  const toolPartsByCallId = new Map<
    string,
    { message: NormalizedMessage; partIndex: number }
  >();
  /**
   * Turn boundaries reconstructed from the rollout.
   *
   * `turn_context` records and the turn-scoped `event_msg` records both carry the
   * real Codex `turn_id`, and both precede the messages of their turn, so the
   * last id seen is the turn a message belongs to.
   *
   * This is what makes `turnId` durable. It used to be set in exactly one place —
   * on the user message of a prompt this process dispatched — so every message
   * lost it across a detach/re-attach or a bridge restart, and forking from a
   * message ("fork from here") silently became impossible.
   */
  let currentTurnId: string | undefined;
  let currentTurnModel: string | undefined;
  let currentAssistantMessage: NormalizedMessage | undefined;

  for (const record of records) {
    const recordTurnId = readTurnId(record.payload);
    if (recordTurnId && recordTurnId !== currentTurnId) {
      currentTurnId = recordTurnId;
      currentTurnModel = undefined;
      currentAssistantMessage = undefined;
    }
    if (record.type === "turn_context") {
      currentTurnModel = readTurnModel(record.payload) ?? currentTurnModel;
    }

    if (record.type !== "response_item" || !record.payload) {
      continue;
    }

    const payload = record.payload;
    const timestamp =
      typeof record.timestamp === "string"
        ? record.timestamp
        : new Date().toISOString();

    const ensureAssistantMessage = (): NormalizedMessage => {
      if (currentAssistantMessage) return currentAssistantMessage;
      currentAssistantMessage = {
        id: createMessageId(),
        role: "assistant",
        content: "",
        parts: [],
        createdAt: timestamp,
        ...(currentTurnModel ? { modelId: currentTurnModel } : {}),
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
      };
      messages.push(currentAssistantMessage);
      return currentAssistantMessage;
    };

    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const assistantMessage = ensureAssistantMessage();
      const part = createPersistedToolPart(payload);
      assistantMessage.parts.push(part);

      const callId = asNonEmptyString(payload.call_id);
      if (callId) {
        toolPartsByCallId.set(callId, {
          message: assistantMessage,
          partIndex: assistantMessage.parts.length - 1,
        });
      }
      continue;
    }

    if (
      payload.type === "function_call_output"
      || payload.type === "custom_tool_call_output"
    ) {
      const callId = asNonEmptyString(payload.call_id);
      // Consume the pairing: a `call_id` is unique to one call, so a second
      // output bearing it must not reach back and rewrite an earlier turn's part.
      const target = callId ? toolPartsByCallId.get(callId) : undefined;
      if (callId) toolPartsByCallId.delete(callId);
      if (target) {
        const existing = target.message.parts[target.partIndex]!;
        target.message.parts[target.partIndex] = applyTranscriptToolOutput(
          existing,
          payload.output,
          persistedOutputState(payload.type, existing),
        );
      }
      continue;
    }

    if (payload.type !== "message") {
      continue;
    }

    const role =
      payload.role === "assistant" || payload.role === "user"
        ? (payload.role as MessageRole)
        : null;
    if (!role) continue;

    const text = extractPersistedMessageText(payload.content, role);
    if (!text) continue;

    if (role === "assistant") {
      const assistantMessage = ensureAssistantMessage();
      assistantMessage.content = text;
      assistantMessage.parts.push({ type: "text", content: text });
      continue;
    }

    currentAssistantMessage = undefined;
    messages.push({
      id: createMessageId(),
      role,
      content: text,
      parts: [{ type: "text", content: text }],
      createdAt: timestamp,
      ...(currentTurnId ? { turnId: currentTurnId } : {}),
    });
  }

  return {
    messages,
    title: meta.title,
    titleSource: meta.titleSource,
  };
}

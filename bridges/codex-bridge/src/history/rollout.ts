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
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readCachedTranscript, readTranscriptHead } from "../transcript-cache.js";
import {
  buildFallbackSessionTitle,
  readPersistedSessionTitleEntries,
  type PersistedSessionTitleSource,
} from "../session-titles.js";
import { createMessageId, type MessageRole, type NormalizedMessage } from "../messages/types.js";

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

export async function findTranscriptPath(
  threadId: string,
  transcriptPaths?: readonly string[],
): Promise<string | null> {
  const paths = transcriptPaths ?? await listTranscriptPaths();
  return paths.find((file) => file.includes(threadId)) ?? null;
}

export async function readTranscriptLines(path: string): Promise<string[]> {
  return (await readCachedTranscript(path)).lines;
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
  let { records, truncated } = await readTranscriptHead(transcriptPath);
  let sessionMetaRecord = records.find((record) => record.type === "session_meta");

  // `session_meta` is normally the first record, so a miss means an unusually
  // large leading record rather than a malformed file. Pay for one full read in
  // that case instead of dropping the session from history.
  if (!sessionMetaRecord?.payload && truncated) {
    records = (await readCachedTranscript(transcriptPath)).records;
    sessionMetaRecord = records.find((record) => record.type === "session_meta");
  }

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
  transcriptPaths?: readonly string[],
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
    transcriptPaths: readonly string[],
  ) => Promise<PersistedSessionMeta | null> = (threadId, transcriptPaths) =>
    getPersistedSessionMeta(
      threadId,
      undefined,
      undefined,
      undefined,
      transcriptPaths,
    ),
): (threadId: string) => Promise<PersistedSessionMeta | null> {
  let transcriptPathsPromise: Promise<string[]> | undefined;
  return async (threadId) => {
    transcriptPathsPromise ??= loadPaths();
    return loadMeta(threadId, await transcriptPathsPromise);
  };
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

  const lines = await readTranscriptLines(meta.transcriptPath);
  const messages: NormalizedMessage[] = [];

  for (const line of lines) {
    let record: {
      timestamp?: unknown;
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        content?: unknown;
      };
    };

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type !== "response_item" || record.payload?.type !== "message") {
      continue;
    }

    const role =
      record.payload.role === "assistant" || record.payload.role === "user"
        ? (record.payload.role as MessageRole)
        : null;
    if (!role) continue;

    const text = extractPersistedMessageText(record.payload.content, role);
    if (!text) continue;

    messages.push({
      id: createMessageId(),
      role,
      content: text,
      parts: [{ type: "text", content: text }],
      createdAt:
        typeof record.timestamp === "string"
          ? record.timestamp
          : new Date().toISOString(),
    });
  }

  return {
    messages,
    title: meta.title,
    titleSource: meta.titleSource,
  };
}


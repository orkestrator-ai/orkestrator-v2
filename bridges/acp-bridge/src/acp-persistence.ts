import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { boundTranscriptResponse } from "@orkestrator/protocol/transcript-window";
import type { NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import {
  emptyComposerState,
  mergeComposerCatalog,
  normalizeAcpSessionConfig,
  parsePersistedAcpSessionConfig,
  parsePersistedComposerState,
  type AcpNormalizedSessionConfig,
} from "./session-config.js";
import { parseAcpTurnUsage, type AcpTurnUsage } from "./usage.js";
import {
  AcpProcess,
  MAX_MESSAGE_TEXT_BYTES,
  MAX_MESSAGES,
  MAX_PARTS_PER_MESSAGE,
  MAX_PROMPT_JOURNAL,
  MAX_PERSISTED_PROMPT_JOURNAL_BYTES,
  MAX_PERSISTED_SESSION_CONFIG_BYTES,
  MAX_PERSISTED_STRUCTURED_BYTES,
  MAX_SESSIONS,
  MAX_STATE_FILE_BYTES,
  MAX_STRUCTURED_RESULT_BYTES,
  MAX_STRUCTURED_RESULTS,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_DIFF_BYTES,
  MAX_TOOL_ID_BYTES,
  MAX_TOOL_INLINE_FILE_BYTES,
  MAX_TOOL_NAME_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_PATH_BYTES,
  MAX_TOOL_TITLE_BYTES,
  PERSISTED_WINDOW_METADATA_RESERVE_BYTES,
  RPC_TIMEOUT_MS,
  catalogCache,
  catalogProbe,
  clientSessionKeys,
  isObject,
  parseProvider,
  persistenceScheduled,
  persistenceTail,
  provider,
  rememberCatalog,
  setCatalogProbe,
  setPersistenceScheduled,
  setPersistenceTail,
  sessions,
  stateFile,
  workingDirectory,
  type BridgeFilePart,
  type BridgeMessage,
  type BridgeMessagePart,
  type BridgeTextPart,
  type BridgeToolDiff,
  type BridgeToolPart,
  type JsonObject,
  type PersistedSession,
  type PersistedState,
  type PersistedUsage,
  type PromptJournalEntry,
  type SessionState,
} from "./acp-context.js";
import {
  indexActiveSubagentsFromTranscript,
  boundedModelId,
  restoreCursorTodosFromMessages,
} from "./acp-tools.js";
import { reconcileStaleToolParts } from "./acp-reconciliation.js";
import {
  boundTranscript,
  boundedString,
  boundedToolArguments,
  truncateUtf8,
} from "./acp-transcript.js";

export async function listNormalizedModels(
  signal?: AbortSignal,
): Promise<NativeAgentComposerState["models"]> {
  const live = mergeComposerCatalog(provider, [
    ...(catalogCache ? [catalogCache] : []),
    ...[...sessions.values()].map((state) => state.sessionConfig.composer),
  ]);
  if (live.length > 0) return live;
  try {
    const probed = await probeCatalog(signal);
    return probed.models;
  } catch {
    return [];
  }
}

export async function probeCatalog(signal?: AbortSignal): Promise<NativeAgentComposerState> {
  if (catalogCache && catalogCache.models.length > 0) return catalogCache;
  if (catalogProbe) return catalogProbe;
  const operation = (async () => {
    const child = new AcpProcess();
    try {
      await child.initialize(signal);
      const created = await child.request(
        "session/new",
        { cwd: workingDirectory, additionalDirectories: [], mcpServers: [] },
        RPC_TIMEOUT_MS,
        signal,
      );
      const sessionConfig = normalizeAcpSessionConfig(provider, created);
      rememberCatalog(sessionConfig.composer);
      if (isObject(created) && typeof created.sessionId === "string") {
        child.notify("session/cancel", { sessionId: created.sessionId });
      }
      return sessionConfig.composer;
    } finally {
      await child.close();
      setCatalogProbe(null);
    }
  })();
  setCatalogProbe(operation);
  return operation;
}

/**
 * Composer configuration is a cache in front of the agent's own catalogue: the
 * next `session/load` re-normalizes it. Malformed configuration therefore
 * resets *that* session's composer and nothing else. Throwing here would take
 * out the whole state file — every other session's transcript and, worse, its
 * prompt journal, which is what keeps a resubmitted requestId from dispatching
 * twice.
 */
export function restoreSessionConfig(candidate: JsonObject): AcpNormalizedSessionConfig {
  if (candidate.sessionConfig !== undefined) {
    const restored = parsePersistedAcpSessionConfig(provider, candidate.sessionConfig);
    if (restored) return restored;
    console.warn("[acp-bridge] Resetting a malformed persisted session config");
    return emptySessionConfig();
  }
  if (candidate.composer !== undefined) {
    const composer = parsePersistedComposerState(provider, candidate.composer);
    if (composer) return { ...emptySessionConfig(), composer };
    console.warn("[acp-bridge] Resetting a malformed persisted composer state");
  }
  return emptySessionConfig();
}

/**
 * Re-validate persisted usage through the same parser that accepted it live, so
 * a hand-edited or truncated state file cannot put arbitrary numbers into the
 * panel. Anything unrecognised restores as "no usage reported yet".
 */
export function restorePersistedUsage(value: unknown): PersistedUsage | null {
  if (!isObject(value)) return null;
  const turn = parseAcpTurnUsage(value.turn);
  if (
    !turn ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return null;
  }
  return {
    turn,
    ...(typeof value.modelId === "string" ? { modelId: value.modelId.slice(0, 1_024) } : {}),
    ...(Number.isSafeInteger(value.durationMs) && Number(value.durationMs) >= 0
      ? { durationMs: Number(value.durationMs) }
      : {}),
    updatedAt: value.updatedAt,
  };
}

export function emptySessionConfig(): AcpNormalizedSessionConfig {
  // `emptyComposerState()` rather than a spread of the shared constant: a
  // shallow copy would alias its `models` and `modes` arrays across sessions.
  return {
    composer: emptyComposerState(),
    wire: { configOptions: [], availableModeIds: {}, usesSetModel: false },
  };
}

/**
 * Persisted state is a cache of transcripts, not a source of truth. Refusing to
 * start on a damaged file would be unrecoverable: only a running bridge ever
 * rewrites it, so the environment's bridge would fail on every subsequent start
 * until a human deleted the file. Quarantine it and start clean instead.
 */
export async function restorePersistedState(): Promise<void> {
  try {
    await loadPersistedState();
  } catch (error) {
    sessions.clear();
    clientSessionKeys.clear();
    console.warn(
      `[acp-bridge] Discarding unusable persisted state: ${error instanceof Error ? error.message : String(error)}`,
    );
    const file = stateFile;
    if (!file) return;
    await fs
      .rename(file, `${file}.corrupt-${process.pid}`)
      .catch(() => fs.rm(file, { force: true }).catch(() => undefined));
  }
}

export async function loadPersistedState(): Promise<void> {
  const file = stateFile;
  if (!file) return;
  let bytes: Buffer;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_STATE_FILE_BYTES) throw new Error("ACP persisted state is too large");
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("ACP persisted state is malformed");
  }
  if (
    !isObject(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
    parsed.provider !== provider ||
    !Array.isArray(parsed.sessions)
  ) {
    throw new Error("ACP persisted state is incompatible");
  }
  for (const candidate of parsed.sessions.slice(0, MAX_SESSIONS)) {
    if (
      !isObject(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.acpSessionId !== "string" ||
      !Array.isArray(candidate.messages)
    )
      continue;
    const messages = candidate.messages
      .flatMap((message) => {
        const normalized = normalizeBridgeMessage(message);
        return normalized ? [normalized] : [];
      })
      .slice(-MAX_MESSAGES);
    const usage = restorePersistedUsage(candidate.usage);
    // A session persisted by an older build's fatal transcript trim is healed
    // rather than restored. Trimming an interactive turn is no longer a
    // failure, `boundTranscript` below re-applies the bound to whatever was
    // persisted, and the status is otherwise unclearable: the tab renders it as
    // a connection failure whose only control reads the same state back.
    const healed =
      candidate.status === "error" &&
      typeof candidate.error === "string" &&
      candidate.error.endsWith("output exceeded the transcript limit");
    const state: SessionState = {
      id: candidate.id.slice(0, 128),
      ...(typeof candidate.clientSessionKey === "string"
        ? { clientSessionKey: candidate.clientSessionKey.slice(0, 512) }
        : {}),
      acpSessionId: candidate.acpSessionId.slice(0, 512),
      status: healed || candidate.status === "idle" ? "idle" : "error",
      ...(!healed && typeof candidate.error === "string"
        ? { error: candidate.error.slice(0, 4_000) }
        : {}),
      messages,
      activeSubagentToolIds: new Set(),
      activeSubagentDescriptors: new Map(),
      subagentLimitExceeded: candidate.subagentLimitExceeded === true,
      subagentToolIds: new Map(),
      cursorTodos: restoreCursorTodosFromMessages(messages),
      historyMessageIds: new Map(),
      child: null,
      revision: Number.isSafeInteger(candidate.revision) ? Number(candidate.revision) : 0,
      structured: new Map(
        Array.isArray(candidate.structured)
          ? candidate.structured
              .filter(
                (entry): entry is [string, unknown] =>
                  isStringTuple(entry) &&
                  Buffer.byteLength(JSON.stringify(entry[1])) <= MAX_STRUCTURED_RESULT_BYTES,
              )
              .slice(-MAX_STRUCTURED_RESULTS)
          : [],
      ),
      promptJournal: new Map(),
      approvals: new Map(),
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      currentTurnOutput: null,
      promptSequence: 0,
      droppedMessages:
        Number.isSafeInteger(candidate.droppedMessages) && Number(candidate.droppedMessages) >= 0
          ? Number(candidate.droppedMessages)
          : 0,
      droppedParts:
        Number.isSafeInteger(candidate.droppedParts) && Number(candidate.droppedParts) >= 0
          ? Number(candidate.droppedParts)
          : 0,
      transcriptTruncated:
        candidate.transcriptTruncated === true ||
        (Number.isSafeInteger(candidate.droppedMessages) &&
          Number(candidate.droppedMessages) > 0) ||
        (Number.isSafeInteger(candidate.droppedParts) && Number(candidate.droppedParts) > 0),
      sessionConfig: restoreSessionConfig(candidate),
      dispatching: false,
      historyReplay: false,
      ...(usage ? { usage } : {}),
      ...(Number.isSafeInteger(candidate.commandCount) && Number(candidate.commandCount) >= 0
        ? { commandCount: Number(candidate.commandCount) }
        : {}),
    };
    if (Array.isArray(candidate.promptJournal)) {
      for (const rawEntry of candidate.promptJournal.slice(-MAX_PROMPT_JOURNAL)) {
        if (!isObject(rawEntry) || typeof rawEntry.requestId !== "string") continue;
        const journalState = rawEntry.state;
        if (
          journalState !== "prepared" &&
          journalState !== "accepted" &&
          journalState !== "completed" &&
          journalState !== "failed" &&
          journalState !== "ambiguous"
        )
          continue;
        const entry: PromptJournalEntry = {
          requestId: rawEntry.requestId.slice(0, 512),
          state:
            journalState === "prepared" || journalState === "accepted" ? "ambiguous" : journalState,
          acceptedAt: Number.isSafeInteger(rawEntry.acceptedAt) ? Number(rawEntry.acceptedAt) : 0,
        };
        state.promptJournal.set(entry.requestId, entry);
      }
    }
    indexActiveSubagentsFromTranscript(state);
    boundTranscript(state);
    reconcileStaleToolParts(state, true);
    rememberCatalog(state.sessionConfig.composer);
    sessions.set(state.id, state);
    if (state.clientSessionKey) clientSessionKeys.set(state.clientSessionKey, state.id);
  }
}
export function normalizeBridgeMessage(value: unknown): BridgeMessage | null {
  if (
    !(
      isObject(value) &&
      typeof value.id === "string" &&
      (value.role === "user" || value.role === "assistant") &&
      typeof value.content === "string" &&
      Array.isArray(value.parts) &&
      typeof value.createdAt === "string"
    )
  )
    return null;
  const messageId = value.id.slice(0, 256);
  const modelId = boundedModelId(value.modelId);
  return {
    id: messageId,
    role: value.role,
    content: truncateUtf8(value.content, MAX_MESSAGE_TEXT_BYTES),
    parts: value.parts.slice(-MAX_PARTS_PER_MESSAGE).flatMap((part, index) => {
      const normalized = normalizeBridgePart(part, index, messageId);
      return normalized ? [normalized] : [];
    }),
    createdAt: value.createdAt.slice(0, 64),
    ...(modelId ? { modelId } : {}),
  };
}

export function normalizeBridgePart(
  value: unknown,
  index: number,
  messageId: string,
): BridgeMessagePart | null {
  if (!isObject(value)) return null;
  const sourcePartId =
    typeof value.sourcePartId === "string"
      ? value.sourcePartId.slice(0, 1024)
      : `${messageId}:${index}`;
  const sourceMessageId =
    typeof value.sourceMessageId === "string" ? value.sourceMessageId.slice(0, 256) : messageId;
  const createdAt =
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
      ? value.createdAt.slice(0, 64)
      : undefined;

  if (value.type === "text" || value.type === "reasoning" || value.type === "thinking") {
    const content =
      typeof value.content === "string"
        ? value.content
        : typeof value.text === "string"
          ? value.text
          : undefined;
    if (content === undefined) return null;
    const parentTaskUseId = boundedString(value.parentTaskUseId, MAX_TOOL_ID_BYTES)?.trim();
    return {
      type: value.type === "reasoning" ? "thinking" : value.type,
      content: truncateUtf8(content, MAX_MESSAGE_TEXT_BYTES),
      sourcePartId,
      sourceMessageId,
      ...(createdAt ? { createdAt } : {}),
      ...(parentTaskUseId ? { parentTaskUseId } : {}),
    };
  }

  if (value.type === "file") {
    const content = boundedString(value.content, MAX_TOOL_PATH_BYTES);
    if (!content) return null;
    const fileUrl = boundedString(value.fileUrl, MAX_TOOL_PATH_BYTES);
    return {
      type: "file",
      content,
      ...(fileUrl ? { fileUrl } : {}),
      sourcePartId,
      sourceMessageId,
      ...(createdAt ? { createdAt } : {}),
    };
  }

  if (value.type !== "tool-invocation" || typeof value.toolUseId !== "string") return null;
  const toolUseId = truncateUtf8(value.toolUseId, MAX_TOOL_ID_BYTES);
  if (!toolUseId) return null;
  const toolState =
    value.toolState === "success" || value.toolState === "failure" || value.toolState === "pending"
      ? value.toolState
      : undefined;
  const agentState =
    value.agentState === "active" ||
    value.agentState === "finished" ||
    value.agentState === "failed"
      ? value.agentState
      : undefined;
  const toolOutput = boundedString(value.toolOutput, MAX_TOOL_OUTPUT_BYTES);
  const toolError = boundedString(value.toolError, MAX_TOOL_OUTPUT_BYTES);
  const toolDiff = normalizeBridgeToolDiff(value.toolDiff);
  const toolName = boundedString(value.toolName, MAX_TOOL_NAME_BYTES);
  const toolTitle = boundedString(value.toolTitle, MAX_TOOL_TITLE_BYTES);
  const parentTaskUseId = boundedString(value.parentTaskUseId, MAX_TOOL_ID_BYTES)?.trim();
  return {
    type: "tool-invocation",
    content: boundedString(value.content, MAX_TOOL_TITLE_BYTES) ?? "Tool call",
    sourcePartId,
    sourceMessageId,
    toolUseId,
    ...(toolName ? { toolName } : {}),
    ...(isObject(value.toolArgs) ? { toolArgs: boundedToolArguments(value.toolArgs) } : {}),
    ...(toolState ? { toolState } : {}),
    ...(agentState ? { agentState } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(toolOutput !== undefined ? { toolOutput } : {}),
    ...(toolError !== undefined ? { toolError } : {}),
    ...(toolDiff ? { toolDiff } : {}),
    ...(parentTaskUseId ? { parentTaskUseId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function normalizeBridgeToolDiff(value: unknown): BridgeToolDiff | undefined {
  if (!isObject(value)) return undefined;
  const filePath = boundedString(value.filePath, MAX_TOOL_PATH_BYTES);
  const rawBefore = typeof value.before === "string" ? value.before : undefined;
  const rawAfter = typeof value.after === "string" ? value.after : undefined;
  const keepInline =
    Buffer.byteLength(rawBefore ?? "") <= MAX_TOOL_INLINE_FILE_BYTES &&
    Buffer.byteLength(rawAfter ?? "") <= MAX_TOOL_INLINE_FILE_BYTES;
  const before = keepInline ? rawBefore : undefined;
  const after = keepInline ? rawAfter : undefined;
  const additions =
    Number.isSafeInteger(value.additions) && Number(value.additions) >= 0
      ? Number(value.additions)
      : undefined;
  const deletions =
    Number.isSafeInteger(value.deletions) && Number(value.deletions) >= 0
      ? Number(value.deletions)
      : undefined;
  const diff = boundedString(value.diff, MAX_TOOL_DIFF_BYTES);
  if (
    !filePath &&
    additions === undefined &&
    deletions === undefined &&
    before === undefined &&
    after === undefined &&
    diff === undefined
  )
    return undefined;
  return {
    ...(filePath ? { filePath } : {}),
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(keepInline && diff === undefined && before !== undefined ? { before } : {}),
    ...(keepInline && diff === undefined && after !== undefined ? { after } : {}),
    ...(diff !== undefined ? { diff } : {}),
  };
}

export function isStringTuple(value: unknown): value is [string, unknown] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string";
}

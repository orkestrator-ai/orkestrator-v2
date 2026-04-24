import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import {
  Codex,
  type Input,
  type ModelReasoningEffort,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type UserInput,
} from "@openai/codex-sdk";
import { summarizeTodoList, mapTodoArgs } from "./todo-helpers.js";
import {
  mergeSubagentPartsIntoMessageParts,
  type TranscriptSubagentPart,
} from "./subagent-transcript.js";
import { deriveTranscriptSubagentPartsForTurn } from "./subagent-transcript-parts.js";
import { readCachedTranscript } from "./transcript-cache.js";
import {
  DEFAULT_REASONING_EFFORT,
  MODEL_REASONING_EFFORTS,
  ModelCatalogCache,
  REASONING_DESCRIPTIONS,
  REASONING_LABELS,
  normalizeReasoningOptions,
  parseModelCatalog,
  type BridgeModel,
} from "./models-cache.js";

type ToolState = "success" | "failure" | "pending";
type MessageRole = "user" | "assistant" | "system";

export interface NormalizedPart {
  type: "text" | "thinking" | "tool-invocation" | "tool-result" | "file" | "subagent";
  content: string;
  fileUrl?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: ToolState;
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: ToolDiffMetadata;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentPrompt?: string;
  subagentActions?: NormalizedPart[];
  subagentActionCount?: number;
}

interface NormalizedMessage {
  id: string;
  role: MessageRole;
  content: string;
  parts: NormalizedPart[];
  createdAt: string;
}

interface SessionState {
  id: string;
  title?: string;
  conversationMode: ConversationMode;
  fastMode: boolean;
  thread: Thread;
  threadOptions: ThreadOptions;
  threadId?: string | null;
  messages: NormalizedMessage[];
  status: "idle" | "running" | "error";
  error?: string;
  abortController?: AbortController;
  currentAssistantMessageId?: string;
  currentItems: Map<string, ThreadItem>;
  currentItemOrder: string[];
  currentTurnStartedAt?: string;
  pendingAttachments: PromptAttachmentInput[];
  lastAccessed: number;
}

interface SseEvent {
  type:
    | "session.updated"
    | "session.idle"
    | "session.error"
    | "session.title-updated"
    | "message.updated";
  sessionId?: string;
  data?: Record<string, unknown>;
}

interface BridgeSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  source: "prompt" | "builtin";
}

interface PersistedSessionIndexEntry {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
}

interface PersistedSessionMeta {
  id: string;
  title?: string;
  updatedAt: string;
  cwd?: string;
  transcriptPath?: string;
}

interface TranscriptCatalog {
  metas: PersistedSessionMeta[];
  metaByPath: Map<string, PersistedSessionMeta>;
  transcriptPathByThreadId: Map<string, string>;
}

interface SessionStatusResponse {
  status: SessionState["status"];
  title?: string;
  error?: string;
}

export interface ToolDiffMetadata {
  filePath?: string;
  additions?: number;
  deletions?: number;
  before?: string;
  after?: string;
  diff?: string;
}

interface PromptAttachmentInput {
  type: "image";
  path: string;
  dataUrl?: string;
  filename?: string;
}

interface PromptSlashCommand extends BridgeSlashCommand {
  source: "prompt";
  path: string;
  template: string;
}

interface BuiltinSlashCommand extends BridgeSlashCommand {
  source: "builtin";
}

type SlashCommandDefinition = PromptSlashCommand | BuiltinSlashCommand;
type ConversationMode = "build" | "plan";

const app = new Hono();
const codexPathOverride = process.env.CODEX_PATH || "codex";
const codex = new Codex({ codexPathOverride });
// Fast-mode variant: passes `--config service_tier=fast` to the Codex CLI,
// which enables the ~1.5x-faster service tier (higher credit rate).
// See https://developers.openai.com/codex/speed
const codexFast = new Codex({
  codexPathOverride,
  config: { service_tier: "fast" },
});
function getCodex(fastMode: boolean): Codex {
  return fastMode ? codexFast : codex;
}
function resolveFastMode(body: Record<string, unknown>): boolean {
  return body.fastMode === true;
}
const execFile = promisify(execFileCallback);
const sessions = new Map<string, SessionState>();
const subscribers = new Set<(event: SseEvent) => void>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const codexRawLogDir = normalizeOptionalEnvPath("ORKESTRATOR_CODEX_RAW_LOG_DIR");

function normalizeOptionalEnvPath(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function sanitizeLogFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeLogPayload(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return stringifyUnknown(value);
  }
}

async function writeCodexRawLog(
  sessionId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  if (!codexRawLogDir) {
    return;
  }

  try {
    await mkdir(codexRawLogDir, { recursive: true });
    const filename = `${sanitizeLogFileComponent(sessionId)}.jsonl`;
    await appendFile(
      join(codexRawLogDir, filename),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId,
        ...entry,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("[codex-bridge] Failed to write raw Codex log:", error);
  }
}

function updateSessionAccess(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastAccessed = Date.now();
  }
}

function cleanupIdleSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (
      session.status === "idle"
      && now - session.lastAccessed > SESSION_TIMEOUT_MS
    ) {
      sessions.delete(sessionId);
    }
  }
}

const cleanupTimer = setInterval(cleanupIdleSessions, CLEANUP_INTERVAL_MS);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    clearInterval(cleanupTimer);
    process.exit(0);
  });
}

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  {
    name: "/help",
    description: "Show available Codex slash commands in native mode.",
    source: "builtin",
  },
  {
    name: "/models",
    description: "List available Codex models and current selection.",
    source: "builtin",
  },
];
const FALLBACK_MODELS: BridgeModel[] = [
  {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    description: "Latest frontier agentic coding model.",
    reasoningEfforts: ["medium", "high"],
    reasoningOptions: [
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
    ],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4",
    name: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    reasoningEfforts: ["medium", "high"],
    reasoningOptions: [
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
    ],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2-codex",
    name: "gpt-5.2-codex",
    description: "Frontier agentic coding model.",
    reasoningEfforts: ["medium", "high"],
    reasoningOptions: [
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
    ],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.1-codex-max",
    name: "gpt-5.1-codex-max",
    description: "Codex-optimized flagship for deep and fast reasoning.",
    reasoningEfforts: ["medium", "high"],
    reasoningOptions: [
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
    ],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.2",
    name: "gpt-5.2",
    description: "Latest frontier model with improvements across knowledge, reasoning and coding.",
    reasoningEfforts: ["medium", "high"],
    reasoningOptions: [
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
    ],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "gpt-5.1-codex-mini",
    description: "Optimized for codex. Cheaper, faster, but less capable.",
    reasoningEfforts: ["medium", "high"],
    reasoningOptions: [
      {
        effort: "medium",
        label: REASONING_LABELS.medium,
        description: REASONING_DESCRIPTIONS.medium,
      },
      {
        effort: "high",
        label: REASONING_LABELS.high,
        description: REASONING_DESCRIPTIONS.high,
      },
    ],
    defaultReasoningEffort: "medium",
  },
];

function emit(event: SseEvent): void {
  for (const subscriber of subscribers) {
    subscriber(event);
  }
}

function createSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}

function createMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

function buildSessionTitle(prompt: string): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length > 0 ? words.join(" ") : "Codex";
}

function resolveConversationMode(body: Record<string, unknown>): ConversationMode {
  return body.mode === "plan" || body.mode === "build"
    ? (body.mode as ConversationMode)
    : "build";
}

// NOTE: This is a soft hint prepended to the user message, not a true system
// prompt.  The model may not enforce it perfectly and a determined user could
// override it.  This is acceptable because plan mode is a UX convenience, not
// a security boundary.
function wrapPromptForConversationMode(
  prompt: string,
  mode: ConversationMode,
): string {
  if (mode !== "plan") {
    return prompt;
  }

  const preamble = [
    "<system-reminder>",
    "You are in Orkestrator plan mode.",
    "This turn is planning-only. The user expects analysis, a concrete plan, and optional diffs before any implementation.",
    "Treat the current session as consultative and read-only.",
    "Do not claim to have made changes, completed implementation, or written files.",
    "Do not attempt mutating commands or filesystem writes.",
    "Inspect the codebase as needed, then produce:",
    "1. a concise implementation plan,",
    "2. important risks or open questions,",
    "3. exact diffs or patch snippets when useful.",
    "If the user approves the plan later, they will switch you back to build mode in a later turn.",
    "</system-reminder>",
  ].join("\n");

  return `${preamble}\n\n${prompt}`;
}

function buildPromptInput(
  prompt: string,
  attachments: PromptAttachmentInput[],
): Input {
  if (attachments.length === 0) {
    return prompt;
  }

  const input: UserInput[] = [];
  if (prompt.length > 0) {
    input.push({ type: "text", text: prompt });
  }

  for (const attachment of attachments) {
    input.push({
      type: "local_image",
      path: attachment.path,
    });
  }

  return input;
}

function createUserMessage(
  prompt: string,
  attachments: PromptAttachmentInput[] = [],
): NormalizedMessage {
  const parts: NormalizedPart[] = [];

  if (prompt.length > 0) {
    parts.push({ type: "text", content: prompt });
  }

  for (const attachment of attachments) {
    parts.push({
      type: "file",
      content: attachment.filename || attachment.path,
      fileUrl: attachment.dataUrl || `file://${attachment.path}`,
    });
  }

  return {
    id: createMessageId(),
    role: "user",
    content: prompt,
    parts,
    createdAt: new Date().toISOString(),
  };
}

function createAssistantMessage(): NormalizedMessage {
  return {
    id: createMessageId(),
    role: "assistant",
    content: "",
    parts: [],
    createdAt: new Date().toISOString(),
  };
}

export function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getCodexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function getWorkingDirectory(explicitCwd?: string): string {
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

async function findTranscriptPath(threadId: string): Promise<string | null> {
  const searchRoots = [
    join(getCodexHomeDir(), "sessions"),
    join(getCodexHomeDir(), "archived_sessions"),
  ];

  for (const root of searchRoots) {
    const files = await walkJsonlFiles(root);
    const match = files.find((file) => file.includes(threadId));
    if (match) {
      return match;
    }
  }

  return null;
}

async function readTranscriptLines(path: string): Promise<string[]> {
  return (await readCachedTranscript(path)).lines;
}

async function getSessionMetaFromTranscriptPath(
  transcriptPath: string,
  fallbackTitle?: string,
  fallbackUpdatedAt?: string,
): Promise<PersistedSessionMeta | null> {
  const { records } = await readCachedTranscript(transcriptPath);
  const sessionMetaRecord = records.find((record) => record.type === "session_meta");

  if (!sessionMetaRecord?.payload) {
    return null;
  }

  try {
    const payload = sessionMetaRecord.payload;
    const id =
      typeof payload.id === "string" && payload.id.length > 0
        ? payload.id
        : null;

    if (!id) {
      return null;
    }

    return {
      id,
      title: fallbackTitle,
      updatedAt:
        typeof payload.timestamp === "string"
          ? payload.timestamp
          : (fallbackUpdatedAt ?? new Date().toISOString()),
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      transcriptPath,
    };
  } catch {
    return null;
  }
}

async function buildTranscriptCatalog(): Promise<TranscriptCatalog> {
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

async function getPersistedSessionMeta(
  threadId: string,
  fallbackTitle?: string,
  fallbackUpdatedAt?: string,
  transcriptCatalog?: TranscriptCatalog,
): Promise<PersistedSessionMeta | null> {
  const transcriptPath = transcriptCatalog
    ? transcriptCatalog.transcriptPathByThreadId.get(threadId) ??
      transcriptCatalog.metas.find((meta) => meta.transcriptPath?.includes(threadId))
        ?.transcriptPath ??
      null
    : await findTranscriptPath(threadId);
  if (!transcriptPath) {
    return fallbackUpdatedAt
      ? {
          id: threadId,
          title: fallbackTitle,
          updatedAt: fallbackUpdatedAt,
        }
      : null;
  }

  const cachedMeta = transcriptCatalog?.metaByPath.get(transcriptPath);
  const meta = cachedMeta
    ? {
        ...cachedMeta,
        title: cachedMeta.title ?? fallbackTitle,
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
      updatedAt: fallbackUpdatedAt || new Date().toISOString(),
      transcriptPath,
    };
  }

  if (meta.id !== threadId) {
    meta.id = threadId;
  }

  if (!meta.title && fallbackTitle) {
    meta.title = fallbackTitle;
  }

  return meta;
}

async function listPersistedSessionsForCwd(cwd: string): Promise<PersistedSessionMeta[]> {
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

    const indexed = sessions.get(meta.id);
    if (!indexed) {
      sessions.set(meta.id, { ...meta });
      continue;
    }

    if (!indexed.transcriptPath) {
      indexed.transcriptPath = meta.transcriptPath;
    }
    if (!indexed.cwd && meta.cwd) {
      indexed.cwd = meta.cwd;
    }
    if (!indexed.title && meta.title) {
      indexed.title = meta.title;
    }
    if (
      new Date(meta.updatedAt).getTime() > new Date(indexed.updatedAt).getTime()
    ) {
      indexed.updatedAt = meta.updatedAt;
    }
  }

  return Array.from(sessions.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function shouldSkipHydratedUserText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("# AGENTS.md instructions for ");
}

function extractPersistedMessageText(
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

  if (role === "user" && shouldSkipHydratedUserText(text)) {
    return null;
  }

  return text;
}

async function hydrateMessagesFromPersistedSession(
  threadId: string,
): Promise<{ messages: NormalizedMessage[]; title?: string }> {
  const meta = await getPersistedSessionMeta(threadId);
  if (!meta?.transcriptPath) {
    return { messages: [], title: meta?.title };
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
  };
}

function normalizeSlashCommandName(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseSlashCommandPrompt(prompt: string): { name: string; args: string } | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) {
    return null;
  }

  const firstSpaceIndex = trimmed.indexOf(" ");
  const rawName = firstSpaceIndex === -1 ? trimmed : trimmed.slice(0, firstSpaceIndex);
  const args = firstSpaceIndex === -1 ? "" : trimmed.slice(firstSpaceIndex + 1).trim();
  const name = normalizeSlashCommandName(rawName);

  return name ? { name, args } : null;
}

function extractFrontmatter(content: string): { body: string; fields: Record<string, string> } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { body: content, fields: {} };
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      fields[key] = value;
    }
  }

  return { body: content.slice(match[0].length), fields };
}

function summarizePromptTemplate(content: string): string | undefined {
  const taskSectionMatch = content.match(/##\s+Your Task\s*\n+([\s\S]+)/i);
  const candidateBlock = taskSectionMatch ? taskSectionMatch[1] : content;
  const line = candidateBlock
    .split("\n")
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry.length > 0
        && !entry.startsWith("#")
        && !entry.startsWith("- Current")
        && !entry.includes("$ARGUMENTS"),
    );

  return line ? line.replace(/\s+/g, " ").trim() : undefined;
}

async function collectPromptSlashCommandsFromDir(
  rootDir: string,
): Promise<PromptSlashCommand[]> {
  async function walk(dir: string): Promise<PromptSlashCommand[]> {
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const commands: PromptSlashCommand[] = [];
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        commands.push(...await walk(absolutePath));
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }

      const rawTemplate = await readFile(absolutePath, "utf8").catch(() => null);
      if (!rawTemplate) continue;

      const { body, fields } = extractFrontmatter(rawTemplate);
      const relativePath = relative(rootDir, absolutePath)
        .replace(/\.md$/i, "")
        .split(sep)
        .join("/");
      const name = normalizeSlashCommandName(relativePath);

      if (!name) continue;

      commands.push({
        name,
        description:
          fields.description
          || fields.short_description
          || summarizePromptTemplate(body)
          || `Run ${basename(relativePath)} prompt`,
        argumentHint: fields.argument_hint || fields.arguments || undefined,
        source: "prompt",
        path: absolutePath,
        template: body,
      });
    }

    return commands;
  }

  return walk(rootDir);
}

async function getAvailableSlashCommandDefinitions(
  cwd: string,
): Promise<SlashCommandDefinition[]> {
  const commandMap = new Map<string, SlashCommandDefinition>();
  const promptDirs = [
    join(cwd, ".codex", "prompts"),
    join(getCodexHomeDir(), "prompts"),
  ];

  for (const promptDir of promptDirs) {
    const commands = await collectPromptSlashCommandsFromDir(promptDir);
    for (const command of commands) {
      const key = command.name.toLowerCase();
      if (!commandMap.has(key)) {
        commandMap.set(key, command);
      }
    }
  }

  for (const command of BUILTIN_SLASH_COMMANDS) {
    const key = command.name.toLowerCase();
    if (!commandMap.has(key)) {
      commandMap.set(key, command);
    }
  }

  return Array.from(commandMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function serializeSlashCommand(command: SlashCommandDefinition): BridgeSlashCommand {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    source: command.source,
  };
}

async function runInlinePromptCommand(command: string, cwd: string): Promise<string> {
  const shell = process.env.SHELL || "/bin/zsh";

  try {
    const { stdout, stderr } = await execFile(shell, ["-lc", command], {
      cwd,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = stdout.trimEnd() || stderr.trimEnd();
    return output.length > 0 ? output : "(no output)";
  } catch (error) {
    const stdout =
      typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    const message =
      stdout.trimEnd()
      || stderr.trimEnd()
      || (error instanceof Error ? error.message : "Command failed");
    return message;
  }
}

async function expandPromptTemplate(
  template: string,
  args: string,
  cwd: string,
): Promise<string> {
  const withArguments = template.replaceAll("$ARGUMENTS", args);
  const matches = Array.from(withArguments.matchAll(/!`([^`]+)`/g));
  if (matches.length === 0) {
    return withArguments;
  }

  let expanded = "";
  let cursor = 0;

  for (const match of matches) {
    const [fullMatch, command = ""] = match;
    const startIndex = match.index ?? cursor;
    expanded += withArguments.slice(cursor, startIndex);
    expanded += await runInlinePromptCommand(command, cwd);
    cursor = startIndex + fullMatch.length;
  }

  expanded += withArguments.slice(cursor);
  return expanded;
}

function createAssistantTextMessage(content: string): NormalizedMessage {
  return {
    id: createMessageId(),
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: new Date().toISOString(),
  };
}

function emitLocalAssistantResponse(
  session: SessionState,
  prompt: string,
  response: string,
): void {
  session.status = "idle";
  session.error = undefined;
  session.currentItems.clear();
  session.currentItemOrder = [];
  session.currentTurnStartedAt = undefined;
  session.abortController = undefined;
  session.currentAssistantMessageId = undefined;

  session.messages.push(createUserMessage(prompt));
  session.messages.push(createAssistantTextMessage(response));

  if (!session.title) {
    session.title = buildSessionTitle(prompt);
    emit({
      type: "session.title-updated",
      sessionId: session.id,
      data: { title: session.title },
    });
  }

  emit({ type: "message.updated", sessionId: session.id });
  emit({ type: "session.updated", sessionId: session.id });
  emit({
    type: "session.idle",
    sessionId: session.id,
    data: { title: session.title },
  });
}

// Persisted model catalog cache lives in the Orkestrator-owned subdirectory of
// the Codex home so it survives bridge restarts without colliding with the
// CLI's own `models_cache.json`.
function bridgeCacheDir(): string {
  return join(getCodexHomeDir(), "orkestrator-bridge");
}

function bridgeCachePath(): string {
  return join(bridgeCacheDir(), "models-cache.json");
}

async function readPersistedBridgeCache(): Promise<BridgeModel[] | null> {
  try {
    const raw = await readFile(bridgeCachePath(), "utf8");
    const parsed = JSON.parse(raw) as { models?: BridgeModel[] };
    return Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed.models : null;
  } catch {
    return null;
  }
}

async function writePersistedBridgeCache(models: BridgeModel[]): Promise<void> {
  try {
    await mkdir(bridgeCacheDir(), { recursive: true });
    await writeFile(
      bridgeCachePath(),
      JSON.stringify({ at: Date.now(), models }, null, 2),
    );
  } catch (error) {
    console.warn(
      "[codex-bridge] Failed to persist model cache:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function readCodexCliModelCache(): Promise<BridgeModel[] | null> {
  try {
    const raw = await readFile(join(getCodexHomeDir(), "models_cache.json"), "utf8");
    const models = parseModelCatalog(raw);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

async function fetchLiveModelsFromCli(): Promise<BridgeModel[] | null> {
  const codexPath = process.env.CODEX_PATH || "codex";
  try {
    // Background-only path — the generous timeout is safe because this never
    // blocks a response to the client (see ModelCatalogCache).
    const { stdout } = await execFile(codexPath, ["debug", "models"], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    const models = parseModelCatalog(stdout);
    return models.length > 0 ? models : null;
  } catch (error) {
    console.warn(
      "[codex-bridge] `codex debug models` failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const modelCatalogCache = new ModelCatalogCache({
  fetchFromCli: fetchLiveModelsFromCli,
  readPersistedCache: readPersistedBridgeCache,
  writePersistedCache: writePersistedBridgeCache,
  readCodexCliCache: readCodexCliModelCache,
  fallback: FALLBACK_MODELS,
});

async function getAvailableModels(): Promise<{ models: BridgeModel[]; source: "cache" | "fallback" }> {
  return modelCatalogCache.get();
}

function buildThreadOptions(body: Record<string, unknown>): ThreadOptions {
  const mode = resolveConversationMode(body);
  const model =
    typeof body.model === "string" && body.model.trim().length > 0
      ? body.model.trim()
      : undefined;
  const modelReasoningEffort =
    typeof body.modelReasoningEffort === "string"
    && MODEL_REASONING_EFFORTS.has(body.modelReasoningEffort as ModelReasoningEffort)
      ? (body.modelReasoningEffort as ModelReasoningEffort)
      : undefined;

  return {
    workingDirectory: process.env.CWD || process.cwd(),
    approvalPolicy: "never",
    sandboxMode: mode === "plan" ? "read-only" : "danger-full-access",
    networkAccessEnabled: true,
    model,
    modelReasoningEffort,
  };
}

async function readTextFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function runGitCommand(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = stdout.trimEnd();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

async function getFileChangeDiffMetadata(
  cwd: string,
  change: Extract<ThreadItem, { type: "file_change" }>["changes"][number],
): Promise<ToolDiffMetadata> {
  const resolvedPath = isAbsolute(change.path) ? change.path : join(cwd, change.path);
  const relativePath = isAbsolute(change.path) ? relative(cwd, change.path) : change.path;
  const gitDiff = await runGitCommand(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--unified=3",
    "--",
    relativePath,
  ]);

  if (gitDiff) {
    const { additions, deletions } = countDiffLines(gitDiff);
    return {
      filePath: resolvedPath,
      diff: gitDiff,
      additions,
      deletions,
    };
  }

  if (change.kind === "add") {
    const after = await readTextFileIfPresent(resolvedPath);
    return {
      filePath: resolvedPath,
      after,
      additions: after ? after.split("\n").length : undefined,
      deletions: 0,
    };
  }

  if (change.kind === "delete") {
    const before = await runGitCommand(cwd, ["show", `HEAD:${relativePath}`]);
    return {
      filePath: resolvedPath,
      before,
      additions: 0,
      deletions: before ? before.split("\n").length : undefined,
    };
  }

  const after = await readTextFileIfPresent(resolvedPath);
  return {
    filePath: resolvedPath,
    after,
    additions: after ? after.split("\n").length : undefined,
  };
}

export async function itemToParts(
  item: ThreadItem,
  cwd: string,
): Promise<NormalizedPart[]> {
  switch (item.type) {
    case "agent_message":
      return [{ type: "text", content: item.text }];
    case "reasoning":
      return [{ type: "thinking", content: item.text }];
    case "command_execution":
      return [{
        type: "tool-invocation",
        content: item.command,
        toolName: "bash",
        toolArgs: { command: item.command },
        toolState:
          item.status === "failed"
            ? "failure"
            : item.status === "completed"
              ? "success"
              : "pending",
        toolTitle: item.command,
        toolOutput: item.aggregated_output || undefined,
        toolError: item.status === "failed" ? item.aggregated_output || "Command failed" : undefined,
      }];
    case "file_change":
      return Promise.all(
        item.changes.map(async (change) => ({
          type: "tool-invocation" as const,
          content: change.path,
          toolName: "apply_patch",
          toolState: item.status === "failed" ? "failure" : "success",
          toolTitle: `${change.kind}: ${change.path}`,
          toolOutput: `${change.kind}: ${change.path}`,
          toolDiff: await getFileChangeDiffMetadata(cwd, change),
        })),
      );
    case "mcp_tool_call":
      return [{
        type: "tool-invocation",
        content: item.tool,
        toolName: item.tool,
        toolArgs: (item.arguments ?? {}) as Record<string, unknown>,
        toolState:
          item.status === "failed"
            ? "failure"
            : item.status === "completed"
              ? "success"
              : "pending",
        toolTitle: `${item.server}:${item.tool}`,
        toolOutput: stringifyUnknown(item.result),
        toolError: item.error?.message,
      }];
    case "web_search":
      return [{
        type: "tool-invocation",
        content: item.query,
        toolName: "web_search",
        toolArgs: { query: item.query },
        toolState: "success",
        toolTitle: item.query,
      }];
    case "todo_list":
      return [{
        type: "tool-invocation",
        content: summarizeTodoList(item.items),
        toolName: "todo_list",
        toolState: "success",
        toolTitle: "Todo List",
        toolArgs: mapTodoArgs(item.items),
        toolOutput: summarizeTodoList(item.items),
      }];
    case "error":
      return [{
        type: "tool-result",
        content: item.message,
        toolName: "error",
        toolState: "failure",
        toolError: item.message,
      }];
    default:
      return [];
  }
}

async function buildTranscriptSubagentParts(
  session: SessionState,
): Promise<NormalizedPart[]> {
  const transcriptParts = await deriveTranscriptSubagentPartsForTurn({
    threadId: session.threadId,
    currentTurnStartedAt: session.currentTurnStartedAt,
    loadSessionMeta: (threadId) => getPersistedSessionMeta(threadId),
    loadTranscript: (path) => readCachedTranscript(path),
  });

  return transcriptParts.map((part: TranscriptSubagentPart) => ({
    type: "subagent",
    content: part.content,
    toolState: part.toolState,
    subagentId: part.subagentId,
    subagentName: part.subagentName,
    subagentRole: part.subagentRole,
    subagentPrompt: part.subagentPrompt,
    subagentActions: part.subagentActions as NormalizedPart[],
    subagentActionCount: part.subagentActionCount,
  }));
}

async function rebuildAssistantMessage(session: SessionState): Promise<void> {
  const messageId = session.currentAssistantMessageId;
  if (!messageId) return;
  const message = session.messages.find((entry) => entry.id === messageId);
  if (!message) return;
  const cwd = getWorkingDirectory(session.threadOptions.workingDirectory);

  const items = session.currentItemOrder
    .map((id) => session.currentItems.get(id))
    .filter((item): item is ThreadItem => item !== undefined);

  const parts = (await Promise.all(
    items.map((item) => itemToParts(item, cwd)),
  )).flat();
  const subagentParts = await buildTranscriptSubagentParts(session);

  const finalResponse = items
    .filter((item): item is Extract<ThreadItem, { type: "agent_message" }> => item.type === "agent_message")
    .at(-1)?.text ?? "";

  message.parts = mergeSubagentPartsIntoMessageParts(parts, subagentParts);
  message.content = finalResponse || parts.find((part) => part.type === "text")?.content || "";
}

async function buildSlashHelpText(cwd: string): Promise<string> {
  const commands = await getAvailableSlashCommandDefinitions(cwd);
  const promptCommands = commands.filter(
    (command): command is PromptSlashCommand => command.source === "prompt",
  );
  const builtinCommands = commands.filter(
    (command): command is BuiltinSlashCommand => command.source === "builtin",
  );

  const sections: string[] = ["Available Codex slash commands:"];

  if (builtinCommands.length > 0) {
    sections.push("");
    sections.push("Built in:");
    for (const command of builtinCommands) {
      sections.push(`- ${command.name}${command.description ? `: ${command.description}` : ""}`);
    }
  }

  if (promptCommands.length > 0) {
    sections.push("");
    sections.push("Prompt commands:");
    for (const command of promptCommands) {
      const suffix = command.argumentHint ? ` ${command.argumentHint}` : "";
      sections.push(
        `- ${command.name}${suffix}${command.description ? `: ${command.description}` : ""}`,
      );
    }
  }

  if (promptCommands.length === 0) {
    sections.push("");
    sections.push("No Codex prompt commands were discovered in this environment.");
  }

  return sections.join("\n");
}

async function buildModelsText(session: SessionState): Promise<string> {
  const { models } = await getAvailableModels();
  const currentModel = session.threadOptions.model || models[0]?.id || "UNCONFIRMED";

  return [
    "Available Codex models:",
    ...models.map((model) =>
      `- ${model.id}${model.id === currentModel ? " (current)" : ""}${model.description ? `: ${model.description}` : ""}`,
    ),
  ].join("\n");
}

async function resolvePromptExecution(
  session: SessionState,
  prompt: string,
  cwd: string,
): Promise<
  | { kind: "prompt"; expandedPrompt: string }
  | { kind: "builtin"; response: string }
  | null
> {
  const parsed = parseSlashCommandPrompt(prompt);
  if (!parsed) {
    return null;
  }

  if (parsed.name === "/help") {
    return {
      kind: "builtin",
      response: await buildSlashHelpText(cwd),
    };
  }

  if (parsed.name === "/models") {
    return {
      kind: "builtin",
      response: await buildModelsText(session),
    };
  }

  const commands = await getAvailableSlashCommandDefinitions(cwd);
  const promptCommand = commands.find(
    (command): command is PromptSlashCommand =>
      command.source === "prompt" && command.name.toLowerCase() === parsed.name.toLowerCase(),
  );

  if (!promptCommand) {
    return null;
  }

  return {
    kind: "prompt",
    expandedPrompt: await expandPromptTemplate(promptCommand.template, parsed.args, cwd),
  };
}

async function runPrompt(session: SessionState, prompt: string): Promise<void> {
  const cwd = getWorkingDirectory(session.threadOptions.workingDirectory);
  const resolvedSlashCommand = await resolvePromptExecution(session, prompt, cwd);
  if (resolvedSlashCommand?.kind === "builtin") {
    emitLocalAssistantResponse(session, prompt, resolvedSlashCommand.response);
    return;
  }

  const executionPrompt =
    resolvedSlashCommand?.kind === "prompt"
      ? resolvedSlashCommand.expandedPrompt
      : prompt;
  const attachments = session.pendingAttachments ?? [];
  session.pendingAttachments = [];
  const executionInput = buildPromptInput(
    wrapPromptForConversationMode(executionPrompt, session.conversationMode),
    attachments,
  );

  session.status = "running";
  session.error = undefined;
  session.currentItems.clear();
  session.currentItemOrder = [];
  session.currentTurnStartedAt = new Date().toISOString();
  session.abortController = new AbortController();

  session.messages.push(createUserMessage(prompt, attachments));
  session.pendingAttachments = [];
  const assistantMessage = createAssistantMessage();
  session.currentAssistantMessageId = assistantMessage.id;
  session.messages.push(assistantMessage);

  if (!session.title) {
    session.title = buildSessionTitle(prompt);
    emit({
      type: "session.title-updated",
      sessionId: session.id,
      data: { title: session.title },
    });
  }

  emit({ type: "message.updated", sessionId: session.id });
  emit({ type: "session.updated", sessionId: session.id });

  try {
    const streamed = await session.thread.runStreamed(executionInput, {
      signal: session.abortController.signal,
    });
    await writeCodexRawLog(session.id, {
      kind: "stream.start",
      threadId: session.threadId ?? null,
    });

    for await (const event of streamed.events) {
      await writeCodexRawLog(session.id, {
        kind: "stream.event",
        threadId: session.threadId ?? null,
        eventType: event.type,
        event: normalizeLogPayload(event),
      });

      if (event.type === "thread.started") {
        session.threadId = event.thread_id;
        await writeCodexRawLog(session.id, {
          kind: "thread.started",
          threadId: session.threadId,
        });
        continue;
      }

      if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        if (!session.currentItems.has(event.item.id)) {
          session.currentItemOrder.push(event.item.id);
        }
        session.currentItems.set(event.item.id, event.item);
        await rebuildAssistantMessage(session);
        emit({ type: "message.updated", sessionId: session.id });
        continue;
      }

      if (event.type === "turn.failed" || event.type === "error") {
        const error =
          event.type === "turn.failed" ? event.error.message : event.message;
        session.status = "error";
        session.error = error;
        await rebuildAssistantMessage(session);
        emit({
          type: "session.error",
          sessionId: session.id,
          data: { error },
        });
        await writeCodexRawLog(session.id, {
          kind: "stream.error",
          threadId: session.threadId ?? null,
          error,
        });
        return;
      }
    }

    await rebuildAssistantMessage(session);
    session.status = "idle";
    emit({ type: "message.updated", sessionId: session.id });
    emit({
      type: "session.idle",
      sessionId: session.id,
      data: { title: session.title },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex execution failed";
    session.status = "error";
    session.error = message;
    await writeCodexRawLog(session.id, {
      kind: "stream.exception",
      threadId: session.threadId ?? null,
      error: message,
    });
    emit({
      type: "session.error",
      sessionId: session.id,
      data: { error: message },
    });
  } finally {
    session.pendingAttachments = [];
    session.currentTurnStartedAt = undefined;
    session.abortController = undefined;
  }
}

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("*", logger());
app.use("*", async (c, next) => {
  await next();
  c.header("Access-Control-Allow-Private-Network", "true");
});
app.options("*", (c) => c.body(null, 204));

app.get("/global/health", (c) => {
  return c.json({ status: "ok", version: "1.0.0" });
});

app.get("/global/models", async (c) => {
  const { models, source } = await getAvailableModels();
  return c.json({ models, source });
});

app.get("/global/slash-commands", async (c) => {
  const cwd = getWorkingDirectory();
  const commands = await getAvailableSlashCommandDefinitions(cwd);
  return c.json({
    commands: commands.map(serializeSlashCommand),
    cwd,
  });
});

app.get("/session/list", async (c) => {
  const cwd = getWorkingDirectory();
  const sessions = await listPersistedSessionsForCwd(cwd);
  return c.json({
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
    })),
    cwd,
  });
});

app.post("/session/create", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title : undefined;
  const sessionId = createSessionId();
  const conversationMode = resolveConversationMode(body);
  const fastMode = resolveFastMode(body);
  const threadOptions = buildThreadOptions(body);
  const thread = getCodex(fastMode).startThread(threadOptions);

  sessions.set(sessionId, {
    id: sessionId,
    title,
    conversationMode,
    fastMode,
    thread,
    threadOptions,
    threadId: null,
    messages: [],
    status: "idle",
    currentItems: new Map(),
    currentItemOrder: [],
    currentTurnStartedAt: undefined,
    pendingAttachments: [],
    lastAccessed: Date.now(),
  });

  return c.json({ sessionId, title }, 201);
});

app.post("/session/resume", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threadId =
    typeof body.threadId === "string" && body.threadId.trim().length > 0
      ? body.threadId.trim()
      : null;

  if (!threadId) {
    return c.json({ error: "threadId is required" }, 400);
  }

  const conversationMode = resolveConversationMode(body);
  const fastMode = resolveFastMode(body);
  const threadOptions = buildThreadOptions(body);
  const thread = getCodex(fastMode).resumeThread(threadId, threadOptions);
  const hydrated = await hydrateMessagesFromPersistedSession(threadId);
  const sessionId = createSessionId();

  sessions.set(sessionId, {
    id: sessionId,
    title: hydrated.title,
    conversationMode,
    fastMode,
    thread,
    threadOptions,
    threadId,
    messages: hydrated.messages,
    status: "idle",
    currentItems: new Map(),
    currentItemOrder: [],
    currentTurnStartedAt: undefined,
    pendingAttachments: [],
    lastAccessed: Date.now(),
  });

  return c.json(
    {
      sessionId,
      title: hydrated.title,
      threadId,
      messages: hydrated.messages,
    },
    201,
  );
});

app.post("/session/:id/config", async (c) => {
  const sessionId = c.req.param("id");
  const session = sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  updateSessionAccess(sessionId);

  if (session.status === "running") {
    return c.json({ error: "Cannot update settings while session is running" }, 409);
  }

  // Mid-conversation config changes are allowed (e.g. switching plan↔build mode).
  // When a threadId exists we resume it so the conversation context is preserved;
  // otherwise we start a fresh thread.
  const body = await c.req.json().catch(() => ({}));
  session.conversationMode = resolveConversationMode(body);
  session.fastMode = resolveFastMode(body);
  session.threadOptions = buildThreadOptions(body);
  const sessionCodex = getCodex(session.fastMode);
  session.thread = session.threadId
    ? sessionCodex.resumeThread(session.threadId, session.threadOptions)
    : sessionCodex.startThread(session.threadOptions);

  return c.json({ status: "updated" });
});

app.get("/session/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  const session = sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  updateSessionAccess(sessionId);

  if (session.status === "running") {
    await rebuildAssistantMessage(session);
  }

  return c.json({ messages: session.messages });
});

app.get("/session/:id/status", (c) => {
  const sessionId = c.req.param("id");
  const session = sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  updateSessionAccess(sessionId);

  return c.json({
    status: session.status,
    title: session.title,
    error: session.error,
  } satisfies SessionStatusResponse);
});

app.post("/session/:id/prompt", async (c) => {
  const sessionId = c.req.param("id");
  const session = sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  updateSessionAccess(sessionId);

  const body = await c.req.json().catch(() => ({}));
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .map((entry: unknown) => {
          if (
            typeof (entry as PromptAttachmentInput | null)?.path === "string"
            && ((entry as PromptAttachmentInput).type === "image")
          ) {
            return {
              type: "image" as const,
              path: (entry as PromptAttachmentInput).path,
              dataUrl:
                typeof (entry as PromptAttachmentInput).dataUrl === "string"
                  ? (entry as PromptAttachmentInput).dataUrl
                  : undefined,
              filename:
                typeof (entry as PromptAttachmentInput).filename === "string"
                  ? (entry as PromptAttachmentInput).filename
                  : undefined,
            };
          }
          return null;
        })
        .filter((entry: PromptAttachmentInput | null): entry is PromptAttachmentInput => entry !== null)
    : [];

  if (!prompt && attachments.length === 0) {
    return c.json({ error: "Prompt or image attachment is required" }, 400);
  }

  if (session.status === "running") {
    return c.json({ error: "Session is already running" }, 409);
  }

  session.pendingAttachments = attachments;
  runPrompt(session, prompt).catch((error) => {
    console.error("[codex-bridge] Prompt failed:", error);
  });

  return c.json({ status: "processing" }, 202);
});

app.post("/session/:id/abort", (c) => {
  const sessionId = c.req.param("id");
  const session = sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  updateSessionAccess(sessionId);

  session.abortController?.abort();
  session.status = "idle";
  session.currentTurnStartedAt = undefined;
  emit({ type: "session.idle", sessionId: session.id, data: { title: session.title } });
  return c.json({ status: "aborted" });
});

app.delete("/session/:id", (c) => {
  const session = sessions.get(c.req.param("id"));
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  session.abortController?.abort();
  sessions.delete(session.id);
  return c.json({ status: "deleted" });
});

app.get("/event/subscribe", (c) => {
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({ status: "connected", timestamp: new Date().toISOString() }),
    });

    let open = true;
    const listener = async (event: SseEvent) => {
      if (!open) return;
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify({
          sessionId: event.sessionId,
          ...(event.data ?? {}),
        }),
      });
    };

    subscribers.add(listener);
    const keepalive = setInterval(async () => {
      if (!open) return;
      await stream.writeSSE({
        event: "keepalive",
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      });
    }, 30_000);

    try {
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve());
      });
    } finally {
      open = false;
      clearInterval(keepalive);
      subscribers.delete(listener);
    }
  });
});

const port = parseInt(process.env.PORT || "4098", 10);
const hostname = process.env.HOSTNAME || "0.0.0.0";

serve({
  fetch: app.fetch,
  port,
  hostname,
});

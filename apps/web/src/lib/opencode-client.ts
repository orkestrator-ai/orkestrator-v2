// OpenCode SDK client wrapper
// Provides typed functions for interacting with the OpenCode server

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";
import { isEditTool } from "./tool-names";
import { createUuid } from "./uuid";
import type {
  NativeMessage,
  NativeMessagePart,
  NativeToolDiffMetadata,
} from "./chat/native-message-types";

export { type OpencodeClient };

const PREFERRED_VARIANT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface OpenCodeModel {
  id: string;
  name: string;
  provider: string;
  /** Available model variants (e.g., low/high/xhigh) */
  variants?: string[];
  /** Input cost per token (0 means free) */
  inputCost?: number;
  /** Output cost per token (0 means free) */
  outputCost?: number;
}

export interface OpenCodeModelDefaults {
  modelId?: string;
  variant?: string;
}

export interface OpenCodeModelsResponse {
  models: OpenCodeModel[];
  defaults: OpenCodeModelDefaults;
}

export interface OpenCodeSlashCommand {
  name: string;
  description?: string;
  hints?: string[];
}

function normalizeSlashCommandName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveDefaultModelId(defaultConfig: unknown): string | undefined {
  if (!defaultConfig || typeof defaultConfig !== "object") return undefined;

  const config = defaultConfig as Record<string, unknown>;

  const directModelId = config.model;
  if (typeof directModelId === "string" && directModelId.includes("/")) {
    return directModelId;
  }

  const nestedModel = config.model;
  if (nestedModel && typeof nestedModel === "object") {
    const nested = nestedModel as Record<string, unknown>;
    const providerID = nested.providerID;
    const modelID = nested.modelID;
    if (typeof providerID === "string" && typeof modelID === "string") {
      return `${providerID}/${modelID}`;
    }
  }

  const providerID = config.providerID;
  const modelID = config.modelID;
  if (typeof providerID === "string" && typeof modelID === "string") {
    return `${providerID}/${modelID}`;
  }

  const provider = config.provider;
  const model = config.model;
  if (typeof provider === "string" && typeof model === "string") {
    return `${provider}/${model}`;
  }

  return undefined;
}

function resolveDefaultVariant(defaultConfig: unknown): string | undefined {
  if (!defaultConfig || typeof defaultConfig !== "object") return undefined;

  const config = defaultConfig as Record<string, unknown>;

  if (typeof config.variant === "string") {
    return config.variant;
  }

  const nestedModel = config.model;
  if (nestedModel && typeof nestedModel === "object") {
    const nested = nestedModel as Record<string, unknown>;
    if (typeof nested.variant === "string") {
      return nested.variant;
    }
  }

  return undefined;
}

export type ToolDiffMetadata = NativeToolDiffMetadata;
export type OpenCodeMessagePart = NativeMessagePart;
export type OpenCodeMessage = NativeMessage & {
  /** Whether the SDK marked this assistant message as failed. Raw error data is intentionally not retained. */
  hasError?: boolean;
};


export interface OpenCodeSession {
  id: string;
  title?: string;
  createdAt: string;
}

/** OpenCode conversation mode */
export type OpenCodeConversationMode = "plan" | "build";

/** Question option for multiple choice questions */
export interface QuestionOption {
  /** Display text (1-5 words, concise) */
  label: string;
  /** Longer description explaining the option */
  description?: string;
}

/** Question info structure */
export interface QuestionInfo {
  /** Complete question text */
  question: string;
  /** Very short label (max 12 chars) */
  header: string;
  /** Available choices */
  options: QuestionOption[];
  /** Allow selecting multiple choices */
  multiple?: boolean;
  /** Allow typing a custom answer (default: true) */
  custom?: boolean;
}

/** Question request from OpenCode */
export interface QuestionRequest {
  /** Request ID */
  id: string;
  /** Session ID */
  sessionID: string;
  /** Questions to ask */
  questions: QuestionInfo[];
  /** Associated tool info */
  tool?: {
    messageID: string;
    callID: string;
  };
}

/** Permission request from OpenCode */
export interface PermissionRequest {
  /** Request ID */
  id: string;
  /** Session ID */
  sessionID: string;
  /** Permission type (e.g. read, edit, bash) */
  permission: string;
  /** Requested path patterns */
  patterns: string[];
  /** Additional metadata from the tool invocation */
  metadata: Record<string, unknown>;
  /** Patterns that can be persisted with "always" */
  always: string[];
  /** Associated tool info */
  tool?: {
    messageID: string;
    callID: string;
  };
}

/** Answer to a question (array of selected labels or typed text) */
export type QuestionAnswer = string[];

/** Reply to a permission request */
export type PermissionReply = "once" | "always" | "reject";

/** Prefix for client-side error message IDs (used to preserve errors across message refreshes) */
export const ERROR_MESSAGE_PREFIX = "error-";

/** Prefix for client-side system message IDs (used to preserve system messages across message refreshes) */
export const SYSTEM_MESSAGE_PREFIX = "system-";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return undefined;
}

function toDisplayString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_FRAGMENTS = [
  "authorization",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "credential",
  "privatekey",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/=]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, `$1${REDACTED_VALUE}`);
}

function redactSensitiveData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, seen));
  }

  if (isRecord(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        redacted[key] = REDACTED_VALUE;
        continue;
      }

      redacted[key] = redactSensitiveData(child, seen);
    }

    return redacted;
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  return value;
}

function safeJSONStringify(value: unknown, maxLength = 4000): string | undefined {
  try {
    const sanitized = redactSensitiveData(value);
    const json = JSON.stringify(sanitized, null, 2);
    if (!json || json === "{}") {
      return undefined;
    }

    if (json.length <= maxLength) {
      return json;
    }

    return `${json.slice(0, maxLength)}\n... (details truncated)`;
  } catch {
    return undefined;
  }
}

/** Format OpenCode/SDK errors into a user-readable detailed message. */
export function formatOpenCodeError(error: unknown): string {
  if (typeof error === "string") {
    return redactSensitiveText(error);
  }

  const fallbackFromError = error instanceof Error
    ? firstNonEmptyString([error.message, error.name])
    : undefined;

  if (!isRecord(error)) {
    return fallbackFromError || "An unknown error occurred";
  }

  const data = isRecord(error.data) ? error.data : undefined;
  const summary = firstNonEmptyString([
    data?.message,
    data?.detail,
    data?.error,
    error.message,
    error.detail,
    error.error,
  ]);
  const errorType = firstNonEmptyString([
    data?.errorType,
    data?.type,
    error.errorType,
    error.type,
    error.name,
  ]);

  let headline = summary || errorType || fallbackFromError || "An unknown error occurred";
  if (summary && errorType && !summary.toLowerCase().includes(errorType.toLowerCase())) {
    headline = `${errorType}: ${summary}`;
  }
  headline = redactSensitiveText(headline);

  const detailLines: string[] = [];
  const code = toDisplayString(data?.code ?? error.code);
  const status = toDisplayString(data?.status ?? data?.statusCode ?? error.status ?? error.statusCode);
  const requestId = firstNonEmptyString([
    data?.requestID,
    data?.requestId,
    error.requestID,
    error.requestId,
  ]);

  if (code) {
    detailLines.push(`Code: ${code}`);
  }
  if (status) {
    detailLines.push(`Status: ${status}`);
  }
  if (requestId) {
    detailLines.push(`Request ID: ${requestId}`);
  }

  const rawDetails = safeJSONStringify(error);
  if (rawDetails) {
    detailLines.push(`Raw error:\n${rawDetails}`);
  }

  if (detailLines.length === 0) {
    return headline;
  }

  return `${headline}\n\n${detailLines.join("\n")}`;
}

function openCodeResponseError(operation: string, error: unknown): Error {
  if (error === undefined || error === null) {
    return new Error(operation);
  }

  return new Error(`${operation}: ${formatOpenCodeError(error)}`);
}

/** Structure for filediff metadata from the SDK */
interface FileDiffMetadata {
  file?: string;
  before?: string;
  after?: string;
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseOpenCodeCreatedAt(value: unknown): string {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return new Date().toISOString();
}

function isOpenCodeTaskTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}

function stringRecordValue(
  value: unknown,
  ...keys: string[]
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseTaskEnvelope(output: string | undefined): {
  sessionId?: string;
  state?: "running" | "completed" | "error";
} {
  if (!output) return {};
  const match = output.match(
    /<task\s+id=["']([^"']+)["'](?:\s+state=["'](running|completed|error)["'])?/i,
  );
  if (!match) return {};
  return {
    sessionId: match[1],
    state: match[2]?.toLowerCase() as "running" | "completed" | "error" | undefined,
  };
}

function countOpenCodeToolActions(parts: OpenCodeMessagePart[]): number {
  let count = 0;
  for (const part of parts) {
    if (part.type === "tool-invocation") count++;
    if (part.type === "subagent" && part.subagentActions) {
      count += countOpenCodeToolActions(part.subagentActions);
    }
  }
  return count;
}

function flattenOpenCodeSubagentActions(messages: OpenCodeMessage[]): OpenCodeMessagePart[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.parts : [],
  );
}

function mapOpenCodeParts(
  parts: OpenCodeMessagePart[],
  mapper: (part: OpenCodeMessagePart) => OpenCodeMessagePart,
): { parts: OpenCodeMessagePart[]; changed: boolean } {
  let changed = false;
  const nextParts = parts.map((part) => {
    let nextPart = part;
    if (part.type === "subagent" && part.subagentActions?.length) {
      const nested = mapOpenCodeParts(part.subagentActions, mapper);
      if (nested.changed) {
        nextPart = { ...part, subagentActions: nested.parts };
      }
    }
    nextPart = mapper(nextPart);
    if (nextPart !== part) changed = true;
    return nextPart;
  });
  return { parts: changed ? nextParts : parts, changed };
}

/** Return true when a transcript contains an OpenCode Task backed by this child session. */
export function hasOpenCodeSubagentSession(
  messages: OpenCodeMessage[],
  childSessionId: string,
): boolean {
  return messages.some((message) => {
    let found = false;
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && part.subagentId === childSessionId) {
        found = true;
      }
      return part;
    });
    return found;
  });
}

/**
 * Attach an authoritative child-session transcript to every matching Task part.
 * Nested Tasks are traversed as well, so child SSE events can update their
 * corresponding yellow Agent row without rebuilding the parent transcript.
 */
export function mergeOpenCodeSubagentTranscript(
  messages: OpenCodeMessage[],
  childSessionId: string,
  childMessages: OpenCodeMessage[],
  state?: "success" | "failure" | "pending",
): OpenCodeMessage[] {
  const actions = flattenOpenCodeSubagentActions(childMessages);
  const actionCount = countOpenCodeToolActions(actions);
  let changed = false;

  const nextMessages = messages.map((message) => {
    const mapped = mapOpenCodeParts(message.parts, (part) => {
      if (part.type !== "subagent" || part.subagentId !== childSessionId) {
        return part;
      }
      const nextState =
        state === "failure" || part.toolState === "failure"
          ? "failure"
          : part.toolState === "success"
            ? "success"
            : state ?? part.toolState;
      return {
        ...part,
        toolState: nextState,
        subagentActions: actions,
        subagentActionCount: actionCount,
      };
    });
    if (!mapped.changed) return message;
    changed = true;
    return { ...message, parts: mapped.parts };
  });

  return changed ? nextMessages : messages;
}

function stripOpenCodeReasoningBoldMarkers(content: string): string {
  return content
    .replace(/^(\s*)\*\*/, "$1")
    .replace(/\*\*(\s*)$/, "$1");
}

export function normalizeOpenCodePart(part: unknown): OpenCodeMessagePart | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = part as any;
  if (!p || typeof p !== "object") return null;

  const sourcePartId = typeof p.id === "string" ? p.id : undefined;
  const sourceMessageId = typeof p.messageID === "string" ? p.messageID : undefined;
  const partType = p.type;

  if (partType === "reasoning") {
    const reasoningContent = typeof p.text === "string" ? p.text : "";
    if (!reasoningContent) return null;
    return {
      type: "thinking",
      content: stripOpenCodeReasoningBoldMarkers(reasoningContent),
      sourcePartId,
      sourceMessageId,
    };
  }

  if (partType === "text" && typeof p.text === "string") {
    return {
      type: "text",
      content: p.text,
      sourcePartId,
      sourceMessageId,
    };
  }

  if (partType === "tool") {
    const toolName = typeof p.tool === "string" ? p.tool : "Unknown tool";
    const toolStatus = p.state?.status;

    let mappedState: "success" | "failure" | "pending" | undefined;
    if (toolStatus === "completed") mappedState = "success";
    else if (toolStatus === "error") mappedState = "failure";
    else if (toolStatus === "pending" || toolStatus === "running") mappedState = "pending";

    const toolTitle = p.state?.title as string | undefined;
    const toolOutput = stringifyToolPayload(p.state?.output);
    const toolError = stringifyToolPayload(p.state?.error);

    if (isOpenCodeTaskTool(toolName)) {
      const input = p.state?.input;
      const metadata = p.state?.metadata ?? p.metadata;
      const taskEnvelope = parseTaskEnvelope(toolOutput);
      const subagentId =
        stringRecordValue(metadata, "sessionId", "sessionID", "jobId") ??
        taskEnvelope.sessionId;
      const description =
        stringRecordValue(input, "description") ?? toolTitle ?? toolName;
      const role = stringRecordValue(input, "subagent_type", "agent");
      const prompt = stringRecordValue(input, "prompt");

      if (taskEnvelope.state === "running") mappedState = "pending";
      else if (taskEnvelope.state === "completed") mappedState = "success";
      else if (taskEnvelope.state === "error") mappedState = "failure";

      return {
        type: "subagent",
        content: description,
        sourcePartId,
        sourceMessageId,
        toolName,
        toolArgs: input,
        toolState: mappedState,
        toolTitle,
        toolOutput,
        toolError,
        subagentId,
        subagentName: description,
        subagentRole: role,
        subagentPrompt: prompt,
        subagentActions: [],
        subagentActionCount: 0,
      };
    }

    let toolDiff: ToolDiffMetadata | undefined;
    if (isEditTool(toolName)) {
      const input = p.state?.input || {};
      const meta = p.state?.metadata || {};
      const filediff = meta.filediff as FileDiffMetadata | undefined;

      const filePath = (input.filePath || input.file_path || input.path || input.file ||
        meta.file || meta.filePath || meta.path || filediff?.file) as string | undefined;

      const oldString = typeof input.oldString === "string" ? input.oldString :
        typeof input.old_string === "string" ? input.old_string : undefined;
      const newString = typeof input.newString === "string" ? input.newString :
        typeof input.new_string === "string" ? input.new_string :
        typeof input.content === "string" ? input.content : undefined;
      const metaBefore = typeof filediff?.before === "string" ? filediff.before :
        typeof meta.before === "string" ? meta.before : undefined;
      const metaAfter = typeof filediff?.after === "string" ? filediff.after :
        typeof meta.after === "string" ? meta.after : undefined;

      const unifiedDiff = typeof meta.diff === "string" ? meta.diff :
        typeof input.patch === "string" ? input.patch :
        typeof input.diff === "string" ? input.diff : undefined;

      const beforeValue = oldString ?? metaBefore;
      const afterValue = newString ?? metaAfter;

      let additions: number | undefined;
      let deletions: number | undefined;

      if (typeof meta.additions === "number" && typeof meta.deletions === "number") {
        additions = meta.additions as number;
        deletions = meta.deletions as number;
      } else if (unifiedDiff) {
        let addCount = 0;
        let delCount = 0;
        const lines = unifiedDiff.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
          else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
        }
        additions = addCount;
        deletions = delCount;
      } else if (toolOutput && toolOutput.includes("@@") && (toolOutput.includes("\n+") || toolOutput.includes("\n-"))) {
        let addCount = 0;
        let delCount = 0;
        const lines = toolOutput.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
          else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
        }
        if (addCount > 0 || delCount > 0) {
          additions = addCount;
          deletions = delCount;
        }
      } else if (beforeValue !== undefined || afterValue !== undefined) {
        const oldLines = beforeValue ? beforeValue.split("\n").length : 0;
        const newLines = afterValue ? afterValue.split("\n").length : 0;
        if (beforeValue && afterValue) {
          deletions = oldLines;
          additions = newLines;
        } else if (afterValue) {
          additions = newLines;
          deletions = 0;
        } else if (beforeValue) {
          additions = 0;
          deletions = oldLines;
        }
      }

      toolDiff = {
        filePath,
        additions,
        deletions,
        before: beforeValue,
        after: afterValue,
        diff: unifiedDiff,
      };
    }

    return {
      type: "tool-invocation",
      content: toolName,
      sourcePartId,
      sourceMessageId,
      toolName,
      toolArgs: p.state?.input,
      toolState: mappedState,
      toolDiff,
      toolTitle,
      toolOutput,
      toolError,
    };
  }

  if (partType === "file") {
    const filePath = p.filename || p.url || "";
    return {
      type: "file",
      content: filePath,
      sourcePartId,
      sourceMessageId,
      fileUrl: typeof p.url === "string" ? p.url : undefined,
    };
  }

  return null;
}

export function normalizeOpenCodeMessage(rawMessage: unknown): OpenCodeMessage | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = rawMessage as any;
  if (!msg || typeof msg !== "object") return null;

  const info = msg.info;
  const createdAt = parseOpenCodeCreatedAt(info?.time?.created);
  const parsedParts: OpenCodeMessagePart[] = [];
  let textContent = "";

  if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      const parsedPart = normalizeOpenCodePart(part);
      if (!parsedPart) continue;
      parsedParts.push(parsedPart);
      if (parsedPart.type === "text") {
        textContent += parsedPart.content;
      }
    }
  }

  return {
    id: info?.id || createUuid(),
    role: (info?.role as "user" | "assistant") || "assistant",
    content: textContent,
    parts: parsedParts,
    createdAt,
    ...(info?.error !== undefined && info?.error !== null
      ? { hasError: true }
      : {}),
  };
}

/**
 * Compute a stable identity key for a message part so incremental streaming
 * updates (`message.part.updated`) can replace the matching part in place.
 *
 * Prefers the SDK source part id; falls back to a composite key derived from
 * the source message id and the part's distinguishing fields. Returns null
 * when the part has no source identity (in which case it cannot be matched).
 */
export function getOpenCodePartKey(part: OpenCodeMessagePart): string | null {
  if (part.sourcePartId) return part.sourcePartId;
  if (part.sourceMessageId) {
    return [
      part.sourceMessageId,
      part.type,
      part.toolName,
      part.fileUrl,
      part.content,
    ].filter(Boolean).join(":");
  }
  return null;
}

/**
 * Build (or update) an OpenCode message from a single streamed part.
 *
 * If the part matches an existing part (by {@link getOpenCodePartKey}) it is
 * replaced in place; otherwise it is appended. When the incoming part carries
 * no content but a text `delta`, the delta is appended to the existing part's
 * content (incremental text streaming). The aggregate `content` is recomputed
 * from all text parts. Role/createdAt are preserved from the existing message,
 * defaulting to an assistant message created now.
 */
export function buildOpenCodeMessageFromPart(
  existing: OpenCodeMessage | undefined,
  messageId: string,
  part: OpenCodeMessagePart,
  delta?: string,
): OpenCodeMessage {
  const nextParts = [...(existing?.parts ?? [])];
  const incomingKey = getOpenCodePartKey(part);
  const existingIndex = incomingKey
    ? nextParts.findIndex((existingPart) => getOpenCodePartKey(existingPart) === incomingKey)
    : -1;
  const existingPart = existingIndex >= 0 ? nextParts[existingIndex] : undefined;
  const nextPart =
    part.content === "" && delta && existingPart?.type === part.type
      ? { ...part, content: `${existingPart.content}${delta}` }
      : part;

  if (existingIndex >= 0) {
    nextParts[existingIndex] = nextPart;
  } else {
    nextParts.push(nextPart);
  }

  const content = nextParts
    .filter((candidate) => candidate.type === "text")
    .map((candidate) => candidate.content)
    .join("");

  return {
    id: messageId,
    role: existing?.role ?? "assistant",
    content,
    parts: nextParts,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Create an OpenCode SDK client connected to a server
 */
export function createClient(baseUrl: string, directory?: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: resolveGatewayLoopbackBaseUrl(baseUrl),
    directory,
  });
}

type ProviderLike = {
  id?: string;
  models?: unknown;
};

type ProviderCatalogLike = {
  all?: unknown;
  providers?: unknown;
  default?: unknown;
};

function normalizeProviders(value: unknown): ProviderLike[] {
  if (Array.isArray(value)) {
    return value.filter((provider): provider is ProviderLike => {
      return !!provider && typeof provider === "object";
    });
  }

  // Handle object-map format: { anthropic: {...}, openai: {...} }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, v]) => !!v && typeof v === "object")
      .map(([key, v]) => {
        const provider = v as ProviderLike;
        // If the provider doesn't have an id, use the object key
        return provider.id ? provider : { ...provider, id: key };
      });
  }

  return [];
}

function getProvidersFromCatalog(value: unknown): ProviderLike[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const catalog = value as ProviderCatalogLike;

  if (catalog.all) {
    return normalizeProviders(catalog.all);
  }

  if (catalog.providers) {
    return normalizeProviders(catalog.providers);
  }

  return [];
}

function normalizeProviderModels(models: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(models)) {
    return models.filter((model): model is Record<string, unknown> => {
      return !!model && typeof model === "object";
    });
  }

  if (models && typeof models === "object") {
    return Object.entries(models)
      .filter(([, model]) => !!model && typeof model === "object")
      .map(([key, model]) => {
        const record = model as Record<string, unknown>;
        return typeof record.id === "string" ? record : { ...record, id: key };
      });
  }

  return [];
}

/**
 * Get available models/providers from the server
 */
export async function getModels(client: OpencodeClient): Promise<OpenCodeModel[]> {
  const response = await getModelsWithDefaults(client);
  return response.models;
}

/**
 * Get available models/providers plus server defaults from model.json
 */
export async function getModelsWithDefaults(client: OpencodeClient): Promise<OpenCodeModelsResponse> {
  try {
    // Prefer provider.list() because it exposes the full provider/model catalog
    // used by the OpenCode TUI. Fall back to config.providers() for older servers.
    let responseData: unknown;

    try {
      const providerResponse = await client.provider.list();
      responseData = providerResponse.data;
    } catch (err) {
      console.debug("[opencode-client] provider.list() unavailable, falling back to config.providers()", err);
      const configResponse = await client.config.providers();
      responseData = configResponse.data;
    }

    if (!responseData || typeof responseData !== "object") {
      return { models: [], defaults: {} };
    }

    const models: OpenCodeModel[] = [];

    // provider.list() returns: { all: Provider[], default: {...}, connected: [...] }
    // config.providers() returns: { providers: Provider[] | { [id]: Provider }, default: {...} }
    // Each Provider has: { id, name, models: { [modelId]: Model } | Model[] }
    // Each Model has: { id, name, providerID, ... }
    const providers = getProvidersFromCatalog(responseData);
    for (const provider of providers) {
      if (provider && provider.id && provider.models) {
        for (const model of normalizeProviderModels(provider.models)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const m = model as any;
          const modelId = typeof m.id === "string" ? m.id : undefined;
          const modelName = typeof m.name === "string" ? m.name : modelId;

          if (!modelId) {
            continue;
          }

          // Cost fields may be in cost.input/cost.output or directly as inputCost/outputCost
          const inputCost = m.cost?.input ?? m.inputCost ?? m.input_cost;
          const outputCost = m.cost?.output ?? m.outputCost ?? m.output_cost;

          // Variants are provider/model specific (e.g. low/high/xhigh)
          // Response shape: variants: { [variantName]: { disabled?: boolean, ... } }
          const variantEntries = m.variants && typeof m.variants === "object"
            ? Object.entries(m.variants as Record<string, { disabled?: boolean }>)
            : [];

          const variants = variantEntries
            .filter(([, variantConfig]) => {
              if (!variantConfig || typeof variantConfig !== "object") return true;
              return variantConfig.disabled !== true;
            })
            .map(([variantName]) => variantName)
            .sort((a, b) => {
              const aIndex = PREFERRED_VARIANT_ORDER.indexOf(a);
              const bIndex = PREFERRED_VARIANT_ORDER.indexOf(b);

              if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
              if (aIndex >= 0) return -1;
              if (bIndex >= 0) return 1;

              return a.localeCompare(b);
            });

          models.push({
            id: `${provider.id}/${modelId}`,
            name: modelName || modelId,
            provider: provider.id,
            variants: variants.length > 0 ? variants : undefined,
            inputCost: typeof inputCost === "number" ? inputCost : undefined,
            outputCost: typeof outputCost === "number" ? outputCost : undefined,
          });
        }
      }
    }

    const catalog = responseData as ProviderCatalogLike;
    const defaults = catalog.default && typeof catalog.default === "object"
      ? {
          modelId: resolveDefaultModelId(catalog.default),
          variant: resolveDefaultVariant(catalog.default),
        }
      : {};

    return { models, defaults };
  } catch (error) {
    console.error("[opencode-client] Failed to get models:", error);
    return { models: [], defaults: {} };
  }
}

/**
 * Get available slash commands from the OpenCode server.
 */
export async function getAvailableSlashCommands(
  client: OpencodeClient,
  directory?: string,
): Promise<OpenCodeSlashCommand[]> {
  try {
    type CommandListResponse = {
      data?: Array<{
        name: string;
        description?: string;
        subtask?: boolean;
        hints: Array<string>;
      }>;
    };

    // Make two calls: one without directory (server uses its own CWD for full
    // discovery) and one with directory (for project-specific commands).
    const requests: Array<{
      source: "global" | "directory";
      promise: Promise<CommandListResponse>;
    }> = [
      {
        source: "global",
        promise: client.command.list(),
      },
    ];

    if (directory) {
      requests.push({
        source: "directory",
        promise: client.command.list({ directory }),
      });
    }

    const settled = await Promise.allSettled(
      requests.map((request) => request.promise),
    );

    const responsesBySource = new Map<"global" | "directory", CommandListResponse>();

    for (let index = 0; index < settled.length; index += 1) {
      const source = requests[index]?.source;
      const result = settled[index];

      if (!source || !result) continue;

      if (result.status === "fulfilled") {
        responsesBySource.set(source, result.value);
      } else {
        console.warn("[opencode-client] Failed to get slash commands from source:", {
          source,
          error: result.reason,
        });
      }
    }

    // Prefer directory metadata for duplicate command names when available,
    // while still using global metadata to fill missing fields.
    const sourcePriority: Array<"global" | "directory"> = directory
      ? ["directory", "global"]
      : ["global"];

    const commandMap = new Map<string, OpenCodeSlashCommand>();

    for (const source of sourcePriority) {
      const response = responsesBySource.get(source);
      if (!response?.data) continue;

      for (const command of response.data) {
        const normalizedName = normalizeSlashCommandName(command.name || "");
        if (!normalizedName) {
          continue;
        }

        const hints = Array.isArray(command.hints)
          ? command.hints.filter(
              (hint): hint is string =>
                typeof hint === "string" && hint.trim().length > 0,
            )
          : [];

        const description =
          typeof command.description === "string" && command.description.trim().length > 0
            ? command.description.trim()
            : hints[0];

        const mappedCommand: OpenCodeSlashCommand = {
          name: normalizedName,
          description,
          hints: hints.length > 0 ? hints : undefined,
        };

        const existing = commandMap.get(normalizedName);
        if (!existing) {
          commandMap.set(normalizedName, mappedCommand);
          continue;
        }

        commandMap.set(normalizedName, {
          ...existing,
          description: existing.description ?? mappedCommand.description,
          hints: existing.hints ?? mappedCommand.hints,
        });
      }
    }

    return Array.from(commandMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error("[opencode-client] Failed to get slash commands:", error);
    return [];
  }
}

/**
 * Create a new chat session
 */
export async function createSession(
  client: OpencodeClient,
  title?: string
): Promise<OpenCodeSession> {
  const response = await client.session.create({
    title,
  });

  if (!response.data) {
    throw new Error("OpenCode returned an empty session response");
  }

  const createdTime = response.data.time?.created;
  const createdAt = typeof createdTime === "number"
    ? new Date(createdTime).toISOString()
    : createdTime || new Date().toISOString();

  return {
    id: response.data.id,
    title: response.data.title,
    createdAt,
  };
}

/**
 * Get messages for a session
 */
export async function getSessionMessages(
  client: OpencodeClient,
  sessionId: string,
  options: { throwOnError?: boolean; includeSubagents?: boolean } = {},
): Promise<OpenCodeMessage[]> {
  try {
    const response = await client.session.messages({
      sessionID: sessionId,
    }, {
      throwOnError: options.throwOnError,
    });

    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get OpenCode session messages",
          response.error,
        );
      }
      return [];
    }

    let messages = response.data
      .map((msg) => normalizeOpenCodeMessage(msg))
      .filter((message): message is OpenCodeMessage => message !== null);

    if (options.includeSubagents !== false) {
      messages = await hydrateOpenCodeSubagentTranscripts(
        client,
        sessionId,
        messages,
        new Set([sessionId]),
        undefined,
        options.throwOnError === true,
      );
    }

    return messages;
  } catch (error) {
    console.error("[opencode-client] Failed to get messages:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get OpenCode session messages");
    }
    return [];
  }
}

type OpenCodeChildSession = {
  id: string;
  title?: string;
  agent?: string;
};

type OpenCodeSessionStatusMap = Record<
  string,
  { type?: "idle" | "busy" | "retry" }
>;

function findUnidentifiedTaskParts(messages: OpenCodeMessage[]): OpenCodeMessagePart[] {
  const result: OpenCodeMessagePart[] = [];
  for (const message of messages) {
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && !part.subagentId) result.push(part);
      return part;
    });
  }
  return result;
}

async function getOpenCodeChildSessions(
  client: OpencodeClient,
  parentSessionId: string,
  throwOnError = false,
): Promise<OpenCodeChildSession[]> {
  try {
    const response = await client.session.children(
      { sessionID: parentSessionId },
      { throwOnError },
    );
    if (!response.data && throwOnError) {
      throw openCodeResponseError(
        "Failed to get OpenCode child sessions",
        response.error,
      );
    }
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.warn("[opencode-client] Failed to get child sessions:", error);
    if (throwOnError) throw error;
    return [];
  }
}

function assignOpenCodeChildSessionIds(
  messages: OpenCodeMessage[],
  children: OpenCodeChildSession[],
): OpenCodeMessage[] {
  const claimed = new Set<string>();
  for (const message of messages) {
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && part.subagentId) claimed.add(part.subagentId);
      return part;
    });
  }

  let changed = false;
  const nextMessages = messages.map((message) => {
    const mapped = mapOpenCodeParts(message.parts, (part) => {
      if (part.type !== "subagent" || part.subagentId) return part;
      const child = children.find((candidate) => {
        if (claimed.has(candidate.id)) return false;
        const title = candidate.title?.trim();
        if (!title) return false;
        return title === part.content || title.startsWith(`${part.content} (@`);
      });
      if (!child) return part;
      claimed.add(child.id);
      return {
        ...part,
        subagentId: child.id,
        subagentRole: part.subagentRole ?? child.agent,
      };
    });
    if (!mapped.changed) return message;
    changed = true;
    return { ...message, parts: mapped.parts };
  });
  return changed ? nextMessages : messages;
}

async function getOpenCodeSessionStatusMap(
  client: OpencodeClient,
  throwOnError = false,
): Promise<OpenCodeSessionStatusMap | undefined> {
  const status = (client.session as unknown as {
    status?: (
      parameters?: unknown,
      options?: { throwOnError?: boolean },
    ) => Promise<{ data?: OpenCodeSessionStatusMap; error?: unknown }>;
  }).status;
  if (typeof status !== "function") return undefined;
  try {
    const response = await status.call(client.session, undefined, { throwOnError });
    if (!response.data) {
      if (throwOnError) {
        throw openCodeResponseError(
          "Failed to get OpenCode subagent session statuses",
          response.error,
        );
      }
      return undefined;
    }
    return isRecord(response.data) && !Array.isArray(response.data)
      ? response.data as OpenCodeSessionStatusMap
      : undefined;
  } catch (error) {
    console.warn("[opencode-client] Failed to get subagent session statuses:", error);
    if (throwOnError) throw error;
    return undefined;
  }
}

function hasOpenCodeAssistantError(messages: OpenCodeMessage[]): boolean {
  return messages.some((message) => message.role === "assistant" && message.hasError === true);
}

async function hydrateOpenCodeSubagentTranscripts(
  client: OpencodeClient,
  parentSessionId: string,
  initialMessages: OpenCodeMessage[],
  ancestors: Set<string> = new Set([parentSessionId]),
  statusMap?: OpenCodeSessionStatusMap,
  throwOnError = false,
): Promise<OpenCodeMessage[]> {
  let messages = initialMessages;
  if (findUnidentifiedTaskParts(messages).length > 0) {
    const children = await getOpenCodeChildSessions(client, parentSessionId, throwOnError);
    messages = assignOpenCodeChildSessionIds(messages, children);
  }

  const childIds = new Set<string>();
  for (const message of messages) {
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && part.subagentId && !ancestors.has(part.subagentId)) {
        childIds.add(part.subagentId);
      }
      return part;
    });
  }

  const resolvedStatusMap =
    statusMap ??
    (childIds.size > 0
      ? await getOpenCodeSessionStatusMap(client, throwOnError)
      : undefined);

  const transcripts = await Promise.all(
    Array.from(childIds, async (childSessionId) => {
      const childMessages = await getSessionMessages(client, childSessionId, {
        includeSubagents: false,
        throwOnError: true,
      });
      const hydrated = await hydrateOpenCodeSubagentTranscripts(
        client,
        childSessionId,
        childMessages,
        new Set([...ancestors, childSessionId]),
        resolvedStatusMap,
        throwOnError,
      );
      return { childSessionId, messages: hydrated };
    }),
  );

  for (const transcript of transcripts) {
    const childStatus = resolvedStatusMap?.[transcript.childSessionId]?.type;
    const state =
      hasOpenCodeAssistantError(transcript.messages)
        ? "failure"
        : childStatus === "busy" || childStatus === "retry"
        ? "pending"
        : childStatus === "idle"
          ? "success"
          : undefined;
    messages = mergeOpenCodeSubagentTranscript(
      messages,
      transcript.childSessionId,
      transcript.messages,
      state,
    );
  }
  return messages;
}

export type OpenCodeSessionStatus = "idle" | "busy" | "retry";

/**
 * Read the current server-side status for one session. The v2 SDK returns a
 * map for every session, so callers select the session they own by ID.
 */
export async function getSessionStatus(
  client: OpencodeClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<OpenCodeSessionStatus | null> {
  try {
    const response = await client.session.status(undefined, {
      throwOnError: options.throwOnError,
    });
    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get OpenCode session status",
          response.error,
        );
      }
      return null;
    }

    const status = response.data[sessionId];
    if (
      status?.type !== "idle" &&
      status?.type !== "busy" &&
      status?.type !== "retry"
    ) {
      return null;
    }
    return status.type;
  } catch (error) {
    console.error("[opencode-client] Failed to get session status:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get OpenCode session status");
    }
    return null;
  }
}

/** Attachment input for sendPrompt */
export interface PromptAttachment {
  type: "file" | "image";
  path: string;
  /** Data URL for the content (e.g., base64 encoded image) */
  dataUrl?: string;
  /** Original filename */
  filename?: string;
}

export interface SendPromptResult {
  success: boolean;
  error?: string;
}

/**
 * Send a prompt to a session
 */
export async function sendPrompt(
  client: OpencodeClient,
  sessionId: string,
  message: string,
  options?: {
    model?: string;
    variant?: string;
    mode?: OpenCodeConversationMode;
    attachments?: PromptAttachment[];
  }
): Promise<SendPromptResult> {
  try {
    // Build the parts array with proper typing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [
      { type: "text" as const, text: message },
    ];

    if (options?.attachments) {
      for (const attachment of options.attachments) {
        // SDK FilePartInput requires: type, mime, url
        // Determine MIME type based on attachment type and filename
        let mime = "application/octet-stream";
        if (attachment.type === "image") {
          mime = "image/png"; // Default for clipboard images
          if (attachment.filename?.endsWith(".jpg") || attachment.filename?.endsWith(".jpeg")) {
            mime = "image/jpeg";
          } else if (attachment.filename?.endsWith(".gif")) {
            mime = "image/gif";
          } else if (attachment.filename?.endsWith(".webp")) {
            mime = "image/webp";
          }
        } else if (attachment.filename) {
          // Try to infer MIME type from filename for files
          const ext = attachment.filename.split(".").pop()?.toLowerCase();
          if (ext === "txt") mime = "text/plain";
          else if (ext === "json") mime = "application/json";
          else if (ext === "js" || ext === "mjs") mime = "text/javascript";
          else if (ext === "ts" || ext === "tsx") mime = "text/typescript";
          else if (ext === "md") mime = "text/markdown";
          else if (ext === "html") mime = "text/html";
          else if (ext === "css") mime = "text/css";
          else if (ext === "py") mime = "text/x-python";
          else if (ext === "rs") mime = "text/x-rust";
        }

        // Use data URL if available, otherwise construct file:// URL
        const url = attachment.dataUrl || `file://${attachment.path}`;

        parts.push({
          type: "file" as const,
          mime,
          url,
          filename: attachment.filename,
        });
      }
    }

    await client.session.promptAsync({
      sessionID: sessionId,
      parts,
      model: options?.model ? {
        providerID: options.model.split("/")[0] || "",
        modelID: options.model.split("/")[1] || options.model,
      } : undefined,
      agent: options?.mode,
      variant: options?.variant,
    });

    return { success: true };
  } catch (error) {
    console.error("[opencode-client] Failed to send prompt:", error);
    return {
      success: false,
      error: formatOpenCodeError(error),
    };
  }
}

/** Event types from OpenCode SSE stream */
export interface OpenCodeEvent {
  type: "message.updated" | "session.updated" | "session.error" | "file.edited" | "file.watcher.updated" | "permission.asked" | "permission.replied" | "question.asked" | "question.replied" | "question.rejected" | string;
  properties?: {
    sessionID?: string;
    info?: {
      id?: string;
      role?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    };
    error?: string;
    /** For question.asked events - the question request */
    id?: string;
    questions?: QuestionInfo[];
    tool?: {
      messageID: string;
      callID: string;
    };
    /** For permission.asked events */
    permission?: string;
    patterns?: string[];
    metadata?: Record<string, unknown>;
    always?: string[];
    /** For permission.replied events */
    reply?: PermissionReply;
    /** For question.replied events */
    requestID?: string;
    answers?: QuestionAnswer[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

/**
 * Subscribe to events from the server
 * Returns an async iterator for SSE events
 */
export async function subscribeToEvents(client: OpencodeClient): Promise<AsyncIterable<OpenCodeEvent> | null> {
  try {
    // event.subscribe() returns { stream: AsyncGenerator }
    const response = await client.event.subscribe();

    // The response has a stream property that is the async generator
    if (response && "stream" in response) {
      return response.stream as AsyncIterable<OpenCodeEvent>;
    }

    // Fallback - try to iterate the response directly
    if (response && Symbol.asyncIterator in Object(response)) {
      return response as unknown as AsyncIterable<OpenCodeEvent>;
    }

    return null;
  } catch (error) {
    console.error("[opencode-client] Failed to subscribe to events:", error);
    return null;
  }
}

/**
 * Get list of existing sessions
 */
export async function listSessions(client: OpencodeClient): Promise<OpenCodeSession[]> {
  try {
    const response = await client.session.list();
    if (!response.data) return [];

    return response.data.map((session): OpenCodeSession => {
      const createdTime = session.time?.created;
      const createdAt: string = typeof createdTime === "number"
        ? new Date(createdTime).toISOString()
        : createdTime || new Date().toISOString();

      return {
        id: session.id,
        title: session.title,
        createdAt,
      };
    });
  } catch (error) {
    console.error("[opencode-client] Failed to list sessions:", error);
    throw error instanceof Error
      ? error
      : new Error("Failed to list OpenCode sessions");
  }
}

/**
 * Delete a session
 */
export async function deleteSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    await client.session.delete({
      sessionID: sessionId,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to delete session:", error);
    return false;
  }
}

/**
 * Abort a running session/prompt
 */
export async function abortSession(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    await client.session.abort({
      sessionID: sessionId,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to abort session:", error);
    return false;
  }
}

/**
 * Get pending question requests
 */
export async function getPendingQuestions(
  client: OpencodeClient,
  options: { throwOnError?: boolean } = {},
): Promise<QuestionRequest[]> {
  try {
    const response = await client.question.list(undefined, {
      throwOnError: options.throwOnError,
    });
    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get pending OpenCode questions",
          response.error,
        );
      }
      return [];
    }
    return response.data as QuestionRequest[];
  } catch (error) {
    console.error("[opencode-client] Failed to get pending questions:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending OpenCode questions");
    }
    return [];
  }
}

/**
 * Get pending permission requests
 */
export async function getPendingPermissions(
  client: OpencodeClient,
  options: { throwOnError?: boolean } = {},
): Promise<PermissionRequest[]> {
  try {
    const response = await client.permission.list(undefined, {
      throwOnError: options.throwOnError,
    });
    if (!response.data) {
      if (options.throwOnError) {
        throw openCodeResponseError(
          "Failed to get pending OpenCode permissions",
          response.error,
        );
      }
      return [];
    }
    return response.data as PermissionRequest[];
  } catch (error) {
    console.error("[opencode-client] Failed to get pending permissions:", error);
    if (options.throwOnError) {
      throw error instanceof Error
        ? error
        : new Error("Failed to get pending OpenCode permissions");
    }
    return [];
  }
}

/**
 * Reply to a question request
 * @param client The SDK client
 * @param requestId The question request ID
 * @param answers Array of answers (each answer is an array of selected option labels or typed text)
 */
export async function replyToQuestion(
  client: OpencodeClient,
  requestId: string,
  answers: QuestionAnswer[]
): Promise<boolean> {
  try {
    await client.question.reply({
      requestID: requestId,
      answers,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to reply to question:", error);
    return false;
  }
}

/**
 * Reply to a permission request
 */
export async function replyToPermission(
  client: OpencodeClient,
  requestId: string,
  reply: PermissionReply,
  message?: string
): Promise<boolean> {
  try {
    await client.permission.reply({
      requestID: requestId,
      reply,
      message,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to reply to permission:", error);
    return false;
  }
}

/**
 * Reject/dismiss a question request
 */
export async function rejectQuestion(
  client: OpencodeClient,
  requestId: string
): Promise<boolean> {
  try {
    await client.question.reject({
      requestID: requestId,
    });
    return true;
  } catch (error) {
    console.error("[opencode-client] Failed to reject question:", error);
    return false;
  }
}

import { type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createUuid } from "./uuid";
import {
  structuredOutputFailure,
  type JsonSchema,
  type StructuredOutputResult,
  StructuredOutputReadUnavailableError,
} from "@orkestrator/protocol/structured-output";
import {
  boundedOpenCodeMessageHistory,
  findOpenCodeMessageId,
  OPEN_CODE_MESSAGE_HISTORY_LIMIT,
  OpenCodeMessageIdCoordinator,
  openCodeRequestMarker,
} from "@orkestrator/protocol/opencode-message-id";
import type { ContextUsageSnapshot } from "./context-usage";

import {
  OPENCODE_MESSAGE_ABORTED_ERROR,
  firstNonEmptyString,
  formatOpenCodeError,
  isRecord,
  toIsoTimestamp,
  type OpenCodeConversationMode,
  type OpenCodeMessage,
  type OpenCodeModel,
  type OpenCodeSession,
} from "./opencode-types";

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
  /** Stable OpenCode user-message id for structured-output reconciliation. */
  requestId?: string;
}

function assertNoTraversalSegments(segments: string[]): void {
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Attachment path must not contain traversal segments");
  }
}

/**
 * Construct a file URL without letting URL parsing reinterpret filesystem
 * characters such as `#`, `?`, or percent-encoded dot segments.
 *
 * `URL.pathname = path` is not suitable here: pathname assignment treats `%`
 * sequences as URL escapes and normalizes `%2e%2e` before serializing. Encoding
 * each filesystem segment first preserves the selected filename exactly.
 */
function filePathToUrl(path: string): string {
  if (path.includes("\0")) {
    throw new Error("Attachment path must not contain null bytes");
  }

  const windowsDriveMatch = /^([A-Za-z]:)[\\/](.*)$/.exec(path);
  if (windowsDriveMatch) {
    const segments = (windowsDriveMatch[2] ?? "").split(/[\\/]/);
    assertNoTraversalSegments(segments);
    const encodedPath = segments.map(encodeURIComponent).join("/");
    return `file:///${windowsDriveMatch[1]}/${encodedPath}`;
  }

  if (!path.startsWith("/")) {
    throw new Error("Attachment path must be absolute");
  }

  const segments = path.split("/");
  assertNoTraversalSegments(segments);
  return `file://${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Splits a model id into its provider half and its model half.
 *
 * Model ids are built as `${provider.id}/${modelId}` and the model id may itself
 * contain slashes (openrouter-style `openrouter/anthropic/claude-…`), so only
 * the **first** slash separates the two. `split("/")` and a destructure silently
 * truncate such an id to its middle segment and send the wrong model.
 *
 * Returns null when there is no slash at all; each caller decides what a bare id
 * means, because they disagree — see {@link toOpenCodeModelRef} and
 * {@link splitOpenCodeModelId}.
 */
function splitModelIdOnFirstSlash(
  model: string,
): { providerHalf: string; modelHalf: string } | null {
  const separator = model.indexOf("/");
  if (separator === -1) return null;
  return {
    providerHalf: model.slice(0, separator),
    modelHalf: model.slice(separator + 1),
  };
}

/**
 * Builds the `{ providerID, modelID }` pair `session.promptAsync` expects.
 *
 * A bare id with no slash is deliberately sent as *both* halves, which is the
 * long-standing behaviour of this path — the server resolves it. The store's
 * `"default"` sentinel never reaches here: the native-agent runtime maps it to
 * `undefined` before calling, so this helper only ever sees a real id.
 */
function toOpenCodeModelRef(model: string): { providerID: string; modelID: string } {
  const split = splitModelIdOnFirstSlash(model);
  if (!split) return { providerID: model, modelID: model };
  return {
    providerID: split.providerHalf || "",
    modelID: split.modelHalf || model,
  };
}

const openCodeMessageIdsByClient = new WeakMap<object, OpenCodeMessageIdCoordinator>();

function openCodeMessageIds(client: OpencodeClient): OpenCodeMessageIdCoordinator {
  const key = client as object;
  const existing = openCodeMessageIdsByClient.get(key);
  if (existing) return existing;
  const created = new OpenCodeMessageIdCoordinator();
  openCodeMessageIdsByClient.set(key, created);
  return created;
}

async function withCallerOwnedOpenCodeMessageId<T>(
  client: OpencodeClient,
  sessionId: string,
  requestId: string | undefined,
  operation: (messageId: string | undefined) => Promise<T>,
): Promise<T> {
  if (requestId === undefined) return operation(undefined);
  // Validate before provider I/O so a malformed local ID cannot be mistaken for
  // an ambiguous dispatch.
  openCodeRequestMarker(requestId);
  const coordinator = openCodeMessageIds(client);
  return coordinator.runExclusive(sessionId, async () => {
    const response = await client.session.messages(
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      { throwOnError: false },
    );
    if (response.error) {
      throw new Error(formatOpenCodeError(response.error));
    }
    const history = boundedOpenCodeMessageHistory(response.data);
    // History is authoritative across renderer reloads. The bounded in-memory
    // reservation closes the interval before a just-accepted message appears.
    const messageId = coordinator.resolve(sessionId, history, requestId);
    return operation(messageId);
  });
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
    outputSchema?: JsonSchema;
    structuredOutputRetryCount?: number;
    requestId?: string;
    command?: {
      name: string;
      arguments?: string;
    };
    agent?: string;
    directory?: string;
  },
): Promise<SendPromptResult> {
  try {
    // Build the parts array with proper typing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [{ type: "text" as const, text: message }];

    if (options?.attachments) {
      for (const attachment of options.attachments) {
        // SDK FilePartInput requires: type, mime, url
        // Determine MIME type based on attachment type and filename
        let mime = "application/octet-stream";
        const ext = attachment.filename?.split(".").pop()?.toLowerCase();
        if (attachment.type === "image") {
          mime = "image/png"; // Default for clipboard images
          if (ext === "jpg" || ext === "jpeg") {
            mime = "image/jpeg";
          } else if (ext === "gif") {
            mime = "image/gif";
          } else if (ext === "webp") {
            mime = "image/webp";
          }
        } else if (attachment.filename) {
          // Try to infer MIME type from filename for files
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
        const url = attachment.dataUrl || filePathToUrl(attachment.path);

        parts.push({
          type: "file" as const,
          mime,
          url,
          filename: attachment.filename,
        });
      }
    }

    const requestId = options?.outputSchema
      ? (options.requestId ?? createUuid())
      : options?.requestId;
    const response = await withCallerOwnedOpenCodeMessageId(
      client,
      sessionId,
      requestId,
      async (messageID) =>
        options?.command
          ? client.session.command({
              sessionID: sessionId,
              directory: options.directory,
              messageID,
              command: options.command.name.replace(/^\//, ""),
              // `arguments` is a *required* field on the server's command request
              // body, so a bare `/init` must still send an empty string. Passing
              // `undefined` drops the key in `JSON.stringify` and the server answers
              // 400 — which the caller reads as a failed send and then deletes the
              // user's own message from the transcript.
              arguments: options.command.arguments ?? "",
              model: options.model,
              agent: options.agent ?? options.mode,
              variant: options.variant,
              parts: parts.filter((part) => part.type === "file"),
            })
          : client.session.promptAsync({
              sessionID: sessionId,
              directory: options?.directory,
              messageID,
              parts,
              model: options?.model ? toOpenCodeModelRef(options.model) : undefined,
              agent: options?.agent ?? options?.mode,
              variant: options?.variant,
              format: options?.outputSchema
                ? {
                    type: "json_schema",
                    schema: options.outputSchema,
                    retryCount: options.structuredOutputRetryCount,
                  }
                : undefined,
            }),
    );

    if (response && "error" in response && response.error) {
      return {
        success: false,
        requestId,
        error: formatOpenCodeError(response.error),
      };
    }

    if (requestId !== undefined) {
      openCodeMessageIds(client).markAccepted(sessionId, requestId);
    }

    return { success: true, requestId };
  } catch (error) {
    console.error("[opencode-client] Failed to send prompt:", error);
    return {
      success: false,
      error: formatOpenCodeError(error),
    };
  }
}

export interface OpenCodeAgent {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  native?: boolean;
  hidden?: boolean;
  modelId?: string;
  variant?: string;
}

export interface OpenCodeRuntimeHealth {
  agents: OpenCodeAgent[];
  skills: Array<{ name: string; description?: string; location?: string }>;
  mcpServers: Array<{ name: string; status: string; error?: string }>;
  lspServers: Array<{ id: string; name: string; root: string; status: string }>;
  formatters: Array<{ name: string; enabled: boolean; extensions: string[] }>;
  todos?: Array<{ content: string; status: string; priority: string }>;
  diffs?: Array<{
    file?: string;
    patch?: string;
    additions: number;
    deletions: number;
    status?: "added" | "deleted" | "modified";
  }>;
  fetchedAt: string;
}

type OpenCodeProviderUsage = NonNullable<OpenCodeMessage["providerUsage"]>;

/**
 * Tokens this turn occupies in the context window.
 *
 * `totalTokens` is the provider's own figure when it reports one; the sum is the
 * fallback. A reported `0` is not trusted as a total — the SDK zero-initialises
 * `tokens` on an in-flight assistant message, so a literal zero means "not
 * counted yet", not "this turn was free".
 */
function openCodeTurnTokens(turn: OpenCodeProviderUsage): number {
  if (typeof turn.totalTokens === "number" && turn.totalTokens > 0) {
    return turn.totalTokens;
  }
  return turn.inputTokens + turn.outputTokens + turn.cacheReadTokens;
}

export function summarizeOpenCodeUsage(
  messages: OpenCodeMessage[],
  models: OpenCodeModel[],
): ContextUsageSnapshot | null {
  const turns = messages
    .map((message) => message.providerUsage)
    .filter((usage): usage is OpenCodeProviderUsage => !!usage);
  // `AssistantMessage.tokens` is required and zero-initialised while the turn
  // streams, so the in-flight turn always carries an all-zero usage block.
  // Anchoring on `turns.at(-1)` would therefore collapse the reading to 0% for
  // the whole duration of every turn. Anchor on the last turn that actually
  // reported tokens instead; the session-level reduce below is unaffected
  // because an all-zero turn contributes nothing to any sum.
  const latest = turns.findLast((turn) => openCodeTurnTokens(turn) > 0);
  if (!latest) return null;

  const model = models.find((candidate) => candidate.id === latest.modelId);
  const contextWindow = model?.contextWindow;
  // Without a catalogue context window there is no denominator. Synthesising one
  // from the used tokens would report exactly 100% for every model missing from
  // the catalogue — including every mount before the async model list arrives.
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }

  const session = turns.reduce(
    (sum, turn) => ({
      cost: sum.cost + turn.cost,
      input: sum.input + turn.inputTokens,
      output: sum.output + turn.outputTokens,
      reasoning: sum.reasoning + turn.reasoningTokens,
      cacheRead: sum.cacheRead + turn.cacheReadTokens,
      cacheWrite: sum.cacheWrite + turn.cacheWriteTokens,
      duration: sum.duration + (turn.durationMs ?? 0),
    }),
    {
      cost: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      duration: 0,
    },
  );
  const usedTokens = openCodeTurnTokens(latest);

  return {
    usedTokens,
    totalTokens: contextWindow,
    percentUsed: Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100)),
    modelId: latest.modelId,
    inputTokens: session.input,
    outputTokens: session.output,
    cacheReadTokens: session.cacheRead,
    cacheWriteTokens: session.cacheWrite,
    reasoningTokens: session.reasoning,
    lastTurnTokens: usedTokens,
    sessionTokens: session.input + session.output + session.cacheRead + session.cacheWrite,
    costUsd: session.cost,
    durationMs: session.duration,
    // Provider-exact counters against a catalogue context window: never inferred.
    estimated: false,
    source: "opencode",
    updatedAt: new Date().toISOString(),
  };
}

export async function getOpenCodeRuntimeHealth(
  client: OpencodeClient,
  directory?: string,
  sessionId?: string,
): Promise<OpenCodeRuntimeHealth> {
  // Some managed OpenCode installations and test doubles expose only a subset of
  // the v2 surface. Defer each lookup into its own promise so a missing namespace
  // becomes one unavailable capability rather than aborting the whole snapshot.
  const attempt = <T>(operation: () => Promise<T>): Promise<T> => Promise.resolve().then(operation);
  const [agents, skills, mcp, lsp, formatters, todos, diffs] = await Promise.allSettled([
    attempt(() => client.app.agents({ directory })),
    attempt(() => client.app.skills({ directory })),
    attempt(() => client.mcp.status({ directory })),
    attempt(() => client.lsp.status({ directory })),
    attempt(() => client.formatter.status({ directory })),
    sessionId
      ? attempt(() => client.session.todo({ sessionID: sessionId, directory }))
      : Promise.resolve({ data: [] }),
    sessionId
      ? attempt(() => client.session.diff({ sessionID: sessionId, directory }))
      : Promise.resolve({ data: [] }),
  ]);

  const data = <T>(result: PromiseSettledResult<{ data?: T }>, fallback: T): T =>
    result.status === "fulfilled" && result.value.data !== undefined ? result.value.data : fallback;
  const mcpData = data<Record<string, { status?: string; error?: string }>>(mcp, {});

  return {
    agents: data<
      Array<{
        name: string;
        description?: string;
        mode: "subagent" | "primary" | "all";
        native?: boolean;
        hidden?: boolean;
        model?: { providerID: string; modelID: string };
        variant?: string;
      }>
    >(agents, [])
      .filter((agent) => !agent.hidden)
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        native: agent.native,
        hidden: agent.hidden,
        modelId: agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : undefined,
        variant: agent.variant,
      })),
    skills: data<Array<{ name: string; description?: string; location?: string }>>(skills, []),
    mcpServers: Object.entries(mcpData).map(([name, status]) => ({
      name,
      status: status.status ?? "unknown",
      error: status.error,
    })),
    lspServers: data<Array<{ id: string; name: string; root: string; status: string }>>(lsp, []),
    formatters: data<Array<{ name: string; enabled: boolean; extensions: string[] }>>(
      formatters,
      [],
    ),
    todos: data<Array<{ content: string; status: string; priority: string }>>(todos, []),
    diffs: data<
      Array<{
        file?: string;
        patch?: string;
        additions: number;
        deletions: number;
        status?: "added" | "deleted" | "modified";
      }>
    >(diffs, []),
    fetchedAt: new Date().toISOString(),
  };
}

export async function forkOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
  messageId?: string,
): Promise<OpenCodeSession> {
  const response = await client.session.fork(
    {
      sessionID: sessionId,
      messageID: messageId,
    },
    { throwOnError: true },
  );
  if (!response.data) {
    throw new Error("OpenCode returned an empty fork response");
  }
  const createdAt = toIsoTimestamp(response.data.time?.created) ?? new Date().toISOString();

  return {
    id: response.data.id,
    title: response.data.title,
    createdAt,
    // A fork that has just been created has not been touched since.
    updatedAt: toIsoTimestamp(response.data.time?.updated) ?? createdAt,
  };
}

/**
 * Splits a stored model id into an *optional* provider/model override.
 *
 * Shares {@link splitModelIdOnFirstSlash} with the prompting path, but disagrees
 * with it about a bare id: compaction takes an override the server may ignore, so
 * anything that cannot name both halves is safer as "no override" than as a
 * half-specified one that would resolve a provider naming no model.
 *
 * `"default"` is the store's sentinel for "no explicit model" and the info-panel
 * caller passes the raw stored value straight through, so it is filtered here —
 * destructuring it yielded `providerID: "default", modelID: undefined`.
 */
export function splitOpenCodeModelId(model: string | undefined): {
  providerID?: string;
  modelID?: string;
} {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "default") return {};
  const split = splitModelIdOnFirstSlash(trimmed);
  if (!split || !split.providerHalf || !split.modelHalf) return {};
  return { providerID: split.providerHalf, modelID: split.modelHalf };
}

export async function compactOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
  model?: string,
): Promise<void> {
  const { providerID, modelID } = splitOpenCodeModelId(model);
  const response = await client.session.summarize(
    {
      sessionID: sessionId,
      providerID,
      modelID,
      auto: false,
    },
    { throwOnError: true },
  );
  void response;
}

export async function revertOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
  messageId?: string,
): Promise<void> {
  const response = await client.session.revert(
    {
      sessionID: sessionId,
      messageID: messageId,
    },
    { throwOnError: true },
  );
  void response;
}

export async function unrevertOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<void> {
  const response = await client.session.unrevert(
    {
      sessionID: sessionId,
    },
    { throwOnError: true },
  );
  void response;
}

export async function shareOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<string | undefined> {
  const response = await client.session.share(
    {
      sessionID: sessionId,
    },
    { throwOnError: true },
  );
  if (!response.data) {
    throw new Error("OpenCode returned an empty share response");
  }
  const share = (response.data as { share?: { url?: string } }).share;
  return share?.url;
}

export async function unshareOpenCodeSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<void> {
  const response = await client.session.unshare(
    {
      sessionID: sessionId,
    },
    { throwOnError: true },
  );
  void response;
}

/** Dispatch a constrained native OpenCode turn while leaving its tools enabled. */
export async function sendStructuredPrompt(
  client: OpencodeClient,
  sessionId: string,
  message: string,
  outputSchema: JsonSchema,
  options: {
    model?: string;
    variant?: string;
    mode?: OpenCodeConversationMode;
    attachments?: PromptAttachment[];
    retryCount?: number;
    requestId?: string;
  } = {},
): Promise<SendPromptResult> {
  return sendPrompt(client, sessionId, message, {
    ...options,
    outputSchema,
    structuredOutputRetryCount: options.retryCount,
  });
}

function openCodeStructuredFailure(
  error: unknown,
  requestId?: string,
): StructuredOutputResult<never> {
  const record = isRecord(error) ? error : {};
  const name = typeof record.name === "string" ? record.name : "";
  const data = isRecord(record.data) ? record.data : {};
  const message =
    firstNonEmptyString([data.message, record.message]) ??
    "OpenCode failed to produce structured output.";
  const retries = typeof data.retries === "number" ? data.retries : undefined;
  return structuredOutputFailure(
    "opencode",
    name === "StructuredOutputError"
      ? "schema_retry_exhausted"
      : name === OPENCODE_MESSAGE_ABORTED_ERROR
        ? "interrupted"
        : "provider_error",
    message,
    {
      requestId,
      retryable: true,
      details: retries === undefined ? undefined : { retries },
    },
  );
}

/**
 * Read a completed structured result from OpenCode's authoritative message
 * history. Ordinary text parts are deliberately never parsed as a fallback.
 */
export async function getStructuredOutput<T = unknown>(
  client: OpencodeClient,
  sessionId: string,
  requestId?: string,
): Promise<StructuredOutputResult<T> | null> {
  // Reject malformed correlation IDs before touching the authoritative
  // transcript. Falling back to the latest turn for an explicit blank ID could
  // associate an unrelated result with the caller's request.
  if (requestId !== undefined) openCodeRequestMarker(requestId);
  let response: { data?: unknown; error?: unknown };
  try {
    response = await client.session.messages(
      { sessionID: sessionId, limit: OPEN_CODE_MESSAGE_HISTORY_LIMIT },
      { throwOnError: false },
    );
  } catch (error) {
    throw new StructuredOutputReadUnavailableError(
      "opencode",
      error instanceof Error ? error.message : "Failed to read OpenCode structured output.",
      { requestId, cause: error },
    );
  }

  if (!response.data) {
    return response.error ? openCodeStructuredFailure(response.error, requestId) : null;
  }
  let boundedEntries: readonly unknown[];
  try {
    boundedEntries = boundedOpenCodeMessageHistory(response.data);
  } catch {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode returned malformed or oversized message history for structured output.",
      { requestId },
    );
  }
  if (boundedEntries.some((entry) => !isRecord(entry) || !isRecord(entry.info))) {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode returned malformed message history for structured output.",
      { requestId },
    );
  }

  const entries = boundedEntries as Array<{ info: Record<string, unknown> }>;
  const latestStructuredUserId = entries
    .filter((entry) => {
      const format = isRecord(entry.info.format) ? entry.info.format : {};
      return entry.info.role === "user" && format.type === "json_schema";
    })
    .at(-1)?.info.id;
  const providerMessageId =
    requestId === undefined ? undefined : findOpenCodeMessageId(entries, requestId);
  const expectedParentId =
    requestId === undefined
      ? typeof latestStructuredUserId === "string"
        ? latestStructuredUserId
        : undefined
      : providerMessageId;
  if (!expectedParentId) return null;
  // Keep the provider-neutral correlation ID on the public result. Only the
  // transcript lookup uses OpenCode's provider-qualified message ID.
  const resultRequestId = requestId ?? expectedParentId;

  const assistant = entries
    .filter((entry) => entry.info.role === "assistant" && entry.info.parentID === expectedParentId)
    .at(-1);
  if (!assistant) return null;
  if (assistant.info.error) {
    return openCodeStructuredFailure(assistant.info.error, resultRequestId);
  }
  if (!isRecord(assistant.info.time)) {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode returned malformed assistant timing data.",
      { requestId: resultRequestId },
    );
  }
  if (!assistant.info.time.completed) return null;
  if (assistant.info.structured === undefined) {
    return structuredOutputFailure(
      "opencode",
      "malformed_output",
      "OpenCode completed the turn without a structured result.",
      { requestId: resultRequestId },
    );
  }
  return {
    ok: true,
    provider: "opencode",
    requestId: resultRequestId,
    value: assistant.info.structured as T,
  };
}

/** Event types from OpenCode SSE stream */

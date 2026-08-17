import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";
import { openCodeModelDisplayLabel } from "@orkestrator/protocol/native-agent";

import {
  OPENCODE_MESSAGE_ABORTED_ERROR,
  PREFERRED_VARIANT_ORDER,
  isRecord,
  normalizeSlashCommandName,
  openCodeResponseError,
  resolveDefaultModelId,
  resolveDefaultVariant,
  toIsoTimestamp,
  type OpenCodeMessage,
  type OpenCodeMessagePart,
  type OpenCodeModel,
  type OpenCodeModelsResponse,
  type OpenCodeSession,
  type OpenCodeSlashCommand,
} from "./opencode-types";
import {
  mapOpenCodeParts,
  mergeOpenCodeSubagentTranscript,
  normalizeOpenCodeMessage,
} from "./opencode-messages";

function openCodeAuthHeaders(authToken?: string): Record<string, string> | undefined {
  if (!authToken) return undefined;
  return {
    // Direct loopback requests use the Basic header OpenCode supports.
    Authorization: `Basic ${globalThis.btoa(`opencode:${authToken}`)}`,
    // A remote Orkestrator gateway consumes Authorization for its own bearer
    // token. It translates this dedicated credential header back to Basic on
    // the authenticated server-side hop.
    "X-Orkestrator-OpenCode-Token": authToken,
  };
}

const openCodeClientConnections = new WeakMap<
  OpencodeClient,
  { baseUrl: string; authToken?: string }
>();

export function createClient(
  baseUrl: string,
  directory?: string,
  authToken?: string,
): OpencodeClient {
  const client = createOpencodeClient({
    baseUrl: resolveGatewayLoopbackBaseUrl(baseUrl),
    directory,
    headers: openCodeAuthHeaders(authToken),
  });
  openCodeClientConnections.set(client, { baseUrl, authToken });
  return client;
}

/**
 * Check server health.
 *
 * Mirrors claude-client's checkHealth. The SDK client does not expose its base
 * URL, so this takes the URL directly and probes the same GET /global/health
 * route the backend polls for readiness.
 */
export async function checkHealth(baseUrl: string, authToken?: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${resolveGatewayLoopbackBaseUrl(baseUrl)}/global/health`,
      { headers: openCodeAuthHeaders(authToken) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Validate a cached SDK client against the exact per-process credential it was
 * created with. This is the OpenCode equivalent of `checkHealth(client)` in
 * the Claude/Codex wrappers and prevents a server restart from leaving a
 * renderer stuck retrying an obsolete Basic password.
 */
export function checkClientHealth(client: OpencodeClient): Promise<boolean> {
  const connection = openCodeClientConnections.get(client);
  if (!connection) return Promise.resolve(false);
  return checkHealth(connection.baseUrl, connection.authToken);
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
          const contextWindow = m.limit?.context ?? m.contextWindow ?? m.context_window;

          // Image input support lives under capabilities.input.image on the
          // provider catalog. The server rejects image attachments to models
          // without it, so surface it on the model so the compose bar can warn
          // before the send instead of surfacing the server's raw error.
          const supportsImageInput =
            typeof m.capabilities?.input?.image === "boolean"
              ? m.capabilities.input.image
              : undefined;

          // Variants are provider/model specific (e.g. low/high/xhigh)
          // Response shape: variants: { [variantName]: { disabled?: boolean, ... } }
          const variantEntries = m.variants && typeof m.variants === "object"
            ? Object.entries(m.variants as Record<string, { disabled?: boolean }>)
            : [];

          const variants = variantEntries
            .filter(([, variantConfig]) => {
              if (!variantConfig || typeof variantConfig !== "object") return false;
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
            name: openCodeModelDisplayLabel(
              `${provider.id}/${modelId}`,
              modelName || modelId,
            ),
            provider: provider.id,
            variants: variants.length > 0 ? variants : undefined,
            inputCost: typeof inputCost === "number" ? inputCost : undefined,
            outputCost: typeof outputCost === "number" ? outputCost : undefined,
            // A non-positive window is not a window. Keeping a `0` here would
            // reach `summarizeOpenCodeUsage` and produce `0/0` -> `NaN%`.
            contextWindow:
              typeof contextWindow === "number"
              && Number.isFinite(contextWindow)
              && contextWindow > 0
                ? contextWindow
                : undefined,
            supportsImageInput,
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

  const createdAt = toIsoTimestamp(response.data.time?.created)
    ?? new Date().toISOString();

  return {
    id: response.data.id,
    title: response.data.title,
    createdAt,
    // A session that has just been created has not been touched since.
    updatedAt: toIsoTimestamp(response.data.time?.updated) ?? createdAt,
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

/**
 * Whether a child transcript ended in a genuine failure.
 *
 * An intentionally interrupted turn also carries an error, but stopping a turn
 * is not a subagent failure — and the "failure" state latches in
 * {@link mergeOpenCodeSubagentTranscript}, so treating one as such would leave
 * the Agent row red permanently.
 */
function hasOpenCodeAssistantError(messages: OpenCodeMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant"
      && message.hasError === true
      && message.errorName !== OPENCODE_MESSAGE_ABORTED_ERROR,
  );
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

export type OpenCodeSessionStatusLookupResult =
  | { kind: "found"; status: OpenCodeSessionStatus }
  | { kind: "missing" }
  | { kind: "unavailable"; error: Error };

/**
 * Read the current server-side status for one session. The v2 SDK returns a
 * map for every session, so callers can distinguish a missing session from an
 * unavailable status channel.
 */
export async function lookupSessionStatus(
  client: OpencodeClient,
  sessionId: string,
): Promise<OpenCodeSessionStatusLookupResult> {
  try {
    const response = await client.session.status();
    if (!response.data) {
      return {
        kind: "unavailable",
        error: openCodeResponseError(
          "Failed to get OpenCode session status",
          response.error,
        ),
      };
    }

    const status = response.data[sessionId];
    if (status === undefined) {
      return { kind: "missing" };
    }
    if (
      status?.type !== "idle" &&
      status?.type !== "busy" &&
      status?.type !== "retry"
    ) {
      return {
        kind: "unavailable",
        error: new Error("OpenCode session status response was malformed"),
      };
    }
    return { kind: "found", status: status.type };
  } catch (error) {
    return {
      kind: "unavailable",
      error: error instanceof Error
        ? error
        : new Error("Failed to get OpenCode session status"),
    };
  }
}

/**
 * Retains the legacy null-on-missing-or-unavailable behavior. Reconciliation
 * callers should use lookupSessionStatus so outages do not look like deletion.
 */
export async function getSessionStatus(
  client: OpencodeClient,
  sessionId: string,
  options: { throwOnError?: boolean } = {},
): Promise<OpenCodeSessionStatus | null> {
  const result = await lookupSessionStatus(client, sessionId);
  if (result.kind === "found") return result.status;
  if (result.kind === "unavailable") {
    console.error("[opencode-client] Failed to get session status:", result.error);
    if (options.throwOnError) throw result.error;
  }
  return null;
}

/** Attachment input for sendPrompt */


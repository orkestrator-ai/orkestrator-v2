import {
  createHash,
  AGENT_INTERACTION_ORIGINS,
  isAgentInteractionPolicy,
  isAgentSkillProvider,
  resolveGitHubRepository,
  isStartFeaturePlanningInput,
  assertValidPromptAttachments,
  assertValidPromptImages,
} from "./commands-dependencies.js";
import type {
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AppConfig,
  CodexModelCatalogEntry,
  CodexReasoningEffort,
  EnvironmentType,
  OpenCodeModelCatalogEntry,
  PortMapping,
  AgentSkillProvider,
  JsonRecord,
  StorageService,
  GitHubIssueStatus,
  GitHubRepositoryRef,
  NativeAgentControlUpdate,
  NativeAgentSessionAction,
  DispatchNativeAgentPromptInput,
  FeaturePlanningService,
  FeaturePlanningKind,
  StartFeaturePlanningInput,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";

export const UNTRACKED_SCAN_CONCURRENCY = 8;
/**
 * Untracked files line-counted per scan before the result is marked truncated.
 *
 * Generous enough that an ordinary worktree never reaches it, low enough that a
 * directory of build output cannot turn one change signal into tens of
 * thousands of file reads.
 */
export const UNTRACKED_SCAN_MAX_FILES = 2_000;
/** Read window for line counting; matches the container scanner's buffer. */
export const FILE_LINE_COUNT_CHUNK_BYTES = 64 * 1024;

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${name} to be a string`);
  return value;
}

export function asRecord(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${name} to be an object`);
  }
  return value as JsonRecord;
}

export function asOptionalAgentInteractionOrigin(
  value: unknown,
): AgentInteractionOrigin | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !AGENT_INTERACTION_ORIGINS.includes(value as AgentInteractionOrigin)
  ) {
    throw new Error("Expected origin to be a supported agent interaction origin");
  }
  return value as AgentInteractionOrigin;
}

export function asOptionalAgentInteractionPolicy(
  value: unknown,
): AgentInteractionPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isAgentInteractionPolicy(value)) {
    throw new Error("Expected interactionPolicy to be a valid agent interaction policy");
  }
  return value;
}

export function asAgentSkillProvider(value: unknown): AgentSkillProvider {
  if (!isAgentSkillProvider(value)) {
    throw new Error("Expected provider to be claude, codex, cursor, grok or opencode");
  }
  return value;
}

export function assertOnlyKeys(value: JsonRecord, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`Unexpected ${name} field: ${unexpected}`);
}

export async function requireLinearApiKey(context: CommandContext): Promise<string> {
  const auth = await context.storage.getLinearAuth();
  if (!auth?.apiKey) throw new Error("Linear is not connected");
  return auth.apiKey;
}

export async function requireGitHubProject(
  context: CommandContext,
  projectId: string,
): Promise<{ token: string; repository: GitHubRepositoryRef }> {
  const [project, config] = await Promise.all([
    context.storage.getProject(projectId),
    context.storage.loadConfig(),
  ]);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const token = config.global.githubToken?.trim();
  if (!token) {
    throw new Error(
      "GitHub is not configured. Add a global GitHub token in Settings and try again.",
    );
  }
  return { token, repository: resolveGitHubRepository(project.gitUrl) };
}

export type RendererGlobalConfig = Omit<
  AppConfig["global"],
  "githubToken" | "anthropicApiKey" | "cursorApiKey"
> & {
  githubTokenConfigured: boolean;
  anthropicApiKeyConfigured: boolean;
  anthropicApiKeySource: ApiKeySource;
  cursorApiKeyConfigured: boolean;
  cursorApiKeySource: ApiKeySource;
};

export type RendererAppConfig = Omit<AppConfig, "global"> & {
  global: RendererGlobalConfig;
};

/**
 * Where the key a new container would receive actually comes from. The stored
 * key is write-only, so `cursorApiKeyConfigured` alone cannot tell the settings
 * pane that a container is being handed a key inherited from this process's own
 * environment — and clearing the stored key does not stop that one.
 */
export type ApiKeySource = "config" | "host-env" | "none";

export function resolveStoredOrInheritedApiKey(
  configuredValue: string | undefined,
  inheritedValue: string | undefined,
): { apiKey?: string; source: ApiKeySource } {
  const configured = configuredValue?.trim();
  if (configured) return { apiKey: configured, source: "config" };
  const inherited = inheritedValue?.trim();
  if (inherited) return { apiKey: inherited, source: "host-env" };
  return { source: "none" };
}

export function resolveAnthropicApiKey(global: AppConfig["global"]): {
  apiKey?: string;
  source: ApiKeySource;
} {
  return resolveStoredOrInheritedApiKey(global.anthropicApiKey, process.env.ANTHROPIC_API_KEY);
}

/**
 * Single source of truth for the Cursor key. `createDockerContainer` forwards
 * `apiKey`; the renderer is told only `source`, never the value.
 */
export function resolveCursorApiKey(global: AppConfig["global"]): {
  apiKey?: string;
  source: ApiKeySource;
} {
  return resolveStoredOrInheritedApiKey(global.cursorApiKey, process.env.CURSOR_API_KEY);
}

export function cursorApiKeyFingerprint(apiKey: string | undefined): string {
  return createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex");
}

export function redactGlobalConfig(global: AppConfig["global"]): RendererGlobalConfig {
  const { source: anthropicApiKeySource } = resolveAnthropicApiKey(global);
  const { source: cursorApiKeySource } = resolveCursorApiKey(global);
  const { githubToken, anthropicApiKey, cursorApiKey, ...safeGlobal } = global;
  return {
    ...safeGlobal,
    githubTokenConfigured: Boolean(githubToken?.trim()),
    anthropicApiKeyConfigured: Boolean(anthropicApiKey?.trim()),
    anthropicApiKeySource,
    cursorApiKeyConfigured: Boolean(cursorApiKey?.trim()),
    cursorApiKeySource,
  };
}

export function redactAppConfig(config: AppConfig): RendererAppConfig {
  return {
    ...config,
    global: redactGlobalConfig(config.global),
  };
}

export function stripRendererCredentials(global: Record<string, unknown>): AppConfig["global"] {
  const {
    githubToken: _ignoredToken,
    githubTokenConfigured: _ignoredConfigured,
    anthropicApiKey: _ignoredAnthropicApiKey,
    anthropicApiKeyConfigured: _ignoredAnthropicConfigured,
    anthropicApiKeySource: _ignoredAnthropicSource,
    cursorApiKey: _ignoredCursorApiKey,
    cursorApiKeyConfigured: _ignoredCursorConfigured,
    cursorApiKeySource: _ignoredCursorSource,
    ...safeGlobal
  } = global;
  return safeGlobal as AppConfig["global"];
}

export function asGitHubIssueStatus(value: unknown): GitHubIssueStatus {
  if (value === "backlog" || value === "todo" || value === "inprogress" || value === "review") {
    return value;
  }
  throw new Error("Expected status to be backlog, todo, inprogress, or review");
}

export const linearCompletionCommentLocks = new Map<string, Promise<unknown>>();
export const githubCompletionCommentLocks = new Map<string, Promise<unknown>>();

export async function withLinearCompletionCommentLock<T>(
  pipelineId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = linearCompletionCommentLocks.get(pipelineId) ?? Promise.resolve();
  const current = previous.then(task);
  linearCompletionCommentLocks.set(pipelineId, current);
  try {
    return await current;
  } finally {
    if (linearCompletionCommentLocks.get(pipelineId) === current) {
      linearCompletionCommentLocks.delete(pipelineId);
    }
  }
}

export async function withGitHubCompletionCommentLock<T>(
  pipelineId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = githubCompletionCommentLocks.get(pipelineId) ?? Promise.resolve();
  const current = previous.then(task);
  githubCompletionCommentLocks.set(pipelineId, current);
  try {
    return await current;
  } finally {
    if (githubCompletionCommentLocks.get(pipelineId) === current) {
      githubCompletionCommentLocks.delete(pipelineId);
    }
  }
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Boolean argument that must be supplied. Use this instead of `asBoolean` when
 * the fallback would silently destroy state — a malformed call should fail, not
 * be read as `false`.
 */
export function asRequiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Expected ${name} to be a boolean`);
  return value;
}

export function asNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Expected ${name} to be a number`);
  return value;
}

export function asPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Expected ${name} to be a positive integer`);
  }
  return value as number;
}

export function asTerminalDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function asNonBlankString(value: unknown, name: string): string {
  const normalized = asString(value, name).trim();
  if (!normalized) throw new Error(`Expected ${name} to be a non-blank string`);
  return normalized;
}

/**
 * Longest execution-profile / subagent id accepted from a client.
 *
 * These are provider agent names (`build`, `plan`, a user's own primary agent),
 * and the renderer already refuses anything longer. The bound matters because
 * the id is persisted to `native-agent-sessions.json` and forwarded verbatim as
 * the provider's `agent` name, and it is not always checked against a listing:
 * an update that arrives before the listing does is accepted on the fallback
 * ids alone.
 */
export const MAX_EXECUTION_PROFILE_ID_LENGTH = 256;

export function asBoundedNonBlankString(value: unknown, name: string, maxLength: number): string {
  const normalized = asNonBlankString(value, name);
  if (normalized.length > maxLength) {
    throw new Error(`Expected ${name} to be at most ${maxLength} characters`);
  }
  return normalized;
}

export function asDispatchNativeAgentPromptInput(args: JsonRecord): DispatchNativeAgentPromptInput {
  const agent = asString(args.agent, "agent") as import("./models.js").NativeAgentProvider;
  return {
    environmentId: asNonBlankString(args.environmentId, "environmentId"),
    agent,
    logicalSessionKey: asNonBlankString(args.logicalSessionKey, "logicalSessionKey"),
    origin: asOptionalAgentInteractionOrigin(args.origin),
    interactionPolicy: asOptionalAgentInteractionPolicy(args.interactionPolicy),
    title: typeof args.title === "string" ? args.title : undefined,
    model: typeof args.model === "string" ? args.model : undefined,
    reasoningEffort: typeof args.reasoningEffort === "string" ? args.reasoningEffort : undefined,
    phase:
      typeof args.phase === "string"
        ? (args.phase as import("@orkestrator/protocol/build-pipeline").PipelineSessionPhase)
        : undefined,
    prompt: asNonBlankString(args.prompt, "prompt"),
    requestId: asNonBlankString(args.requestId, "requestId"),
    images: Array.isArray(args.images) ? assertValidPromptImages(args.images) : undefined,
    attachments: Array.isArray(args.attachments)
      ? assertValidPromptAttachments(args.attachments)
      : undefined,
    schema:
      args.schema && typeof args.schema === "object" && !Array.isArray(args.schema)
        ? (args.schema as import("@orkestrator/protocol/structured-output").JsonSchema)
        : undefined,
    // Cursor/Grok preserve the ACP session's current mode unless explicit.
    mode:
      args.mode === "build"
        ? "build"
        : args.mode === "plan"
          ? "plan"
          : agent === "cursor" || agent === "grok"
            ? undefined
            : "plan",
    fastMode: typeof args.fastMode === "boolean" ? args.fastMode : undefined,
    subAgent: typeof args.subAgent === "string" ? args.subAgent : undefined,
    executionAgent: typeof args.executionAgent === "string" ? args.executionAgent : undefined,
    includeLocalSettings:
      typeof args.includeLocalSettings === "boolean" ? args.includeLocalSettings : undefined,
    promptSuggestions:
      typeof args.promptSuggestions === "boolean" ? args.promptSuggestions : undefined,
  };
}

export function asNativeAgentControlUpdate(
  value: unknown,
  name = "update",
): NativeAgentControlUpdate {
  const raw = asRecord(value, name);
  const allowed = new Set([
    "modelId",
    "reasoningId",
    "fastMode",
    "mode",
    "executionProfileId",
    "includeLocalSettings",
    "promptSuggestions",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error("Native agent control update has unknown fields");
  }
  let mode: NativeAgentControlUpdate["mode"];
  if (raw.mode !== undefined) {
    if (raw.mode !== "build" && raw.mode !== "plan") {
      throw new Error("Expected mode to be build or plan");
    }
    mode = raw.mode;
  }
  const update: NativeAgentControlUpdate = {
    ...(raw.modelId === undefined ? {} : { modelId: asNonBlankString(raw.modelId, "modelId") }),
    ...(raw.reasoningId === undefined
      ? {}
      : { reasoningId: asNonBlankString(raw.reasoningId, "reasoningId") }),
    ...(raw.fastMode === undefined
      ? {}
      : { fastMode: asRequiredBoolean(raw.fastMode, "fastMode") }),
    ...(mode === undefined ? {} : { mode }),
    ...(raw.executionProfileId === undefined
      ? {}
      : {
          executionProfileId:
            raw.executionProfileId === null
              ? null
              : asBoundedNonBlankString(
                  raw.executionProfileId,
                  "executionProfileId",
                  MAX_EXECUTION_PROFILE_ID_LENGTH,
                ),
        }),
    ...(raw.includeLocalSettings === undefined
      ? {}
      : {
          includeLocalSettings: asRequiredBoolean(raw.includeLocalSettings, "includeLocalSettings"),
        }),
    ...(raw.promptSuggestions === undefined
      ? {}
      : { promptSuggestions: asRequiredBoolean(raw.promptSuggestions, "promptSuggestions") }),
  };
  if (Object.keys(update).length === 0) {
    throw new Error("Native agent control update must not be empty");
  }
  return update;
}

export function asNativeAgentSessionAction(value: unknown): NativeAgentSessionAction {
  const raw = asRecord(value, "action");
  const kind = asNonBlankString(raw.kind, "action.kind");
  switch (kind) {
    case "compact":
      return {
        kind,
        ...(raw.modelId === undefined
          ? {}
          : { modelId: asNonBlankString(raw.modelId, "action.modelId") }),
      };
    case "rewind-files":
      return {
        kind,
        messageId: asNonBlankString(raw.messageId, "action.messageId"),
        ...(raw.dryRun === undefined
          ? {}
          : { dryRun: asRequiredBoolean(raw.dryRun, "action.dryRun") }),
      };
    case "undo":
      return {
        kind,
        ...(raw.messageId === undefined
          ? {}
          : { messageId: asNonBlankString(raw.messageId, "action.messageId") }),
      };
    case "redo":
    case "share":
    case "unshare":
    case "review":
      return { kind };
    case "steer":
      return {
        kind,
        text: asNonBlankString(raw.text, "action.text"),
        requestId: asNonBlankString(raw.requestId, "action.requestId"),
      };
    default:
      throw new Error("Native agent session action is invalid");
  }
}

export function asOpenCodeModelVariants(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${name} to be an array`);
  return value.map((variant, index) => asNonBlankString(variant, `${name}[${index}]`));
}

export function asOpenCodeModelCost(value: unknown, name: string): number {
  const cost = asNumber(value, name);
  if (cost < 0) throw new Error(`Expected ${name} to be non-negative`);
  return cost;
}

export function asOpenCodeContextWindow(value: unknown, name: string): number {
  const contextWindow = asNumber(value, name);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`Expected ${name} to be a positive safe integer`);
  }
  return contextWindow;
}

export function asOpenCodeModelCatalogEntry(
  candidate: unknown,
  name: string,
): OpenCodeModelCatalogEntry {
  const model = asRecord(candidate, name);
  assertOnlyKeys(
    model,
    [
      "id",
      "name",
      "provider",
      "variants",
      "inputCost",
      "outputCost",
      "contextWindow",
      "supportsImageInput",
    ],
    name,
  );
  return {
    id: asNonBlankString(model.id, `${name}.id`),
    name: asNonBlankString(model.name, `${name}.name`),
    provider: asNonBlankString(model.provider, `${name}.provider`),
    ...(model.variants === undefined
      ? {}
      : { variants: asOpenCodeModelVariants(model.variants, `${name}.variants`) }),
    ...(model.inputCost === undefined
      ? {}
      : { inputCost: asOpenCodeModelCost(model.inputCost, `${name}.inputCost`) }),
    ...(model.outputCost === undefined
      ? {}
      : { outputCost: asOpenCodeModelCost(model.outputCost, `${name}.outputCost`) }),
    ...(model.contextWindow === undefined
      ? {}
      : {
          contextWindow: asOpenCodeContextWindow(model.contextWindow, `${name}.contextWindow`),
        }),
    ...(model.supportsImageInput === undefined
      ? {}
      : typeof model.supportsImageInput === "boolean"
        ? { supportsImageInput: model.supportsImageInput }
        : (() => {
            throw new Error(`Expected ${name}.supportsImageInput to be a boolean`);
          })()),
  };
}

/**
 * Validate a discovered catalogue, dropping entries that fail rather than
 * rejecting the batch.
 *
 * The catalogue is best-effort cached data assembled from whatever a provider
 * reports, and the renderer only logs a rejection. Failing the whole call over
 * one rogue model — a `NaN` cost, a field added to `OpenCodeModel` upstream —
 * would silently disable caching for that project indefinitely. `StorageService`
 * already normalizes per entry; this matches it. A batch with nothing valid in
 * it is still an error, because that is a caller bug rather than one bad model.
 */
export function asOpenCodeModelCatalog(value: unknown): OpenCodeModelCatalogEntry[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected models to be an array");
  }
  if (value.length === 0) {
    throw new Error("OpenCode model catalogue must contain at least one model.");
  }

  const models: OpenCodeModelCatalogEntry[] = [];
  let firstRejection: string | undefined;
  value.forEach((candidate, index) => {
    try {
      const model = asOpenCodeModelCatalogEntry(candidate, `models[${index}]`);
      // OpenCode provider IDs are upstream-defined (Anthropic, OpenRouter,
      // local plugins, and others), not limited to the two first-party IDs.
      models.push(model);
    } catch (error) {
      firstRejection ??= error instanceof Error ? error.message : String(error);
    }
  });

  if (models.length === 0) {
    throw new Error(
      `OpenCode model catalogue must contain at least one model. ${firstRejection ?? ""}`.trim(),
    );
  }
  return models;
}

export const CODEX_MODEL_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export function asCodexReasoningEffort(value: unknown, name: string): CodexReasoningEffort {
  const effort = asNonBlankString(value, name) as CodexReasoningEffort;
  if (!CODEX_MODEL_REASONING_EFFORTS.has(effort)) {
    throw new Error(`Expected ${name} to be a supported reasoning effort`);
  }
  return effort;
}

export function asCachedCodexModels(value: unknown): CodexModelCatalogEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Codex model catalogue must contain at least one model.");
  }
  return value.map((candidate, index) => {
    const name = `models[${index}]`;
    const model = asRecord(candidate, name);
    assertOnlyKeys(
      model,
      [
        "id",
        "name",
        "description",
        "reasoningEfforts",
        "reasoningOptions",
        "defaultReasoningEffort",
      ],
      name,
    );
    const reasoningEfforts =
      model.reasoningEfforts === undefined
        ? undefined
        : Array.isArray(model.reasoningEfforts)
          ? model.reasoningEfforts.map((effort, effortIndex) =>
              asCodexReasoningEffort(effort, `${name}.reasoningEfforts[${effortIndex}]`),
            )
          : (() => {
              throw new Error(`Expected ${name}.reasoningEfforts to be an array`);
            })();
    const reasoningOptions =
      model.reasoningOptions === undefined
        ? undefined
        : Array.isArray(model.reasoningOptions)
          ? model.reasoningOptions.map((candidateOption, optionIndex) => {
              const optionName = `${name}.reasoningOptions[${optionIndex}]`;
              const option = asRecord(candidateOption, optionName);
              assertOnlyKeys(option, ["effort", "label", "description"], optionName);
              return {
                effort: asCodexReasoningEffort(option.effort, `${optionName}.effort`),
                label: asNonBlankString(option.label, `${optionName}.label`),
                ...(option.description === undefined
                  ? {}
                  : {
                      description: asNonBlankString(
                        option.description,
                        `${optionName}.description`,
                      ),
                    }),
              };
            })
          : (() => {
              throw new Error(`Expected ${name}.reasoningOptions to be an array`);
            })();
    return {
      id: asNonBlankString(model.id, `${name}.id`),
      name: asNonBlankString(model.name, `${name}.name`),
      ...(model.description === undefined
        ? {}
        : { description: asNonBlankString(model.description, `${name}.description`) }),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(reasoningOptions ? { reasoningOptions } : {}),
      ...(model.defaultReasoningEffort === undefined
        ? {}
        : {
            defaultReasoningEffort: asCodexReasoningEffort(
              model.defaultReasoningEffort,
              `${name}.defaultReasoningEffort`,
            ),
          }),
    };
  });
}

export function asFeaturePlanRole(value: unknown): "user" | "assistant" | "system" {
  if (value === "user" || value === "assistant" || value === "system") return value;
  throw new Error("Expected role to be user, assistant, or system");
}

export function asFeaturePlanningKind(value: unknown): FeaturePlanningKind {
  if (value === "feature" || value === "story") return value;
  throw new Error("Expected kind to be feature or story");
}

export function requireFeaturePlanning(context: CommandContext): FeaturePlanningService {
  if (!context.featurePlanning) {
    throw new Error("Feature planning supervisor is unavailable");
  }
  return context.featurePlanning;
}

export const FEATURE_PLAN_UPDATE_FIELDS = [
  "title",
  "status",
  "summary",
  "messages",
  "stories",
  "codexEnvironmentId",
  "codexSessionId",
  "buildTaskId",
  "buildPipelineId",
] as const;

export function asOptionalNonBlankFeaturePlanId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return asNonBlankString(value, name);
}

export function asFeaturePlanMessage(value: unknown, name: string): JsonRecord {
  const message = asRecord(value, name);
  assertOnlyKeys(
    message,
    ["id", "role", "content", "createdAt", "modelId", "stateApplication"],
    name,
  );
  const role = asFeaturePlanRole(message.role);
  const stateApplication = asFeaturePlanStateApplication(message.stateApplication);
  return {
    id: asNonBlankString(message.id, `${name}.id`),
    role,
    content: asString(message.content, `${name}.content`),
    createdAt: asNonBlankString(message.createdAt, `${name}.createdAt`),
    ...(message.modelId === undefined ? {} : { modelId: asFeaturePlanModelId(message.modelId) }),
    ...(stateApplication === undefined ? {} : { stateApplication }),
  };
}

export function asFeaturePlanMessages(value: unknown, name: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${name} to be an array`);
  return value.map((message, index) => asFeaturePlanMessage(message, `${name}[${index}]`));
}

export function asFeaturePlanStories(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error("Expected updates.stories to be an array");
  return value.map((candidate, index) => {
    const name = `updates.stories[${index}]`;
    const story = asRecord(candidate, name);
    assertOnlyKeys(
      story,
      ["id", "title", "description", "acceptanceCriteria", "messages", "createdAt", "updatedAt"],
      name,
    );
    if (!Array.isArray(story.acceptanceCriteria)) {
      throw new Error(`Expected ${name}.acceptanceCriteria to be an array`);
    }
    return {
      id: asNonBlankString(story.id, `${name}.id`),
      title: asString(story.title, `${name}.title`),
      description: asString(story.description, `${name}.description`),
      acceptanceCriteria: story.acceptanceCriteria.map((criterion, criterionIndex) =>
        asString(criterion, `${name}.acceptanceCriteria[${criterionIndex}]`),
      ),
      messages: asFeaturePlanMessages(story.messages, `${name}.messages`),
      createdAt: asNonBlankString(story.createdAt, `${name}.createdAt`),
      updatedAt: asNonBlankString(story.updatedAt, `${name}.updatedAt`),
    };
  });
}

export function asFeaturePlanUpdates(
  value: unknown,
): Parameters<StorageService["updateFeaturePlan"]>[1] {
  const updates = asRecord(value, "updates");
  assertOnlyKeys(updates, FEATURE_PLAN_UPDATE_FIELDS, "updates");
  const parsed: Record<string, unknown> = {};
  if (updates.title !== undefined) parsed.title = asString(updates.title, "updates.title");
  if (updates.summary !== undefined) parsed.summary = asString(updates.summary, "updates.summary");
  if (updates.status !== undefined) {
    if (
      updates.status !== "collecting" &&
      updates.status !== "confirming" &&
      updates.status !== "stories" &&
      updates.status !== "building" &&
      updates.status !== "built"
    ) {
      throw new Error("Expected updates.status to be a valid feature plan status");
    }
    parsed.status = updates.status;
  }
  if (updates.messages !== undefined) {
    parsed.messages = asFeaturePlanMessages(updates.messages, "updates.messages");
  }
  if (updates.stories !== undefined) {
    parsed.stories = asFeaturePlanStories(updates.stories);
  }
  for (const field of [
    "codexEnvironmentId",
    "codexSessionId",
    "buildTaskId",
    "buildPipelineId",
  ] as const) {
    if (Object.hasOwn(updates, field)) {
      parsed[field] = asOptionalNonBlankFeaturePlanId(updates[field], `updates.${field}`);
    }
  }
  return parsed as Parameters<StorageService["updateFeaturePlan"]>[1];
}

export function asStartFeaturePlanningInput(args: JsonRecord): StartFeaturePlanningInput {
  const input: StartFeaturePlanningInput = {
    featureId: asNonBlankString(args.featureId, "featureId"),
    kind: asFeaturePlanningKind(args.kind),
    ...(args.storyId === undefined ? {} : { storyId: asNonBlankString(args.storyId, "storyId") }),
    userMessage: asNonBlankString(args.userMessage, "userMessage"),
  };
  if (!isStartFeaturePlanningInput(input)) {
    throw new Error("Expected a valid bounded feature planning request");
  }
  return input;
}

export function asFeaturePlanStateApplication(
  value: unknown,
): "pending" | "applied" | "superseded" | undefined {
  if (value === undefined) return undefined;
  if (value === "pending" || value === "applied" || value === "superseded") {
    return value;
  }
  throw new Error("Expected stateApplication to be pending, applied, or superseded");
}

export function asFeaturePlanModelId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error("Expected modelId to be a non-empty string");
}

export function asPortMappings(value: unknown): PortMapping[] | undefined {
  return Array.isArray(value) ? (value as PortMapping[]) : undefined;
}

export function asEnvironmentType(value: unknown): EnvironmentType {
  return value === "local" ? "local" : "containerized";
}

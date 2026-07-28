import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  aggregateAgentActivityState,
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  AGENT_ACTIVITY_SOURCES,
  AGENT_ACTIVITY_STATES,
  FRONTEND_AGENT_ACTIVITY_LEASE_MS,
  isAgentActivityTimestamp,
  parseUsableAgentActivityTime,
} from "@orkestrator/protocol/agent-activity";
import {
  parseStoredDesktopConnections,
  type StoredDesktopConnections,
} from "@orkestrator/protocol/connections";
import {
  getReviewInstructionValidationError,
  parseReviewInstruction,
} from "@orkestrator/protocol/review-instruction";
import type { ResourceChange, ResourceKind } from "@orkestrator/protocol/resource-events";
import {
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  isValidCodexMaxConcurrentThreads,
  MAX_CODEX_CONCURRENT_THREADS,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";
import type {
  AgentActivityState,
  AgentActivitySource,
  AgentModelConfigKey,
  AppConfig,
  ClaudeModelCatalogSnapshot,
  Environment,
  EnvironmentStatus,
  EnvironmentType,
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalogSnapshot,
  PortMapping,
  PrState,
  Project,
  PersistedPaneLayout,
  PersistedLoopedReviewWorkflow,
  PersistedBuildPipeline,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
  PersistedAgentHandoff,
  RepositoryConfig,
  Session,
  SessionType,
} from "./models.js";

export type JsonRecord = Record<string, unknown>;

const MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS = 32;

type KanbanComment = {
  id: string;
  text: string;
  createdAt: string;
};

type KanbanImage = {
  id: string;
  filename: string;
  createdAt: string;
};

type KanbanStatus = "backlog" | "in-progress" | "review" | "done";

type KanbanTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: KanbanStatus;
  comments: KanbanComment[];
  images: KanbanImage[];
  createdAt: string;
  order: number;
  environmentId?: string;
  buildPipelineId?: string;
  prUrl?: string;
  prState?: PrState;
  prMergeCommented?: boolean;
};

type ProjectNotes = {
  projectId: string;
  content: string;
  updatedAt: string;
};

type FeaturePlanStatus = "collecting" | "confirming" | "stories" | "building" | "built";

type FeaturePlanMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  stateApplication?: "pending" | "applied" | "superseded";
};

type FeatureStoryCard = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  messages: FeaturePlanMessage[];
  createdAt: string;
  updatedAt: string;
};

type FeaturePlan = {
  id: string;
  projectId: string;
  title: string;
  status: FeaturePlanStatus;
  summary: string;
  messages: FeaturePlanMessage[];
  stories: FeatureStoryCard[];
  createdAt: string;
  updatedAt: string;
  order: number;
  codexEnvironmentId?: string;
  codexSessionId?: string;
  buildTaskId?: string;
  buildPipelineId?: string;
};

type LinearAuth = {
  apiKey: string;
  connectedAt: string;
  viewer?: {
    id: string;
    name: string;
    email?: string;
  };
};

type LinearCompletionComment = {
  pipelineId: string;
  issueId: string;
  status: "posted" | "failed";
  commentId?: string;
  postedAt?: string;
  error?: string;
  updatedAt: string;
};

export type GitHubCompletionComment = {
  pipelineId: string;
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  status: "posted" | "failed";
  commentId?: string;
  postedAt?: string;
  error?: string;
  updatedAt: string;
};

async function resizeKanbanImage(rawBytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(rawBytes).resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp().toBuffer();
}

const MAX_JSON_BACKUPS = 5;
const MAX_SESSIONS_PER_ENVIRONMENT = 20;

const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "api.github.com",
  "registry.npmjs.org",
  "bun.sh",
  "api.anthropic.com",
  "sentry.io",
  "statsig.anthropic.com",
  "statsig.com",
  "marketplace.visualstudio.com",
  "vscode.blob.core.windows.net",
  "update.code.visualstudio.com",
  "mcp.context7.com",
];

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultEnvironmentName(): string {
  const iso = nowIso();
  return [
    iso.slice(0, 4),
    iso.slice(5, 7),
    iso.slice(8, 10),
    "-",
    iso.slice(11, 13),
    iso.slice(14, 16),
    iso.slice(17, 19),
  ].join("");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInitialPromptImageAttachment(
  value: unknown,
): value is NonNullable<Environment["initialPromptAttachments"]>[number] {
  return isRecord(value)
    && isNonBlankString(value.id)
    && isNonBlankString(value.name)
    && typeof value.previewUrl === "string"
    && isNonBlankString(value.base64Data);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read back the persisted per-source snapshots, discarding any whose state or
 * timestamp no longer parses. A poisoned entry must not be able to pin the
 * aggregate, and dropping it here means every writer sees the same clean view.
 */
function readAgentActivitySources(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["agentActivitySources"]> {
  const sources: NonNullable<Environment["agentActivitySources"]> = {};
  for (const candidateSource of AGENT_ACTIVITY_SOURCES) {
    const snapshot = environment.agentActivitySources?.[candidateSource];
    if (!snapshot || !isOneOf(snapshot.state, AGENT_ACTIVITY_STATES)) continue;
    const snapshotTime = parseUsableAgentActivityTime(
      snapshot.updatedAt,
      referenceTime,
    );
    if (!Number.isFinite(snapshotTime)) continue;
    sources[candidateSource] = {
      state: snapshot.state,
      updatedAt: new Date(snapshotTime).toISOString(),
    };
  }
  return sources;
}

function frontendAgentActivityObserverKey(observerId: string): string {
  return createHash("sha256").update(observerId).digest("hex");
}

function readFrontendAgentActivityObservers(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["frontendAgentActivityObservers"]> {
  const observers: NonNullable<
    Environment["frontendAgentActivityObservers"]
  > = {};
  const stored = environment.frontendAgentActivityObservers;
  if (!isRecord(stored)) return observers;

  for (const [observerKey, candidate] of Object.entries(stored)) {
    if (!isRecord(candidate)) continue;
    if (!isOneOf(candidate.state, AGENT_ACTIVITY_STATES)) continue;
    const updatedTime = parseUsableAgentActivityTime(
      candidate.updatedAt,
      referenceTime,
    );
    const leaseExpiresAt = candidate.leaseExpiresAt;
    if (
      !Number.isFinite(updatedTime)
      || !isAgentActivityTimestamp(leaseExpiresAt)
      || Date.parse(leaseExpiresAt) <= referenceTime
    ) {
      continue;
    }
    observers[observerKey] = {
      state: candidate.state,
      updatedAt: new Date(updatedTime).toISOString(),
      leaseExpiresAt: new Date(Date.parse(leaseExpiresAt)).toISOString(),
    };
  }
  return observers;
}

function aggregateEnvironmentAgentActivity(
  sources: NonNullable<Environment["agentActivitySources"]>,
  observers: NonNullable<Environment["frontendAgentActivityObservers"]>,
): AgentActivityState {
  return aggregateAgentActivityState({ ...sources, ...observers });
}

function nextAgentActivityTimestamp(
  previousValue: unknown,
  referenceTime = Date.now(),
): string {
  const previousTime = parseUsableAgentActivityTime(
    previousValue,
    referenceTime,
  );
  return new Date(Math.max(
    referenceTime,
    Number.isFinite(previousTime)
      ? previousTime + 1
      : Number.NEGATIVE_INFINITY,
  )).toISOString();
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPortNumber(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function isPortMapping(value: unknown): value is PortMapping {
  return isRecord(value)
    && isPortNumber(value.containerPort)
    && isPortNumber(value.hostPort)
    && (value.protocol === "tcp" || value.protocol === "udp");
}

function isPersistedLoopedReviewWorkflow(
  value: unknown,
  expectedId?: string,
): value is PersistedLoopedReviewWorkflow {
  return isRecord(value)
    && isPositiveInteger(value.version)
    && isNonBlankString(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && isNonBlankString(value.environmentId)
    && isRecord(value.snapshot)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function isPersistedPromptQueue(
  value: unknown,
  expectedKey?: string,
): value is PersistedPromptQueue {
  return isRecord(value)
    && isNonBlankString(value.queueKey)
    && (expectedKey === undefined || value.queueKey === expectedKey)
    && isNonBlankString(value.environmentId)
    && Array.isArray(value.messages)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function isPersistedComposeDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedComposeDraft {
  return isRecord(value)
    && isNonBlankString(value.draftKey)
    && (expectedKey === undefined || value.draftKey === expectedKey)
    && (value.ownerType === "environment" || value.ownerType === "project")
    && isNonBlankString(value.ownerId)
    && Object.hasOwn(value, "value")
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function isPersistedFileDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedFileDraft {
  return isRecord(value)
    && isNonBlankString(value.draftKey)
    && (expectedKey === undefined || value.draftKey === expectedKey)
    && isNonBlankString(value.environmentId)
    && isNonBlankString(value.filePath)
    && typeof value.content === "string"
    && typeof value.originalContent === "string"
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function isPersistedAgentHandoff(
  value: unknown,
  expectedId?: string,
): value is PersistedAgentHandoff {
  return isRecord(value)
    && isPositiveInteger(value.version)
    && isNonBlankString(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && isNonBlankString(value.environmentId)
    && isRecord(value.snapshot)
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt));
}

function isPersistedBuildPipeline(
  value: unknown,
  expectedId?: string,
): value is PersistedBuildPipeline {
  return isRecord(value)
    && isPositiveInteger(value.version)
    && isNonBlankString(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && isNonBlankString(value.projectId)
    // Blank until the pipeline's environment exists; see PersistedBuildPipeline.
    && typeof value.environmentId === "string"
    && isRecord(value.snapshot)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function activeGitHubBuildReservation(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  if (snapshot.phase === "complete" || snapshot.phase === "failed") return null;
  const source = snapshot.source;
  if (
    !isRecord(source)
    || source.type !== "github"
    || !isNonBlankString(source.repositoryOwner)
    || !isNonBlankString(source.repositoryName)
    || !isPositiveInteger(source.issueNumber)
  ) {
    return null;
  }
  return `${source.repositoryOwner.toLowerCase()}/${source.repositoryName.toLowerCase()}#${source.issueNumber}`;
}

function isClaudeModelCatalogSnapshot(
  value: unknown,
  environmentId: string,
): value is ClaudeModelCatalogSnapshot {
  if (
    !isRecord(value)
    || value.environmentId !== environmentId
    || !Array.isArray(value.models)
    || !isOneOf(value.source, ["sdk", "last-known-good", "fallback"])
    || typeof value.fetchedAt !== "string"
    || !Number.isFinite(Date.parse(value.fetchedAt))
    || typeof value.stale !== "boolean"
  ) {
    return false;
  }

  const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
  return value.models.every((model) => {
    if (!isRecord(model) || !isNonBlankString(model.id) || !isNonBlankString(model.name)) {
      return false;
    }
    const optionalStrings = ["resolvedModel", "description"] as const;
    if (optionalStrings.some((field) => field in model && model[field] != null && typeof model[field] !== "string")) {
      return false;
    }
    const optionalBooleans = [
      "supportsFastMode",
      "supportsEffort",
      "supportsAdaptiveThinking",
      "supportsAutoMode",
    ] as const;
    if (optionalBooleans.some((field) => field in model && model[field] != null && typeof model[field] !== "boolean")) {
      return false;
    }
    return !("supportedEffortLevels" in model)
      || model.supportedEffortLevels == null
      || (
        Array.isArray(model.supportedEffortLevels)
        && model.supportedEffortLevels.every((level) => isOneOf(level, effortLevels))
      );
  })
    && (value.sdkVersion == null || typeof value.sdkVersion === "string")
    && (value.cliVersion == null || typeof value.cliVersion === "string")
    && (value.error == null || typeof value.error === "string");
}

function validateCodexMaxConcurrentThreads(value: unknown): number {
  if (!isValidCodexMaxConcurrentThreads(value)) {
    throw new Error(
      `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
    );
  }
  return value;
}

function migrateLegacyReviewInstruction(global: JsonRecord): JsonRecord {
  if (
    global.reviewInstruction === undefined
    && typeof global.reviewPrompt === "string"
    && getReviewInstructionValidationError(global.reviewPrompt) === null
  ) {
    const { reviewPrompt, ...rest } = global;
    return {
      ...rest,
      reviewInstruction: reviewPrompt,
    };
  }

  if ("reviewPrompt" in global) {
    const { reviewPrompt: _legacyReviewPrompt, ...rest } = global;
    return rest;
  }
  return global;
}

function validateConfigReviewInstruction(value: unknown): AppConfig {
  if (!isRecord(value) || !isRecord(value.global)) {
    throw new Error("Expected config.global to be an object.");
  }
  const global = migrateLegacyReviewInstruction(value.global);
  parseReviewInstruction(global.reviewInstruction);
  validateCodexMaxConcurrentThreads(global.codexMaxConcurrentThreads);
  return {
    ...value,
    global,
  } as unknown as AppConfig;
}

function validateGlobalReviewInstruction(value: unknown): AppConfig["global"] {
  if (!isRecord(value)) {
    throw new Error("Expected global config to be an object.");
  }
  const global = migrateLegacyReviewInstruction(value);
  parseReviewInstruction(global.reviewInstruction);
  validateCodexMaxConcurrentThreads(global.codexMaxConcurrentThreads);
  return global as unknown as AppConfig["global"];
}

function sanitizePersistedReviewInstruction(config: AppConfig): AppConfig {
  const global = config && isRecord(config.global)
    ? config.global as unknown as JsonRecord
    : null;
  if (!global) {
    return config;
  }

  const migratedGlobal = migrateLegacyReviewInstruction(global);
  const instructionError = getReviewInstructionValidationError(
    migratedGlobal.reviewInstruction,
  );
  if (
    instructionError === null
    && migratedGlobal === global
  ) {
    return config;
  }

  const {
    reviewInstruction: _invalidReviewInstruction,
    ...globalWithoutInvalidInstruction
  } = migratedGlobal;
  const sanitizedGlobal = instructionError === null
    ? migratedGlobal
    : globalWithoutInvalidInstruction;

  return {
    ...config,
    global: sanitizedGlobal as unknown as AppConfig["global"],
  };
}

function normalizePersistedConfig(config: AppConfig): AppConfig {
  const reviewInstructionSanitized = sanitizePersistedReviewInstruction(config);
  const global = reviewInstructionSanitized && isRecord(reviewInstructionSanitized.global)
    ? reviewInstructionSanitized.global as unknown as JsonRecord
    : null;
  if (!global) return reviewInstructionSanitized;

  const codexMaxConcurrentThreads = resolveCodexMaxConcurrentThreads(
    global.codexMaxConcurrentThreads,
  );
  if (global.codexMaxConcurrentThreads === codexMaxConcurrentThreads) {
    return reviewInstructionSanitized;
  }

  return {
    ...reviewInstructionSanitized,
    global: {
      ...global,
      codexMaxConcurrentThreads,
    } as unknown as AppConfig["global"],
  };
}

function slugify(value: string, fallback: string, maxLength = 0): string {
  let out = "";
  let lastHyphen = false;

  for (const char of value) {
    if (/^[a-zA-Z0-9_]$/.test(char)) {
      out += char.toLowerCase();
      lastHyphen = false;
    } else if (char === "-" || char === " " || char === "." || char === "/") {
      if (!lastHyphen && out.length > 0) {
        out += "-";
        lastHyphen = true;
      }
    }
  }

  out = out.replace(/^-+/, "").replace(/-+$/, "");
  if (maxLength > 0 && out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/-+$/, "");
  }
  return out || fallback;
}

export function sanitizeEnvironmentName(value: string): string {
  return slugify(value, "env", 100);
}

export function sanitizeBranchName(value: string): string {
  return slugify(value, "env");
}

export function extractRepoName(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/\.git$/, "");
  const slashPart = trimmed.split("/").filter(Boolean).at(-1);
  if (slashPart) return slashPart;
  const colonPart = trimmed.split(":").filter(Boolean).at(-1);
  return colonPart || trimmed;
}

export function defaultConfig(): AppConfig {
  return {
    version: "1.0.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [".env", ".env.local"],
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      defaultAgent: "claude",
      opencodeModel: "opencode/claude-sonnet-5",
      claudeModel: "claude-sonnet-5",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
      opencodeMode: "terminal",
      claudeMode: "terminal",
      claudeNativeBackend: "sdk",
      claudeNativeFastModeDefault: false,
      codexMode: "native",
      codexNativeFastModeDefault: false,
      codexMaxConcurrentThreads: DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
      terminalAppearance: {
        fontFamily: "FiraCode Nerd Font",
        fontSize: 14,
        backgroundColor: "#141414",
      },
      terminalScrollback: 1000,
      experimentalCodexRawEventLogging: true,
      debugLogging: false,
      webClientEnabled: true,
    },
    repositories: {},
  };
}

export function defaultRepositoryConfig(): RepositoryConfig {
  return {
    defaultBranch: "main",
    prBaseBranch: "main",
  };
}

export function createProject(gitUrl: string, localPath?: string): Project {
  return {
    id: randomUUID(),
    name: extractRepoName(gitUrl),
    gitUrl,
    localPath: localPath ?? null,
    addedAt: nowIso(),
    order: 0,
  };
}

export function createEnvironment(
  projectId: string,
  options: {
    name?: string;
    buildPipelineId?: string;
    networkAccessMode?: "full" | "restricted";
    initialPrompt?: string;
    portMappings?: PortMapping[];
    environmentType?: EnvironmentType;
    entryPort?: number;
    pendingRenamePrompt?: string;
  } = {},
): Environment {
  const rawName =
    options.name?.trim() || defaultEnvironmentName();
  const name = sanitizeEnvironmentName(rawName);
  const environmentType = options.environmentType ?? "containerized";
  const createdAt = nowIso();

  return {
    id: randomUUID(),
    projectId,
    buildPipelineId: options.buildPipelineId,
    name,
    branch: sanitizeBranchName(name),
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt,
    // Creation is itself recent environment activity. Persisting the same
    // timestamp makes a new environment immediately lead the activity view.
    lastActivityAt: createdAt,
    agentActivityState: "idle",
    agentActivityUpdatedAt: createdAt,
    createdFromCommit: undefined,
    networkAccessMode: options.networkAccessMode ?? (environmentType === "local" ? "full" : "restricted"),
    allowedDomains: undefined,
    order: 0,
    portMappings: options.portMappings,
    entryPort: options.entryPort,
    hostEntryPort: undefined,
    environmentType,
    worktreePath: undefined,
    opencodePid: undefined,
    claudeBridgePid: undefined,
    codexBridgePid: undefined,
    localOpencodePort: undefined,
    localClaudePort: undefined,
    localCodexPort: undefined,
    defaultAgent: undefined,
    claudeMode: undefined,
    claudeNativeBackend: undefined,
    opencodeMode: undefined,
    codexMode: undefined,
    setupScriptsComplete: false,
    pendingAgentLaunch: false,
    initialPrompt: options.initialPrompt,
    pendingRenamePrompt: options.pendingRenamePrompt,
  };
}

function createSessionObject(
  environmentId: string,
  containerId: string,
  tabId: string,
  sessionType: SessionType,
): Session {
  const now = nowIso();
  return {
    id: randomUUID(),
    environmentId,
    containerId,
    tabId,
    sessionType,
    status: "connected",
    createdAt: now,
    lastActivityAt: now,
    order: 0,
    hasLaunchedCommand: false,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeOpenCodeModelCatalogEntries(
  models: OpenCodeModelCatalogEntry[],
): OpenCodeModelCatalogEntry[] {
  const byId = new Map<string, OpenCodeModelCatalogEntry[]>();

  for (const candidate of models) {
    if (!candidate || typeof candidate !== "object") continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const provider =
      typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    if (!id || !name || !provider) continue;

    const variants = Array.isArray(candidate.variants)
      ? Array.from(new Set(candidate.variants.filter(
          (variant): variant is string =>
            typeof variant === "string" && variant.trim().length > 0,
        ).map((variant) => variant.trim()))).sort((left, right) =>
          left.localeCompare(right)
        )
      : undefined;
    const nonNegativeNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const contextWindow =
      typeof candidate.contextWindow === "number" &&
      Number.isSafeInteger(candidate.contextWindow) &&
      candidate.contextWindow > 0
        ? candidate.contextWindow
        : undefined;

    const normalized = {
      id,
      name,
      provider,
      ...(variants?.length ? { variants } : {}),
      ...(nonNegativeNumber(candidate.inputCost) !== undefined
        ? { inputCost: nonNegativeNumber(candidate.inputCost) }
        : {}),
      ...(nonNegativeNumber(candidate.outputCost) !== undefined
        ? { outputCost: nonNegativeNumber(candidate.outputCost) }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    const duplicates = byId.get(id) ?? [];
    duplicates.push(normalized);
    byId.set(id, duplicates);
  }

  return Array.from(byId.values())
    .map((duplicates) =>
      duplicates.reduce((selected, candidate) =>
        JSON.stringify(candidate).localeCompare(JSON.stringify(selected)) < 0
          ? candidate
          : selected
      )
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

type PersistedOpenCodeModelCatalogStore = {
  schemaVersion: 2;
  catalogs: Record<string, unknown>;
  legacyUnscoped?: unknown;
};

function normalizeOpenCodeModelCatalogProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) {
    throw new Error("OpenCode model catalogue projectId must be a non-blank string.");
  }
  return normalized;
}

function parseOpenCodeModelCatalogSnapshot(
  projectId: string,
  value: unknown,
): OpenCodeModelCatalogSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.models)) return null;

  const models = normalizeOpenCodeModelCatalogEntries(
    record.models as OpenCodeModelCatalogEntry[],
  );
  if (models.length === 0) return null;

  const updatedAt =
    typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt))
      ? record.updatedAt
      : new Date(0).toISOString();
  const catalogVersion = createHash("sha256")
    .update(JSON.stringify(models))
    .digest("hex");

  return {
    schemaVersion: 2,
    projectId,
    catalogVersion,
    updatedAt,
    models,
  };
}

function parseOpenCodeModelCatalogStore(
  value: unknown,
): Record<string, OpenCodeModelCatalogSnapshot> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  // Schema 1 was one host-global catalogue. It is deliberately left
  // unassigned: attaching it to whichever project reads first would leak a
  // project-specific opencode.json catalogue into another project.
  if (record.schemaVersion !== 2 || !record.catalogs ||
      typeof record.catalogs !== "object" || Array.isArray(record.catalogs)) {
    return {};
  }

  const catalogs = Object.create(null) as Record<
    string,
    OpenCodeModelCatalogSnapshot
  >;
  for (const [rawProjectId, candidate] of Object.entries(
    record.catalogs as Record<string, unknown>,
  )) {
    const projectId = rawProjectId.trim();
    if (!projectId || Object.hasOwn(catalogs, projectId)) continue;
    const snapshot = parseOpenCodeModelCatalogSnapshot(projectId, candidate);
    if (snapshot) catalogs[projectId] = snapshot;
  }
  return catalogs;
}

function getUnscopedLegacyOpenCodeModelCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 1) return value;
  if (record.schemaVersion === 2 && Object.hasOwn(record, "legacyUnscoped")) {
    return record.legacyUnscoped;
  }
  return undefined;
}

export type ResourceChangeListener = (change: ResourceChange) => void;

export class StorageService {
  private readonly dataDir: string;
  private writeQueue = Promise.resolve();
  private environmentMutationQueue: Promise<unknown> = Promise.resolve();
  private configMutationQueue: Promise<unknown> = Promise.resolve();
  private openCodeModelCatalogMutationQueue: Promise<unknown> = Promise.resolve();
  private githubCompletionCommentMutationQueue: Promise<unknown> = Promise.resolve();
  private featurePlanMutation: Promise<unknown> = Promise.resolve();
  private paneLayoutMutation: Promise<unknown> = Promise.resolve();
  private loopedReviewMutation: Promise<unknown> = Promise.resolve();
  private buildPipelineMutation: Promise<unknown> = Promise.resolve();
  private promptQueueMutation: Promise<unknown> = Promise.resolve();
  private composeDraftMutation: Promise<unknown> = Promise.resolve();
  private fileDraftMutation: Promise<unknown> = Promise.resolve();
  private agentHandoffMutation: Promise<unknown> = Promise.resolve();
  private changeListener: ResourceChangeListener | null = null;
  private changeRevision = 0;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Installs the sink that broadcasts persistent mutations to connected
   * clients. Kept as a setter rather than a constructor argument because the
   * gateway that ultimately delivers these does not exist yet when the backend
   * builds its storage service.
   */
  setResourceChangeListener(listener: ResourceChangeListener | null): void {
    this.changeListener = listener;
  }

  /**
   * Announces a committed mutation. Called only after the write has landed, so
   * a client that refetches in response is guaranteed to observe the new value
   * rather than race the write it was told about.
   */
  private announce(resource: ResourceKind, id: string): void {
    const listener = this.changeListener;
    if (!listener) return;
    this.changeRevision += 1;
    try {
      listener({ resource, id, revision: this.changeRevision });
    } catch (error) {
      // A broken client transport must never fail the mutation that succeeded.
      console.error("[Storage] Resource change listener threw:", error);
    }
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getLogDirectory(): string {
    return path.join(this.dataDir, "logs");
  }

  private file(name: string): string {
    return path.join(this.dataDir, name);
  }

  private projectsFile(): string {
    return this.file("projects.json");
  }

  private environmentsFile(): string {
    return this.file("environments.json");
  }

  private configFile(): string {
    return this.file("config.json");
  }

  private openCodeModelCatalogFile(): string {
    return this.file("opencode-model-catalog.json");
  }

  private sessionsFile(): string {
    return this.file("sessions.json");
  }

  private paneLayoutsFile(): string {
    return this.file("pane-layouts.json");
  }

  private loopedReviewsFile(): string {
    return this.file("looped-reviews.json");
  }

  private buildPipelinesFile(): string {
    return this.file("build-pipelines.json");
  }

  private promptQueuesFile(): string {
    return this.file("prompt-queues.json");
  }

  private composeDraftsFile(): string {
    return this.file("compose-drafts.json");
  }

  private fileDraftsFile(): string {
    return this.file("file-drafts.json");
  }

  private agentHandoffsFile(): string {
    return this.file("agent-handoffs.json");
  }

  private kanbanFile(): string {
    return this.file("kanban.json");
  }

  private projectNotesFile(): string {
    return this.file("project-notes.json");
  }

  private featurePlansFile(): string {
    return this.file("feature-plans.json");
  }

  private linearAuthFile(): string {
    return this.file("linear-auth.json");
  }

  private linearCompletionCommentsFile(): string {
    return this.file("linear-completion-comments.json");
  }

  private githubCompletionCommentsFile(): string {
    return this.file("github-completion-comments.json");
  }

  private githubCompletionCommentLockTarget(pipelineId: string): string {
    const key = createHash("sha256").update(pipelineId).digest("hex");
    return this.file(path.join("github-completion-comment-locks", key));
  }

  private buffersDir(): string {
    return path.join(this.dataDir, "buffers");
  }

  private bufferFile(sessionId: string): string {
    return path.join(this.buffersDir(), `${sessionId}.txt`);
  }

  private kanbanImagesDir(): string {
    return path.join(this.dataDir, "kanban-images");
  }

  private kanbanImageFile(imageId: string): string {
    return path.join(this.kanbanImagesDir(), `${imageId}.webp`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  private async writeAtomic(filePath: string, contents: string, makeBackup = true, mode?: number): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);

    await this.enqueueWrite(async () => {
      await fs.writeFile(tempPath, contents, mode === undefined ? undefined : { mode });
      if (mode !== undefined) {
        await fs.chmod(tempPath, mode);
      }
      if (mode !== undefined && await exists(filePath)) {
        // Backups of sensitive files must inherit the restricted mode too.
        await fs.chmod(filePath, mode);
      }
      if (makeBackup && await exists(filePath)) {
        await this.rotateBackups(filePath);
      }
      await fs.rename(tempPath, filePath);
      if (mode !== undefined) {
        await fs.chmod(filePath, mode);
      }
    }).catch(async (error) => {
      if (await exists(tempPath)) {
        await fs.rm(tempPath, { force: true });
      }
      throw error;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueEnvironmentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireEnvironmentMutationLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.environmentMutationQueue.then(run, run);
    this.environmentMutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireConfigMutationLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.configMutationQueue.then(run, run);
    this.configMutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueGitHubCompletionCommentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.githubCompletionCommentsFile(),
        "GitHub completion comment storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.githubCompletionCommentMutationQueue.then(run, run);
    this.githubCompletionCommentMutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueLoopedReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.loopedReviewsFile(),
        "looped review workflow storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.loopedReviewMutation.then(run, run);
    this.loopedReviewMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Serializes build pipeline writes across backend processes sharing this data
   * directory. The cross-process lock matters more here than the in-process
   * queue: two renderers driving the same pipeline is precisely the race the
   * compare-and-swap revision exists to reject, and it can only reject it if the
   * read-modify-write is atomic.
   */
  private enqueueBuildPipelineMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.buildPipelinesFile(),
        "build pipeline storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.buildPipelineMutation.then(run, run);
    this.buildPipelineMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async acquireMutationLock(
    targetPath: string,
    description: string,
  ): Promise<() => Promise<void>> {
    const lockPath = `${targetPath}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + 20_000;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    while (true) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
        } catch (error) {
          await handle.close();
          await fs.rm(lockPath, { force: true });
          throw error;
        }
        const heartbeat = setInterval(() => {
          void handle.utimes(new Date(), new Date()).catch(() => undefined);
        }, 5_000);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          await handle.close();
          const currentToken = await fs.readFile(lockPath, "utf8").catch(() => null);
          if (currentToken === token) await fs.rm(lockPath, { force: true });
        };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 15_000) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${description} lock`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async acquireConfigMutationLock(): Promise<() => Promise<void>> {
    return this.acquireMutationLock(this.configFile(), "configuration storage");
  }

  private async acquireEnvironmentMutationLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.environmentsFile()}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + 20_000;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    while (true) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
        } catch (error) {
          await handle.close();
          await fs.rm(lockPath, { force: true });
          throw error;
        }
        return async () => {
          await handle.close();
          const currentToken = await fs.readFile(lockPath, "utf8").catch(() => null);
          if (currentToken === token) {
            await fs.rm(lockPath, { force: true });
          }
        };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;

        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 15_000) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for environment storage lock");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private backupPath(filePath: string, index: number): string {
    return path.join(path.dirname(filePath), `${path.basename(filePath)}.bak.${index}`);
  }

  private async rotateBackups(filePath: string): Promise<void> {
    for (let index = MAX_JSON_BACKUPS - 1; index >= 1; index -= 1) {
      const current = this.backupPath(filePath, index);
      const next = this.backupPath(filePath, index + 1);
      if (await exists(next)) await fs.rm(next, { force: true });
      if (await exists(current)) await fs.rename(current, next);
    }

    const first = this.backupPath(filePath, 1);
    if (await exists(first)) await fs.rm(first, { force: true });
    await fs.copyFile(filePath, first);
  }

  private async loadJson<T>(filePath: string, fallback: () => T): Promise<T> {
    if (!await exists(filePath)) return fallback();

    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (!raw.trim()) return fallback();
      return JSON.parse(raw) as T;
    } catch {
      for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
        const backup = this.backupPath(filePath, index);
        if (!await exists(backup)) continue;
        try {
          return JSON.parse(await fs.readFile(backup, "utf8")) as T;
        } catch {
          continue;
        }
      }
      return fallback();
    }
  }

  private async saveJson(filePath: string, value: unknown): Promise<void> {
    await this.writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async saveSensitiveJson(filePath: string, value: unknown): Promise<void> {
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      true,
      0o600,
    );
  }

  /**
   * Removes records from every retained backup of a sensitive JSON file.
   *
   * Rotating the primary file leaves the deleted records readable in its
   * backups, so a delete that is meant to remove user content — prompt text,
   * pasted attachments, review findings — is not complete until the backups
   * agree. Call while still holding the file's mutation lock.
   *
   * `keep` receives each stored entry; anything it rejects is dropped, so a
   * caller passes the same predicate it used on the primary file.
   */
  private async scrubSensitiveJsonBackups(
    filePath: string,
    keep: (storedId: string, record: unknown) => boolean,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(filePath, index);
      if (!await exists(backup)) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(backup, "utf8")) as Record<string, unknown>;
        if (!isRecord(parsed)) throw new Error("Backup is not a record");
        const sanitized = Object.fromEntries(
          Object.entries(parsed).filter(([storedId, record]) => keep(storedId, record)),
        );
        await this.writeAtomic(
          backup,
          `${JSON.stringify(sanitized, null, 2)}\n`,
          false,
          0o600,
        );
      } catch {
        // A corrupt backup cannot be proven free of the deleted records.
        await fs.rm(backup, { force: true });
      }
    }
  }

  async loadProjects(): Promise<Project[]> {
    const projects = await this.loadJson<Project[]>(this.projectsFile(), () => []);
    return projects.sort((a, b) => a.order - b.order);
  }

  async addProject(project: Project): Promise<Project> {
    const projects = await this.loadProjects();
    if (projects.some((candidate) => candidate.gitUrl === project.gitUrl)) {
      throw new Error(`Duplicate project URL: ${project.gitUrl}`);
    }

    project.order = Math.max(-1, ...projects.map((item) => item.order)) + 1;
    projects.push(project);
    await this.saveJson(this.projectsFile(), projects);
    this.announce("project", project.id);
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const projects = await this.loadProjects();
    const filtered = projects.filter((project) => project.id !== projectId);
    if (filtered.length === projects.length) throw new Error(`Project not found: ${projectId}`);
    await this.saveJson(this.projectsFile(), filtered);
    await this.deleteComposeDraftsByProject(projectId);
    this.announce("project", projectId);
  }

  async getProject(projectId: string): Promise<Project | null> {
    return (await this.loadProjects()).find((project) => project.id === projectId) ?? null;
  }

  async updateProject(projectId: string, updates: Partial<Pick<Project, "name" | "localPath">>): Promise<Project> {
    const projects = await this.loadProjects();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (typeof updates.name === "string") project.name = updates.name;
    if ("localPath" in updates) project.localPath = updates.localPath ?? null;
    await this.saveJson(this.projectsFile(), projects);
    this.announce("project", projectId);
    return project;
  }

  async reorderProjects(projectIds: string[]): Promise<Project[]> {
    const projects = await this.loadProjects();
    const provided = new Set(projectIds);
    for (const [index, id] of projectIds.entries()) {
      const project = projects.find((candidate) => candidate.id === id);
      if (project) project.order = index;
    }

    let order = projectIds.length;
    for (const project of projects) {
      if (!provided.has(project.id)) project.order = order++;
    }

    await this.saveJson(this.projectsFile(), projects);
    for (const project of projects) this.announce("project", project.id);
    return projects.sort((a, b) => a.order - b.order);
  }

  async loadEnvironments(): Promise<Environment[]> {
    const environments = await this.loadJson<Environment[]>(this.environmentsFile(), () => []);
    return environments.sort((a, b) => a.order - b.order);
  }

  async getEnvironmentsByProject(projectId: string): Promise<Environment[]> {
    return (await this.loadEnvironments()).filter((environment) => environment.projectId === projectId);
  }

  async getEnvironment(environmentId: string): Promise<Environment | null> {
    return (await this.loadEnvironments()).find((environment) => environment.id === environmentId) ?? null;
  }

  async addEnvironment(environment: Environment): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      environment.order =
        Math.max(-1, ...environments.filter((item) => item.projectId === environment.projectId).map((item) => item.order)) + 1;
      environments.push(environment);
      await this.saveJson(this.environmentsFile(), environments);
      this.announce("environment", environment.id);
      return environment;
    });
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const filtered = environments.filter((environment) => environment.id !== environmentId);
      if (filtered.length === environments.length) throw new Error(`Environment not found: ${environmentId}`);
      await this.saveJson(this.environmentsFile(), filtered);
      this.announce("environment", environmentId);
    });
  }

  async updateEnvironment(environmentId: string, updates: JsonRecord): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      if (isNonBlankString(updates.name)) environment.name = updates.name;
      if (isNonBlankString(updates.branch)) environment.branch = updates.branch;
      if ("status" in updates && isOneOf(updates.status, ["running", "stopped", "error", "creating", "stopping"])) {
        environment.status = updates.status;
        if (updates.status === "stopped" || updates.status === "error") {
          environment.agentActivityState = "idle";
          environment.agentActivitySources = {};
          environment.frontendAgentActivityObservers = {};
          environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
            environment.agentActivityUpdatedAt,
          );
        }
      }
      if ("environmentType" in updates && isOneOf(updates.environmentType, ["containerized", "local"])) {
        environment.environmentType = updates.environmentType;
      }

      const optionalStringFields = [
        "worktreePath",
        "initialPrompt",
        "initialAgentModel",
        "initialReasoningEffort",
        "pendingRenamePrompt",
        "createdFromCommit",
        "lastActivityAt",
        "deletionRequestedAt",
        "lifecycleOperationStartedAt",
      ] as const;
      for (const field of optionalStringFields) {
        if (field in updates) {
          const value = updates[field];
          if (value === null || value === undefined || typeof value === "string") {
            (environment as unknown as Record<string, unknown>)[field] = value ?? undefined;
          }
        }
      }
      if ("lifecycleOperation" in updates) {
        if (updates.lifecycleOperation == null) {
          environment.lifecycleOperation = undefined;
        } else if (
          updates.lifecycleOperation === "deleting"
          || updates.lifecycleOperation === "merging"
        ) {
          environment.lifecycleOperation = updates.lifecycleOperation;
        }
      }

      if ("containerId" in updates && (updates.containerId == null || typeof updates.containerId === "string")) {
        environment.containerId = updates.containerId ?? null;
      }
      if ("prUrl" in updates && (updates.prUrl == null || typeof updates.prUrl === "string")) {
        environment.prUrl = updates.prUrl ?? null;
      }
      if ("prState" in updates) {
        if (updates.prState == null) environment.prState = null;
        else if (isOneOf(updates.prState, ["open", "merged", "closed"])) environment.prState = updates.prState;
      }
      if ("hasMergeConflicts" in updates) {
        if (updates.hasMergeConflicts == null) environment.hasMergeConflicts = null;
        else if (typeof updates.hasMergeConflicts === "boolean") environment.hasMergeConflicts = updates.hasMergeConflicts;
      }
      if ("allowedDomains" in updates) environment.allowedDomains = Array.isArray(updates.allowedDomains) ? updates.allowedDomains.filter((value): value is string => typeof value === "string") : undefined;
      if ("portMappings" in updates) {
        if (updates.portMappings == null) environment.portMappings = undefined;
        else if (Array.isArray(updates.portMappings) && updates.portMappings.every(isPortMapping)) {
          environment.portMappings = updates.portMappings;
        }
      }

      const pidFields = ["opencodePid", "claudeBridgePid", "codexBridgePid"] as const;
      for (const field of pidFields) {
        if (!(field in updates)) continue;
        const value = updates[field];
        if (value == null) environment[field] = undefined;
        else if (isPositiveInteger(value)) environment[field] = value;
      }

      const portFields = ["localOpencodePort", "localClaudePort", "localCodexPort", "entryPort", "hostEntryPort"] as const;
      for (const field of portFields) {
        if (!(field in updates)) continue;
        const value = updates[field];
        if (value == null) environment[field] = undefined;
        else if (isPortNumber(value)) environment[field] = value;
      }

      if ("hasUnreadWork" in updates) {
        if (updates.hasUnreadWork == null) environment.hasUnreadWork = false;
        else if (typeof updates.hasUnreadWork === "boolean") {
          environment.hasUnreadWork = updates.hasUnreadWork;
        }
      }
      if ("setupScriptsComplete" in updates) {
        if (updates.setupScriptsComplete == null) environment.setupScriptsComplete = false;
        else if (typeof updates.setupScriptsComplete === "boolean") {
          environment.setupScriptsComplete = updates.setupScriptsComplete;
        }
      }
      if ("pendingAgentLaunch" in updates && typeof updates.pendingAgentLaunch === "boolean") {
        environment.pendingAgentLaunch = updates.pendingAgentLaunch;
      }
      if ("initialPromptAttachments" in updates) {
        if (updates.initialPromptAttachments == null) {
          environment.initialPromptAttachments = undefined;
        } else if (
          Array.isArray(updates.initialPromptAttachments)
          && updates.initialPromptAttachments.every(isInitialPromptImageAttachment)
        ) {
          const serialized = JSON.stringify(updates.initialPromptAttachments);
          if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
            throw new Error("Initial prompt attachments exceed the 32 MB limit");
          }
          environment.initialPromptAttachments = updates.initialPromptAttachments;
        } else {
          throw new Error("Initial prompt attachments are malformed");
        }
      }
      if ("claudeModelCatalog" in updates) {
        if (updates.claudeModelCatalog == null) {
          environment.claudeModelCatalog = undefined;
        } else if (isClaudeModelCatalogSnapshot(updates.claudeModelCatalog, environmentId)) {
          environment.claudeModelCatalog = updates.claudeModelCatalog;
        }
      }
      if ("networkAccessMode" in updates && (updates.networkAccessMode === "full" || updates.networkAccessMode === "restricted")) {
        environment.networkAccessMode = updates.networkAccessMode;
      }
      if ("defaultAgent" in updates) {
        if (updates.defaultAgent == null) environment.defaultAgent = undefined;
        else if (isOneOf(updates.defaultAgent, ["claude", "opencode", "codex"])) environment.defaultAgent = updates.defaultAgent;
      }
      if ("claudeMode" in updates) {
        if (updates.claudeMode == null) environment.claudeMode = undefined;
        else if (isOneOf(updates.claudeMode, ["terminal", "native"])) environment.claudeMode = updates.claudeMode;
      }
      if ("claudeNativeBackend" in updates) {
        if (updates.claudeNativeBackend == null) environment.claudeNativeBackend = undefined;
        else if (isOneOf(updates.claudeNativeBackend, ["sdk", "tmux"])) environment.claudeNativeBackend = updates.claudeNativeBackend;
      }
      if ("opencodeMode" in updates) {
        if (updates.opencodeMode == null) environment.opencodeMode = undefined;
        else if (isOneOf(updates.opencodeMode, ["terminal", "native"])) environment.opencodeMode = updates.opencodeMode;
      }
      if ("codexMode" in updates) {
        if (updates.codexMode == null) environment.codexMode = undefined;
        else if (isOneOf(updates.codexMode, ["terminal", "native"])) environment.codexMode = updates.codexMode;
      }

      await this.saveJson(this.environmentsFile(), environments);
      this.announce("environment", environmentId);
      return environment;
    });
  }

  async recordEnvironmentActivity(environmentId: string, occurredAt: string): Promise<Environment> {
    const activityTime = Date.parse(occurredAt);
    if (!Number.isFinite(activityTime)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const normalizedActivityAt = new Date(activityTime).toISOString();

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = environment.lastActivityAt
        ? Date.parse(environment.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(previousTime) && previousTime >= activityTime) {
        return environment;
      }

      environment.lastActivityAt = normalizedActivityAt;
      await this.saveJson(this.environmentsFile(), environments);
      this.announce("environment", environmentId);
      return environment;
    });
  }

  /**
   * Persist the aggregate agent state observed by a frontend or backend
   * monitor. Timestamp ordering makes reports idempotent and prevents a
   * delayed client from replacing a newer observation.
   */
  async setEnvironmentAgentActivity(
    environmentId: string,
    state: AgentActivityState,
    occurredAt: string,
    source: AgentActivitySource = "frontend",
    observerId?: string,
  ): Promise<Environment> {
    if (!isOneOf(state, AGENT_ACTIVITY_STATES)) {
      throw new Error("state must be idle, working, or waiting");
    }
    if (!isAgentActivityTimestamp(occurredAt)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const occurredTime = Date.parse(occurredAt);
    if (occurredTime > Date.now() + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS) {
      throw new Error("occurredAt must not be more than 5 minutes in the future");
    }
    if (!isOneOf(source, AGENT_ACTIVITY_SOURCES)) {
      throw new Error("source must be frontend or claude-terminal");
    }
    if (
      observerId !== undefined
      && (
        source !== "frontend"
        || !isNonBlankString(observerId)
        || observerId.length > 256
      )
    ) {
      throw new Error(
        "observerId must be a non-blank string of at most 256 characters for frontend activity",
      );
    }

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const referenceTime = Date.now();
      const sources = readAgentActivitySources(environment, referenceTime);
      const observers = readFrontendAgentActivityObservers(
        environment,
        referenceTime,
      );

      const observerKey = observerId
        ? frontendAgentActivityObserverKey(observerId)
        : undefined;
      if (
        observerKey
        && !observers[observerKey]
        && Object.keys(observers).length >= MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS
      ) {
        throw new Error("too many frontend agent activity observers");
      }
      const previousSource = observerKey
        ? observers[observerKey]
        : sources[source];
      const previousTime = previousSource
        ? Date.parse(previousSource.updatedAt)
        : observerKey
          ? Number.NEGATIVE_INFINITY
          : parseUsableAgentActivityTime(
            environment.agentActivityUpdatedAt,
            referenceTime,
          );
      let acceptedOccurredTime = occurredTime;
      if (Number.isFinite(previousTime) && previousTime >= occurredTime) {
        if (source === "frontend" || previousTime > occurredTime) {
          return environment;
        }
        // Backend polling is serialized, so arrival order is authoritative even
        // if two observations share a millisecond. Keep its per-source token
        // monotonic instead of dropping a real terminal transition. Strictly
        // older tokens remain stale and are still rejected.
        acceptedOccurredTime = previousTime + 1;
      }
      const normalizedOccurredAt = new Date(acceptedOccurredTime).toISOString();

      if (observerKey) {
        observers[observerKey] = {
          state,
          updatedAt: normalizedOccurredAt,
          leaseExpiresAt: new Date(
            referenceTime + FRONTEND_AGENT_ACTIVITY_LEASE_MS,
          ).toISOString(),
        };
      } else {
        sources[source] = {
          state,
          updatedAt: normalizedOccurredAt,
        };
      }

      environment.agentActivitySources = sources;
      environment.frontendAgentActivityObservers = observers;
      environment.agentActivityState = aggregateEnvironmentAgentActivity(
        sources,
        observers,
      );
      const aggregateTime = parseUsableAgentActivityTime(
        environment.agentActivityUpdatedAt,
        referenceTime,
      );
      environment.agentActivityUpdatedAt = new Date(Math.max(
        acceptedOccurredTime,
        Number.isFinite(aggregateTime)
          ? aggregateTime
          : Number.NEGATIVE_INFINITY,
      )).toISOString();
      await this.saveJson(this.environmentsFile(), environments);
      this.announce("environment", environmentId);
      return environment;
    });
  }

  /** Remove expired renderer leases and publish each changed aggregate. */
  async expireFrontendAgentActivityLeases(
    referenceTime = Date.now(),
  ): Promise<string[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const changed: string[] = [];
      for (const environment of environments) {
        const storedObservers = environment.frontendAgentActivityObservers;
        if (!isRecord(storedObservers) || Object.keys(storedObservers).length === 0) {
          continue;
        }
        const observers = readFrontendAgentActivityObservers(
          environment,
          referenceTime,
        );
        if (Object.keys(observers).length === Object.keys(storedObservers).length) {
          continue;
        }
        const sources = readAgentActivitySources(environment, referenceTime);
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = observers;
        environment.agentActivityState = aggregateEnvironmentAgentActivity(
          sources,
          observers,
        );
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveJson(this.environmentsFile(), environments);
      for (const environmentId of changed) {
        this.announce("environment", environmentId);
      }
      return changed;
    });
  }

  /**
   * Drop every renderer-reported activity source. Backend startup is the one
   * moment where every pre-existing renderer lease is provably stale.
   */
  async clearFrontendAgentActivity(): Promise<string[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const referenceTime = Date.now();
      const changed: string[] = [];
      for (const environment of environments) {
        const hasLegacyFrontend = Boolean(
          environment.agentActivitySources?.frontend,
        );
        const hasObservers = isRecord(
          environment.frontendAgentActivityObservers,
        ) && Object.keys(environment.frontendAgentActivityObservers).length > 0;
        if (!hasLegacyFrontend && !hasObservers) continue;
        const sources = readAgentActivitySources(environment, referenceTime);
        delete sources.frontend;
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = {};
        environment.agentActivityState = aggregateEnvironmentAgentActivity(
          sources,
          {},
        );
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveJson(this.environmentsFile(), environments);
      for (const environmentId of changed) {
        this.announce("environment", environmentId);
      }
      return changed;
    });
  }

  async recordEnvironmentCompletion(
    environmentId: string,
    occurredAt: string,
  ): Promise<Environment> {
    const activityTime = Date.parse(occurredAt);
    if (!Number.isFinite(activityTime)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const normalizedActivityAt = new Date(activityTime).toISOString();

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = environment.lastActivityAt
        ? Date.parse(environment.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(previousTime) && previousTime >= activityTime) {
        return environment;
      }

      environment.lastActivityAt = normalizedActivityAt;
      environment.hasUnreadWork = true;
      await this.saveJson(this.environmentsFile(), environments);
      this.announce("environment", environmentId);
      return environment;
    });
  }

  async setEnvironmentUnread(
    environmentId: string,
    unread: boolean,
    expectedLastActivityAt?: string | null,
  ): Promise<Environment> {
    if (
      expectedLastActivityAt !== undefined
      && expectedLastActivityAt !== null
      && typeof expectedLastActivityAt !== "string"
    ) {
      throw new Error("expectedLastActivityAt must be a string or null");
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      if (
        !unread
        && expectedLastActivityAt !== undefined
        && (environment.lastActivityAt ?? null) !== expectedLastActivityAt
      ) {
        return environment;
      }
      if (environment.hasUnreadWork === unread) return environment;

      environment.hasUnreadWork = unread;
      await this.saveJson(this.environmentsFile(), environments);
      this.announce("environment", environmentId);
      return environment;
    });
  }

  async reorderEnvironments(projectId: string, environmentIds: string[]): Promise<Environment[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const provided = new Set(environmentIds);
      for (const [index, id] of environmentIds.entries()) {
        const environment = environments.find((candidate) => candidate.id === id && candidate.projectId === projectId);
        if (environment) environment.order = index;
      }

      let order = environmentIds.length;
      for (const environment of environments) {
        if (environment.projectId === projectId && !provided.has(environment.id)) environment.order = order++;
      }

      await this.saveJson(this.environmentsFile(), environments);
      const reordered = environments
        .filter((environment) => environment.projectId === projectId)
        .sort((a, b) => a.order - b.order);
      for (const environment of reordered) this.announce("environment", environment.id);
      return reordered;
    });
  }

  async loadConfig(): Promise<AppConfig> {
    const config = await this.loadJson<AppConfig>(this.configFile(), defaultConfig);
    return normalizePersistedConfig(config);
  }

  async saveConfig(config: AppConfig): Promise<void> {
    const validated = validateConfigReviewInstruction(config);
    await this.enqueueConfigMutation(() => this.saveJson(this.configFile(), validated));
    this.announce("config", "app");
  }

  async getOpenCodeModelCatalog(
    projectId: string,
  ): Promise<OpenCodeModelCatalogSnapshot | null> {
    const normalizedProjectId = normalizeOpenCodeModelCatalogProjectId(projectId);
    const store = await this.loadJson<unknown>(
      this.openCodeModelCatalogFile(),
      () => null,
    );
    return parseOpenCodeModelCatalogStore(store)[normalizedProjectId] ?? null;
  }

  async cacheOpenCodeModelCatalog(
    projectId: string,
    models: OpenCodeModelCatalogEntry[],
  ): Promise<OpenCodeModelCatalogSnapshot> {
    const normalizedProjectId = normalizeOpenCodeModelCatalogProjectId(projectId);
    const normalizedModels = normalizeOpenCodeModelCatalogEntries(models);
    if (normalizedModels.length === 0) {
      throw new Error("OpenCode model catalogue must contain at least one model.");
    }

    const catalogVersion = createHash("sha256")
      .update(JSON.stringify(normalizedModels))
      .digest("hex");

    const run = async () => {
      const release = await this.acquireMutationLock(
        this.openCodeModelCatalogFile(),
        "OpenCode model catalogue storage",
      );
      try {
        const persisted = await this.loadJson<unknown>(
          this.openCodeModelCatalogFile(),
          () => null,
        );
        const catalogs = parseOpenCodeModelCatalogStore(persisted);
        const current = catalogs[normalizedProjectId];
        if (current?.catalogVersion === catalogVersion) return current;

        const snapshot: OpenCodeModelCatalogSnapshot = {
          schemaVersion: 2,
          projectId: normalizedProjectId,
          catalogVersion,
          updatedAt: new Date().toISOString(),
          models: normalizedModels,
        };
        catalogs[normalizedProjectId] = snapshot;
        const legacyUnscoped =
          getUnscopedLegacyOpenCodeModelCatalog(persisted);
        const store: PersistedOpenCodeModelCatalogStore = {
          schemaVersion: 2,
          catalogs,
          ...(legacyUnscoped === undefined
            ? {}
            : { legacyUnscoped }),
        };
        await this.saveJson(this.openCodeModelCatalogFile(), store);
        return snapshot;
      } finally {
        await release();
      }
    };

    const next = this.openCodeModelCatalogMutationQueue.then(run, run);
    this.openCodeModelCatalogMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async getDesktopConnections(): Promise<StoredDesktopConnections> {
    const config = await this.loadConfig();
    if (config.desktopConnections === undefined) return { activeConnectionId: "local", connections: [] };
    try {
      return parseStoredDesktopConnections(config.desktopConnections);
    } catch {
      console.warn("[Storage] Ignoring malformed desktop connection settings.");
      return { activeConnectionId: "local", connections: [] };
    }
  }

  async saveDesktopConnections(desktopConnections: StoredDesktopConnections): Promise<void> {
    const validated = parseStoredDesktopConnections(desktopConnections);
    await this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.desktopConnections = validated;
      await this.saveJson(this.configFile(), config);
    });
    this.announce("config", "app");
  }

  async getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
    const config = await this.loadConfig();
    return config.repositories[projectId] ?? defaultRepositoryConfig();
  }

  async updateRepositoryConfig(projectId: string, repoConfig: RepositoryConfig): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.repositories[projectId] = { ...defaultRepositoryConfig(), ...repoConfig };
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async updateGlobalConfig(globalConfig: AppConfig["global"]): Promise<AppConfig> {
    const validated = validateGlobalReviewInstruction(globalConfig);
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.global = validated;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async updateAgentModelDefault(
    key: AgentModelConfigKey,
    modelId: string,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.global[key] = modelId;
      await this.saveJson(this.configFile(), config);
      // Same announcement every other config mutation makes: other clients
      // rehydrate their model defaults from the authoritative snapshot rather
      // than only learning about the change through the window that made it.
      this.announce("config", "app");
      return config;
    });
  }

  async setGitHubToken(token: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      if (token === null) delete config.global.githubToken;
      else config.global.githubToken = token;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async createSession(environmentId: string, containerId: string, tabId: string, sessionType: SessionType): Promise<Session> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const session = createSessionObject(environmentId, containerId, tabId, sessionType);
    const envSessions = sessions.filter((candidate) => candidate.environmentId === environmentId);
    session.order = Math.max(-1, ...envSessions.map((candidate) => candidate.order)) + 1;

    if (envSessions.length >= MAX_SESSIONS_PER_ENVIRONMENT) {
      const oldestDisconnected = envSessions
        .filter((candidate) => candidate.status === "disconnected")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldestDisconnected) {
        const index = sessions.findIndex((candidate) => candidate.id === oldestDisconnected.id);
        if (index >= 0) sessions.splice(index, 1);
        await this.deleteSessionBuffer(oldestDisconnected.id);
      }
    }

    sessions.push(session);
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", environmentId);
    return session;
  }

  async getPaneLayout(environmentId: string): Promise<PersistedPaneLayout | null> {
    const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
      this.paneLayoutsFile(),
      () => ({}),
    );
    return layouts[environmentId] ?? null;
  }

  async savePaneLayout(
    environmentId: string,
    layout: Pick<PersistedPaneLayout, "version" | "containerId" | "activePaneId" | "root">,
  ): Promise<PersistedPaneLayout> {
    let serializedRoot: string | undefined;
    try {
      serializedRoot = JSON.stringify(layout.root);
    } catch {
      throw new Error("Pane layout root must be JSON serializable");
    }
    if (serializedRoot === undefined) {
      throw new Error("Pane layout root must be JSON serializable");
    }
    if (Buffer.byteLength(serializedRoot, "utf8") > 256 * 1024) {
      throw new Error("Pane layout root exceeds the 256 KB limit");
    }

    const run = this.paneLayoutMutation.then(async () => {
      if (!await this.getEnvironment(environmentId)) {
        throw new Error(`Environment not found: ${environmentId}`);
      }

      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const previous = layouts[environmentId];
      const saved: PersistedPaneLayout = {
        version: layout.version,
        environmentId,
        containerId: layout.containerId,
        activePaneId: layout.activePaneId,
        root: layout.root,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      layouts[environmentId] = saved;
      await this.saveJson(this.paneLayoutsFile(), layouts);
      this.announce("pane-layout", environmentId);
      return saved;
    });
    this.paneLayoutMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async getLoopedReviewWorkflow(
    workflowId: string,
  ): Promise<PersistedLoopedReviewWorkflow | null> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
      () => ({}),
    );
    const workflow = workflows[workflowId];
    return isPersistedLoopedReviewWorkflow(workflow, workflowId)
      ? workflow
      : null;
  }

  async listLoopedReviewWorkflows(
    environmentId: string,
  ): Promise<PersistedLoopedReviewWorkflow[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
      () => ({}),
    );
    return Object.entries(workflows)
      .filter(([workflowId, workflow]) =>
        isPersistedLoopedReviewWorkflow(workflow, workflowId)
        && workflow.environmentId === environmentId
      )
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async saveLoopedReviewWorkflow(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
  ): Promise<PersistedLoopedReviewWorkflow> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Looped review workflow version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Looped review snapshot must be a JSON object");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Looped review expected revision must be a non-negative integer");
    }
    let serializedSnapshot: string | undefined;
    try {
      serializedSnapshot = JSON.stringify(snapshot);
    } catch {
      throw new Error("Looped review snapshot must be JSON serializable");
    }
    if (serializedSnapshot === undefined) {
      throw new Error("Looped review snapshot must be JSON serializable");
    }
    // Review packages intentionally retain complete diffs and changed-file
    // contents. Reject over-sized snapshots explicitly; never truncate them.
    if (Buffer.byteLength(serializedSnapshot, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Looped review snapshot exceeds the 32 MB limit");
    }

    return this.enqueueLoopedReviewMutation(async () => {
      if (!await this.getEnvironment(environmentId)) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      const previous = workflows[workflowId];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Looped review workflow belongs to another environment");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Looped review workflow revision conflict");
      }
      const saved: PersistedLoopedReviewWorkflow = {
        version,
        id: workflowId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      workflows[workflowId] = saved;
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      this.announce("looped-review", workflowId);
      return saved;
    });
  }

  async deleteLoopedReviewWorkflow(workflowId: string): Promise<void> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      if (!(workflowId in workflows)) return;
      delete workflows[workflowId];
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      this.announce("looped-review", workflowId);
    });
  }

  async deleteLoopedReviewWorkflowsByEnvironment(
    environmentId: string,
  ): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
          && workflow.environmentId !== environmentId
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      const removedIds = Object.entries(storedWorkflows)
        .filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
          && workflow.environmentId === environmentId,
        )
        .map(([storedId]) => storedId);
      if (removedIds.length === 0) return;

      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      for (const removedId of removedIds) this.announce("looped-review", removedId);

      // Rotating the primary file creates a backup containing the deleted
      // workflow. Scrub every retained backup before releasing the mutation
      // lock so environment deletion removes all persisted review evidence.
      await this.scrubSensitiveJsonBackups(
        this.loopedReviewsFile(),
        (storedId, workflow) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
          && workflow.environmentId !== environmentId,
      );
    });
  }

  private enqueuePromptQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.promptQueuesFile(),
        "prompt queue storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.promptQueueMutation.then(run, run);
    this.promptQueueMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private validatePromptQueueMessages(messages: unknown): asserts messages is unknown[] {
    if (!Array.isArray(messages)) {
      throw new Error("Prompt queue messages must be an array");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(messages);
    } catch {
      throw new Error("Prompt queue messages must be JSON serializable");
    }
    if (serialized === undefined) {
      throw new Error("Prompt queue messages must be JSON serializable");
    }
    // Queued prompts carry pasted image attachments, so the ceiling has to be
    // generous; it exists to stop a runaway client, not to bound normal use.
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Prompt queue exceeds the 32 MB limit");
    }
  }

  private async assertEnvironmentAcceptsBackgroundState(
    environmentId: string,
    label: string,
  ): Promise<Environment> {
    const environment = await this.getEnvironment(environmentId);
    if (!environment) {
      throw new Error(`${label} environment not found: ${environmentId}`);
    }
    if (environment.deletionRequestedAt) {
      throw new Error(`${label} environment is being deleted: ${environmentId}`);
    }
    return environment;
  }

  private async loadPromptQueues(): Promise<Record<string, PersistedPromptQueue>> {
    const stored = await this.loadJson<Record<string, PersistedPromptQueue>>(
      this.promptQueuesFile(),
      () => ({}),
    );
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, queue]) =>
        isPersistedPromptQueue(queue, storedKey)
      ),
    ) as Record<string, PersistedPromptQueue>;
  }

  async getPromptQueue(queueKey: string): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return (await this.loadPromptQueues())[queueKey] ?? null;
  }

  async listPromptQueues(environmentId: string): Promise<PersistedPromptQueue[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return Object.values(await this.loadPromptQueues())
      .filter((queue) => queue.environmentId === environmentId);
  }

  /**
   * Replaces a tab's queue wholesale under a compare-and-swap revision.
   *
   * Whole-list writes rather than per-item operations because the contended
   * operation is "take the head and send it": two clients doing that must not
   * both win, and a revision check is the cheapest way to guarantee exactly one
   * does. The queue is a handful of messages, so rewriting it costs nothing.
   */
  async savePromptQueue(
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    expectedRevision?: number,
  ): Promise<PersistedPromptQueue> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    this.validatePromptQueueMessages(messages);
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Prompt queue expected revision must be a non-negative integer");
    }

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Prompt queue revision conflict");
      }
      const saved: PersistedPromptQueue = {
        queueKey,
        environmentId,
        messages,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", environmentId);
      return saved;
    });
  }

  async claimPromptQueueHead(
    queueKey: string,
    environmentId: string,
    expectedMessageId: string,
    candidateMessages: unknown[],
  ): Promise<{ claimed: unknown | null; queue: PersistedPromptQueue | null }> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(expectedMessageId)) {
      throw new Error("Expected prompt message ID must not be blank");
    }
    this.validatePromptQueueMessages(candidateMessages);

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }

      const messages = previous?.messages ?? candidateMessages;
      const head = messages[0];
      if (
        !isRecord(head)
        || head.id !== expectedMessageId
      ) {
        return { claimed: null, queue: previous ?? null };
      }

      const saved: PersistedPromptQueue = {
        queueKey,
        environmentId,
        messages: messages.slice(1),
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", environmentId);
      return { claimed: head, queue: saved };
    });
  }

  async deletePromptQueuesByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const removedKeys = Object.values(queues)
        .filter((queue) => queue.environmentId === environmentId)
        .map((queue) => queue.queueKey);
      if (removedKeys.length > 0) {
        for (const key of removedKeys) delete queues[key];
        await this.saveSensitiveJson(this.promptQueuesFile(), queues);
        this.announce("prompt-queue", environmentId);
      }

      // Queued prompts carry user-authored text and pasted attachments, and
      // rotating the primary file leaves them readable in its backups. Always
      // scrub, even when the current primary has no matching record: a prior
      // failed delete may have removed the primary while leaving a backup.
      await this.scrubSensitiveJsonBackups(
        this.promptQueuesFile(),
        (storedKey, queue) =>
          isPersistedPromptQueue(queue, storedKey)
          && queue.environmentId !== environmentId,
      );
      return removedKeys;
    });
  }

  private enqueueComposeDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.composeDraftsFile(),
        "compose draft storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.composeDraftMutation.then(run, run);
    this.composeDraftMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async loadComposeDrafts(): Promise<Record<string, PersistedComposeDraft>> {
    const stored = await this.loadJson<Record<string, PersistedComposeDraft>>(
      this.composeDraftsFile(),
      () => ({}),
    );
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) =>
        isPersistedComposeDraft(draft, storedKey)
      ),
    ) as Record<string, PersistedComposeDraft>;
  }

  async getComposeDraft(draftKey: string): Promise<PersistedComposeDraft | null> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    return (await this.loadComposeDrafts())[draftKey] ?? null;
  }

  async listComposeDrafts(
    ownerType: "environment" | "project",
    ownerId: string,
  ): Promise<PersistedComposeDraft[]> {
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) {
      throw new Error("Compose draft owner ID must not be blank");
    }
    return Object.values(await this.loadComposeDrafts())
      .filter((draft) => draft.ownerType === ownerType && draft.ownerId === ownerId);
  }

  async saveComposeDraft(
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<PersistedComposeDraft> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) {
      throw new Error("Compose draft owner ID must not be blank");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error("Compose draft value must be JSON serializable");
    }
    if (
      serialized === undefined
      || Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024
    ) {
      throw new Error("Compose draft exceeds the 32 MB limit");
    }

    return this.enqueueComposeDraftMutation(async () => {
      if (ownerType === "environment") {
        await this.assertEnvironmentAcceptsBackgroundState(ownerId, "Compose draft");
      } else if (!await this.getProject(ownerId)) {
        throw new Error(`Compose draft project not found: ${ownerId}`);
      }
      const drafts = await this.loadComposeDrafts();
      const previous = drafts[draftKey];
      if (
        previous
        && (previous.ownerType !== ownerType || previous.ownerId !== ownerId)
      ) {
        throw new Error("Compose draft belongs to another owner");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Compose draft revision conflict");
      }
      const saved: PersistedComposeDraft = {
        draftKey,
        ownerType,
        ownerId,
        value,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      drafts[draftKey] = saved;
      await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
      this.announce("compose-draft", ownerId);
      return saved;
    });
  }

  async deleteComposeDraft(draftKey: string): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    await this.enqueueComposeDraftMutation(async () => {
      const drafts = await this.loadComposeDrafts();
      const previous = drafts[draftKey];
      if (!previous) return;
      delete drafts[draftKey];
      await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
      this.announce("compose-draft", previous.ownerId);
    });
  }

  async deleteComposeDraftsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Compose draft environment ID must not be blank");
    }
    await this.enqueueComposeDraftMutation(async () => {
      const drafts = await this.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) =>
          draft.ownerType === "environment" && draft.ownerId === environmentId
        )
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
        this.announce("compose-draft", environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
        (storedKey, draft) =>
          isPersistedComposeDraft(draft, storedKey)
          && (
            draft.ownerType !== "environment"
            || draft.ownerId !== environmentId
          ),
      );
    });
  }

  async deleteComposeDraftsByProject(projectId: string): Promise<void> {
    if (!isNonBlankString(projectId)) {
      throw new Error("Compose draft project ID must not be blank");
    }
    await this.enqueueComposeDraftMutation(async () => {
      const drafts = await this.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.ownerType === "project" && draft.ownerId === projectId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
        this.announce("compose-draft", projectId);
      }
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
        (storedKey, draft) =>
          isPersistedComposeDraft(draft, storedKey)
          && (draft.ownerType !== "project" || draft.ownerId !== projectId),
      );
    });
  }

  private enqueueFileDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.fileDraftsFile(),
        "file draft storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.fileDraftMutation.then(run, run);
    this.fileDraftMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async loadFileDrafts(): Promise<Record<string, PersistedFileDraft>> {
    const stored = await this.loadJson<Record<string, PersistedFileDraft>>(
      this.fileDraftsFile(),
      () => ({}),
    );
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) =>
        isPersistedFileDraft(draft, storedKey)
      ),
    ) as Record<string, PersistedFileDraft>;
  }

  async getFileDraft(draftKey: string): Promise<PersistedFileDraft | null> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    return (await this.loadFileDrafts())[draftKey] ?? null;
  }

  async saveFileDraft(
    draftKey: string,
    environmentId: string,
    filePath: string,
    content: string,
    originalContent: string,
  ): Promise<PersistedFileDraft> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    if (!isNonBlankString(environmentId)) {
      throw new Error("File draft environment ID must not be blank");
    }
    if (!isNonBlankString(filePath)) throw new Error("File draft path must not be blank");
    const size = Buffer.byteLength(content, "utf8") + Buffer.byteLength(originalContent, "utf8");
    if (size > 32 * 1024 * 1024) throw new Error("File draft exceeds the 32 MB limit");

    return this.enqueueFileDraftMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "File draft");
      const drafts = await this.loadFileDrafts();
      const previous = drafts[draftKey];
      if (
        previous
        && (
          previous.environmentId !== environmentId
          || previous.filePath !== filePath
        )
      ) {
        throw new Error("File draft key belongs to another file");
      }
      const saved: PersistedFileDraft = {
        draftKey,
        environmentId,
        filePath,
        content,
        originalContent,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      drafts[draftKey] = saved;
      await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
      this.announce("file-draft", environmentId);
      return saved;
    });
  }

  async deleteFileDraft(draftKey: string): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    await this.enqueueFileDraftMutation(async () => {
      const drafts = await this.loadFileDrafts();
      const previous = drafts[draftKey];
      if (!previous) return;
      delete drafts[draftKey];
      await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
      this.announce("file-draft", previous.environmentId);
    });
  }

  async deleteFileDraftsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("File draft environment ID must not be blank");
    }
    await this.enqueueFileDraftMutation(async () => {
      const drafts = await this.loadFileDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.environmentId === environmentId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
        this.announce("file-draft", environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.fileDraftsFile(),
        (storedKey, draft) =>
          isPersistedFileDraft(draft, storedKey)
          && draft.environmentId !== environmentId,
      );
    });
  }

  private enqueueAgentHandoffMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.agentHandoffsFile(),
        "agent handoff storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.agentHandoffMutation.then(run, run);
    this.agentHandoffMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async loadAgentHandoffEntries(): Promise<Record<string, unknown>> {
    const stored = await this.loadJson<unknown>(
      this.agentHandoffsFile(),
      () => ({}),
    );
    return isRecord(stored) ? stored : {};
  }

  private async loadAgentHandoffs(): Promise<Record<string, PersistedAgentHandoff>> {
    const stored = await this.loadAgentHandoffEntries();
    return Object.fromEntries(
      Object.entries(stored).filter(([storedId, handoff]) =>
        isPersistedAgentHandoff(handoff, storedId)
      ),
    ) as Record<string, PersistedAgentHandoff>;
  }

  async getAgentHandoff(handoffId: string): Promise<PersistedAgentHandoff | null> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    return (await this.loadAgentHandoffs())[handoffId] ?? null;
  }

  async saveAgentHandoff(
    handoffId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
  ): Promise<PersistedAgentHandoff> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Agent handoff version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Agent handoff snapshot must be an object");
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      throw new Error("Agent handoff snapshot must be JSON serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Agent handoff exceeds the 32 MB limit");
    }

    return this.enqueueAgentHandoffMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Agent handoff");
      const handoffs = await this.loadAgentHandoffs();
      const previous = handoffs[handoffId];
      if (previous) {
        if (previous.environmentId !== environmentId) {
          throw new Error("Agent handoff belongs to another environment");
        }
        // Handoffs are immutable. Returning the committed record makes a retry
        // idempotent without allowing a second client to replace its contents.
        return previous;
      }
      const saved: PersistedAgentHandoff = {
        version,
        id: handoffId,
        environmentId,
        snapshot,
        createdAt: nowIso(),
      };
      handoffs[handoffId] = saved;
      await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      return saved;
    });
  }

  private async assertAgentHandoffBackupOwnership(
    handoffId: string,
    environmentId: string,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(this.agentHandoffsFile(), index);
      if (!await exists(backup)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(backup, "utf8"));
      } catch {
        // The scrub that follows removes corrupt backups because their content
        // cannot be proven free of the targeted handoff.
        continue;
      }
      if (!isRecord(parsed)) continue;
      const candidate = parsed[handoffId];
      if (
        isRecord(candidate)
        && isNonBlankString(candidate.environmentId)
        && candidate.environmentId !== environmentId
      ) {
        throw new Error("Agent handoff belongs to another environment");
      }
    }
  }

  /**
   * Deletes one handoff after its destination tab no longer references it.
   *
   * The environment id is required even though handoff ids are globally unique:
   * it prevents a stale or malformed client from deleting another environment's
   * transcript. Backups are scrubbed even when the primary no longer contains
   * the record so retrying a partially completed cleanup finishes the privacy
   * boundary rather than reporting success with retained content.
   */
  async deleteAgentHandoff(
    handoffId: string,
    environmentId: string,
  ): Promise<boolean> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    return this.enqueueAgentHandoffMutation(async () => {
      const handoffs = await this.loadAgentHandoffEntries();
      const stored = handoffs[handoffId];
      if (
        isRecord(stored)
        && isNonBlankString(stored.environmentId)
        && stored.environmentId !== environmentId
      ) {
        throw new Error("Agent handoff belongs to another environment");
      }
      await this.assertAgentHandoffBackupOwnership(handoffId, environmentId);
      const existed = Object.prototype.hasOwnProperty.call(handoffs, handoffId);
      delete handoffs[handoffId];
      // Always rewrite an existing file: a corrupt primary may have fallen back
      // to a backup, and an idempotent retry still needs to replace that
      // unreadable primary. Do not *create* one — a client deleting a stale
      // reference on an installation that never used the feature should leave no
      // trace, and there is nothing to recover when no file exists.
      if (await exists(this.agentHandoffsFile())) {
        await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      }
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
        (storedId) => storedId !== handoffId,
      );
      return existed;
    });
  }

  /**
   * Reconciles stored handoffs against the ids a pane layout still references.
   *
   * Deletion at tab close is a best-effort renderer call: a backend restart, a
   * lock timeout or a kill between the layout update and the request drops it
   * silently, and the id is gone from the layout by then, so nothing would ever
   * retry. Without this sweep those transcripts stay on disk permanently,
   * unreachable and unremovable short of deleting the environment. Called after
   * pane-layout hydration, when `referencedHandoffIds` is authoritative.
   */
  async pruneAgentHandoffs(
    environmentId: string,
    referencedHandoffIds: string[],
  ): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    const referenced = new Set(referencedHandoffIds.filter(isNonBlankString));
    return this.enqueueAgentHandoffMutation(async () => {
      const stored = await this.loadAgentHandoffEntries();
      const isOrphan = (storedId: string, handoff: unknown): boolean =>
        isRecord(handoff)
        && handoff.environmentId === environmentId
        && !referenced.has(storedId);
      const removedIds = Object.entries(stored)
        .filter(([storedId, handoff]) => isOrphan(storedId, handoff))
        .map(([storedId]) => storedId);
      if (removedIds.length === 0) return [];
      const retained = Object.fromEntries(
        Object.entries(stored).filter(([storedId, handoff]) => !isOrphan(storedId, handoff)),
      );
      await this.saveSensitiveJson(this.agentHandoffsFile(), retained);
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
        (storedId, handoff) => !isOrphan(storedId, handoff),
      );
      return removedIds;
    });
  }

  async deleteAgentHandoffsByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    return this.enqueueAgentHandoffMutation(async () => {
      const stored = await this.loadAgentHandoffEntries();
      const removedIds = Object.entries(stored)
        .filter(([, handoff]) =>
          isRecord(handoff) && handoff.environmentId === environmentId
        )
        .map(([storedId]) => storedId);
      const handoffs = Object.fromEntries(
        Object.entries(stored).filter(([storedId, handoff]) =>
          isPersistedAgentHandoff(handoff, storedId)
          && handoff.environmentId !== environmentId
        ),
      );
      // Rewrite even if no valid record matched. Invalid primary entries cannot
      // be proven free of content from the environment being deleted.
      if (await exists(this.agentHandoffsFile())) {
        await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      }
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
        (storedId, handoff) =>
          isPersistedAgentHandoff(handoff, storedId)
          && handoff.environmentId !== environmentId,
      );
      return removedIds;
    });
  }

  private async loadBuildPipelines(): Promise<Record<string, PersistedBuildPipeline>> {
    const stored = await this.loadJson<Record<string, PersistedBuildPipeline>>(
      this.buildPipelinesFile(),
      () => ({}),
    );
    return Object.fromEntries(
      Object.entries(stored).filter(([storedId, pipeline]) =>
        isPersistedBuildPipeline(pipeline, storedId)
      ),
    ) as Record<string, PersistedBuildPipeline>;
  }

  async getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    return (await this.loadBuildPipelines())[pipelineId] ?? null;
  }

  async listBuildPipelines(projectId: string): Promise<PersistedBuildPipeline[]> {
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    return Object.values(await this.loadBuildPipelines())
      .filter((pipeline) => pipeline.projectId === projectId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async saveBuildPipeline(
    pipelineId: string,
    projectId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
  ): Promise<PersistedBuildPipeline> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    if (typeof environmentId !== "string") {
      throw new Error("Build pipeline environment ID must be a string");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Build pipeline version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Build pipeline snapshot must be a JSON object");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Build pipeline expected revision must be a non-negative integer");
    }
    let serializedSnapshot: string | undefined;
    try {
      serializedSnapshot = JSON.stringify(snapshot);
    } catch {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    if (serializedSnapshot === undefined) {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    // Task snapshots embed base64 attachment data and structured review reports
    // retain full findings. Reject an over-sized snapshot rather than truncating
    // it: a silently trimmed task is a pipeline that builds the wrong thing.
    if (Buffer.byteLength(serializedSnapshot, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Build pipeline snapshot exceeds the 32 MB limit");
    }

    return this.enqueueBuildPipelineMutation(async () => {
      if (environmentId) {
        await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Build pipeline");
      }
      const pipelines = await this.loadBuildPipelines();
      const previous = pipelines[pipelineId];
      if (previous && previous.projectId !== projectId) {
        throw new Error("Build pipeline belongs to another project");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Build pipeline revision conflict");
      }
      const reservation = activeGitHubBuildReservation(snapshot);
      if (
        reservation
        && Object.values(pipelines).some((pipeline) =>
          pipeline.id !== pipelineId
          && activeGitHubBuildReservation(pipeline.snapshot) === reservation
        )
      ) {
        throw new Error(`An active build already exists for ${reservation}`);
      }
      const saved: PersistedBuildPipeline = {
        version,
        id: pipelineId,
        projectId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      pipelines[pipelineId] = saved;
      await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
      this.announce("build-pipeline", pipelineId);
      return saved;
    });
  }

  async deleteBuildPipeline(pipelineId: string): Promise<void> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    await this.enqueueBuildPipelineMutation(async () => {
      const pipelines = await this.loadBuildPipelines();
      if (pipelineId in pipelines) {
        delete pipelines[pipelineId];
        await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
        this.announce("build-pipeline", pipelineId);
      }
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          storedId !== pipelineId && isPersistedBuildPipeline(pipeline, storedId),
      );
    });
  }

  async deleteBuildPipelinesByEnvironment(
    environmentId: string,
    linkedPipelineId?: string,
  ): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Build pipeline environment ID must not be blank");
    }
    if (
      linkedPipelineId !== undefined
      && linkedPipelineId !== ""
      && !isNonBlankString(linkedPipelineId)
    ) {
      throw new Error("Linked build pipeline ID must not be blank");
    }
    return this.enqueueBuildPipelineMutation(async () => {
      const pipelines = await this.loadBuildPipelines();
      const linkedId = isNonBlankString(linkedPipelineId) ? linkedPipelineId : null;
      const removedIds = Object.values(pipelines)
        .filter((pipeline) =>
          pipeline.environmentId === environmentId || pipeline.id === linkedId
        )
        .map((pipeline) => pipeline.id);
      if (removedIds.length > 0) {
        for (const removedId of removedIds) delete pipelines[removedId];
        await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
        for (const removedId of removedIds) this.announce("build-pipeline", removedId);
      }
      const removedIdSet = new Set(removedIds);
      if (linkedId) removedIdSet.add(linkedId);

      // Task snapshots embed base64 attachments and full review findings, so
      // the same backup scrub the looped review path performs applies here.
      // Check both ownership forms because a newly-created pipeline deliberately
      // has a blank environmentId until create_environment links it.
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          isPersistedBuildPipeline(pipeline, storedId)
          && pipeline.environmentId !== environmentId
          && !removedIdSet.has(storedId),
      );
      return removedIds;
    });
  }

  async deletePaneLayout(environmentId: string): Promise<void> {
    const run = this.paneLayoutMutation.then(async () => {
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      if (!(environmentId in layouts)) return;
      delete layouts[environmentId];
      await this.saveJson(this.paneLayoutsFile(), layouts);
      this.announce("pane-layout", environmentId);
    });
    this.paneLayoutMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions.find((session) => session.id === sessionId) ?? null;
  }

  async getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions.filter((session) => session.environmentId === environmentId).sort((a, b) => a.order - b.order);
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    Object.assign(session, updates);
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", session.environmentId);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const removed = sessions.find((session) => session.id === sessionId);
    const filtered = sessions.filter((session) => session.id !== sessionId);
    if (filtered.length === sessions.length) throw new Error(`Session not found: ${sessionId}`);
    await this.saveJson(this.sessionsFile(), filtered);
    await this.deleteSessionBuffer(sessionId);
    if (removed) this.announce("session", removed.environmentId);
  }

  async removeSessionsByEnvironment(environmentId: string): Promise<string[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const removed = sessions.filter((session) => session.environmentId === environmentId).map((session) => session.id);
    await this.saveJson(this.sessionsFile(), sessions.filter((session) => session.environmentId !== environmentId));
    await Promise.all(removed.map((sessionId) => this.deleteSessionBuffer(sessionId)));
    if (removed.length > 0) this.announce("session", environmentId);
    return removed;
  }

  async disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const updated: Session[] = [];
    for (const session of sessions) {
      if (session.environmentId === environmentId && session.status === "connected") {
        session.status = "disconnected";
        updated.push(session);
      }
    }
    await this.saveJson(this.sessionsFile(), sessions);
    if (updated.length > 0) this.announce("session", environmentId);
    return updated;
  }

  async reorderSessions(environmentId: string, sessionIds: string[]): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const provided = new Set(sessionIds);
    for (const [index, id] of sessionIds.entries()) {
      const session = sessions.find((candidate) => candidate.id === id && candidate.environmentId === environmentId);
      if (session) session.order = index;
    }
    let order = sessionIds.length;
    for (const session of sessions) {
      if (session.environmentId === environmentId && !provided.has(session.id)) session.order = order++;
    }
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", environmentId);
    return this.getSessionsByEnvironment(environmentId);
  }

  async saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
    await fs.mkdir(this.buffersDir(), { recursive: true });
    const maxBufferSize = 500 * 1024;
    const contents = buffer.length > maxBufferSize ? buffer.slice(buffer.length - maxBufferSize) : buffer;
    await fs.writeFile(this.bufferFile(sessionId), contents);
  }

  async loadSessionBuffer(sessionId: string): Promise<string | null> {
    const filePath = this.bufferFile(sessionId);
    if (!await exists(filePath)) return null;
    return fs.readFile(filePath, "utf8");
  }

  async deleteSessionBuffer(sessionId: string): Promise<void> {
    await fs.rm(this.bufferFile(sessionId), { force: true });
  }

  async cleanupOrphanedBuffers(): Promise<string[]> {
    if (!await exists(this.buffersDir())) return [];
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const liveBufferFiles = new Set(sessions.map((session) => `${session.id}.txt`));
    const deleted: string[] = [];
    for (const entry of await fs.readdir(this.buffersDir())) {
      const sessionId = path.basename(entry, path.extname(entry));
      if (!liveBufferFiles.has(entry)) {
        await fs.rm(path.join(this.buffersDir(), entry), { force: true });
        deleted.push(sessionId);
      }
    }
    return deleted;
  }

  async getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    return tasks.filter((task) => task.projectId === projectId);
  }

  async addKanbanTask(projectId: string, title: string, description: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task: KanbanTask = {
      id: randomUUID(),
      projectId,
      title,
      description,
      acceptanceCriteria: "",
      status: "backlog",
      comments: [],
      images: [],
      createdAt: nowIso(),
      order: Math.max(-1, ...tasks.filter((candidate) => candidate.projectId === projectId && candidate.status === "backlog").map((candidate) => candidate.order)) + 1,
      prMergeCommented: false,
    };
    tasks.push(task);
    await this.saveJson(this.kanbanFile(), tasks);
    this.announce("kanban", projectId);
    return task;
  }

  async updateKanbanTask(taskId: string, updates: Partial<KanbanTask>): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);

    const oldStatus = task.status;
    Object.assign(task, updates);
    if (updates.status && updates.status !== oldStatus) {
      task.order = Math.max(-1, ...tasks.filter((candidate) => candidate.projectId === task.projectId && candidate.status === updates.status && candidate.id !== taskId).map((candidate) => candidate.order)) + 1;
    }
    await this.saveJson(this.kanbanFile(), tasks);
    this.announce("kanban", task.projectId);
    return task;
  }

  async deleteKanbanTask(taskId: string): Promise<void> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    await Promise.all(task.images.map((image) => fs.rm(this.kanbanImageFile(image.id), { force: true })));
    await this.saveJson(this.kanbanFile(), tasks.filter((candidate) => candidate.id !== taskId));
    this.announce("kanban", task.projectId);
  }

  async addKanbanComment(taskId: string, text: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    task.comments.push({ id: randomUUID(), text, createdAt: nowIso() });
    await this.saveJson(this.kanbanFile(), tasks);
    this.announce("kanban", task.projectId);
    return task;
  }

  async deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    task.comments = task.comments.filter((comment) => comment.id !== commentId);
    await this.saveJson(this.kanbanFile(), tasks);
    this.announce("kanban", task.projectId);
    return task;
  }

  async addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);

    const rawBytes = Buffer.from(data, "base64");
    const webpBytes = await resizeKanbanImage(rawBytes);
    await fs.mkdir(this.kanbanImagesDir(), { recursive: true });
    const image: KanbanImage = { id: randomUUID(), filename, createdAt: nowIso() };
    await fs.writeFile(this.kanbanImageFile(image.id), webpBytes);
    task.images.push(image);
    await this.saveJson(this.kanbanFile(), tasks);
    this.announce("kanban", task.projectId);
    return task;
  }

  async deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Kanban task not found: ${taskId}`);
    task.images = task.images.filter((image) => image.id !== imageId);
    await fs.rm(this.kanbanImageFile(imageId), { force: true });
    await this.saveJson(this.kanbanFile(), tasks);
    this.announce("kanban", task.projectId);
    return task;
  }

  async getKanbanImageData(imageId: string): Promise<string> {
    return (await fs.readFile(this.kanbanImageFile(imageId))).toString("base64");
  }

  async getProjectNotes(projectId: string): Promise<ProjectNotes> {
    const notes = await this.loadJson<ProjectNotes[]>(this.projectNotesFile(), () => []);
    return notes.find((note) => note.projectId === projectId) ?? { projectId, content: "", updatedAt: nowIso() };
  }

  async saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
    const notes = await this.loadJson<ProjectNotes[]>(this.projectNotesFile(), () => []);
    let note = notes.find((candidate) => candidate.projectId === projectId);
    if (!note) {
      note = { projectId, content, updatedAt: nowIso() };
      notes.push(note);
    } else {
      note.content = content;
      note.updatedAt = nowIso();
    }
    await this.saveJson(this.projectNotesFile(), notes);
    this.announce("project-notes", projectId);
    return note;
  }

  async getFeaturePlans(projectId: string): Promise<FeaturePlan[]> {
    const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
    return plans
      .filter((plan) => plan.projectId === projectId)
      .sort((a, b) => a.order - b.order);
  }

  // Serializes the entire load -> mutate -> save cycle for feature plans so that
  // concurrent flows (e.g. a feature-chat poll and a story refinement happening at
  // the same time) cannot clobber each other via stale read-modify-write races.
  // The mutator runs against the freshly loaded array; if it throws, nothing is
  // saved and the next queued mutation still proceeds.
  private mutateFeaturePlans<T>(
    mutator: (plans: FeaturePlan[]) => T,
    affectedProjectId: (result: T) => string,
  ): Promise<T> {
    const run = this.featurePlanMutation.then(async () => {
      const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
      const result = mutator(plans);
      await this.saveJson(this.featurePlansFile(), plans);
      this.announce("feature-plan", affectedProjectId(result));
      return result;
    });
    this.featurePlanMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async createFeaturePlan(projectId: string): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const now = nowIso();
      const plan: FeaturePlan = {
        id: randomUUID(),
        projectId,
        title: "new feature",
        status: "collecting",
        summary: "",
        messages: [{
          id: randomUUID(),
          role: "assistant",
          content: "Tell me about the new feature",
          createdAt: now,
        }],
        stories: [],
        createdAt: now,
        updatedAt: now,
        order: Math.max(-1, ...plans.filter((candidate) => candidate.projectId === projectId).map((candidate) => candidate.order)) + 1,
      };
      plans.push(plan);
      return plan;
    }, (plan) => plan.projectId);
  }

  async updateFeaturePlan(featureId: string, updates: Partial<FeaturePlan>): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

      const originalId = plan.id;
      const originalProjectId = plan.projectId;
      Object.assign(plan, updates);
      plan.id = originalId;
      plan.projectId = originalProjectId;
      plan.updatedAt = nowIso();
      return plan;
    }, (plan) => plan.projectId);
  }

  async appendFeaturePlanMessage(
    featureId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

      plan.messages.push({
        id: randomUUID(),
        role,
        content,
        createdAt: nowIso(),
        ...(stateApplication ? { stateApplication } : {}),
      });
      plan.updatedAt = nowIso();
      return plan;
    }, (plan) => plan.projectId);
  }

  async appendFeatureStoryMessage(
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
      const story = plan.stories.find((candidate) => candidate.id === storyId);
      if (!story) throw new Error(`Feature story not found: ${storyId}`);

      story.messages.push({
        id: randomUUID(),
        role,
        content,
        createdAt: nowIso(),
        ...(stateApplication ? { stateApplication } : {}),
      });
      story.updatedAt = nowIso();
      plan.updatedAt = nowIso();
      return plan;
    }, (plan) => plan.projectId);
  }

  async getLinearAuth(): Promise<LinearAuth | null> {
    const auth = await this.loadJson<LinearAuth | null>(this.linearAuthFile(), () => null);
    return auth?.apiKey ? auth : null;
  }

  async saveLinearAuth(apiKey: string, viewer?: LinearAuth["viewer"]): Promise<LinearAuth> {
    const auth: LinearAuth = {
      apiKey,
      connectedAt: nowIso(),
      viewer,
    };
    await this.writeAtomic(this.linearAuthFile(), `${JSON.stringify(auth, null, 2)}\n`, false, 0o600);
    return auth;
  }

  async clearLinearAuth(): Promise<void> {
    await fs.rm(this.linearAuthFile(), { force: true });
  }

  async getLinearCompletionComment(pipelineId: string): Promise<LinearCompletionComment | null> {
    const comments = await this.loadJson<LinearCompletionComment[]>(this.linearCompletionCommentsFile(), () => []);
    return comments.find((comment) => comment.pipelineId === pipelineId) ?? null;
  }

  async saveLinearCompletionComment(
    record: Omit<LinearCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<LinearCompletionComment> {
    const comments = await this.loadJson<LinearCompletionComment[]>(this.linearCompletionCommentsFile(), () => []);
    const nextRecord: LinearCompletionComment = {
      ...record,
      updatedAt: record.updatedAt ?? nowIso(),
    };
    const index = comments.findIndex((comment) => comment.pipelineId === record.pipelineId);
    if (index >= 0) comments[index] = nextRecord;
    else comments.push(nextRecord);
    await this.saveJson(this.linearCompletionCommentsFile(), comments);
    return nextRecord;
  }

  async getGitHubCompletionComment(pipelineId: string): Promise<GitHubCompletionComment | null> {
    const comments = await this.loadJson<GitHubCompletionComment[]>(
      this.githubCompletionCommentsFile(),
      () => [],
    );
    return comments.find((comment) => comment.pipelineId === pipelineId) ?? null;
  }

  /**
   * Serialize the complete scan/post/persist transaction for one GitHub-backed
   * pipeline across backend processes sharing this data directory.
   */
  async withGitHubCompletionCommentLock<T>(
    pipelineId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!pipelineId.trim()) throw new Error("GitHub completion pipeline ID is required");
    const release = await this.acquireMutationLock(
      this.githubCompletionCommentLockTarget(pipelineId),
      "GitHub completion comment posting",
    );
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async saveGitHubCompletionComment(
    record: Omit<GitHubCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<GitHubCompletionComment> {
    return this.enqueueGitHubCompletionCommentMutation(async () => {
      const comments = await this.loadJson<GitHubCompletionComment[]>(
        this.githubCompletionCommentsFile(),
        () => [],
      );
      const nextRecord: GitHubCompletionComment = {
        ...record,
        updatedAt: record.updatedAt ?? nowIso(),
      };
      const index = comments.findIndex((comment) => comment.pipelineId === record.pipelineId);
      if (index >= 0) comments[index] = nextRecord;
      else comments.push(nextRecord);
      await this.saveJson(this.githubCompletionCommentsFile(), comments);
      return nextRecord;
    });
  }

  async setAllEnvironmentStatusesForContainer(containerId: string, status: EnvironmentStatus): Promise<void> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      let changed = false;
      for (const environment of environments) {
        if (environment.containerId === containerId) {
          environment.status = status;
          changed = true;
        }
      }
      if (changed) await this.saveJson(this.environmentsFile(), environments);
    });
  }
}

export function parseUpdateObject(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

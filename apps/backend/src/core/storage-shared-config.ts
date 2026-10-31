import path from "node:path";
import {
  getReviewInstructionValidationError,
  parseReviewInstruction,
} from "@orkestrator/protocol/review-instruction";
import {
  LEGACY_ENABLED_AGENT_PLATFORMS,
  firstEnabledAgentPlatform,
  isAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { isEmptyAgentSettings, type AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import {
  DEFAULT_TERMINAL_HISTORY_ENABLED,
  DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
  DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
  DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
  normalizeTerminalHistoryRetention,
} from "@orkestrator/protocol/terminal-history";
import {
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  normalizeAgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import { DEFAULT_CLAUDE_MODE } from "@orkestrator/protocol/startup-launch";
import { DEFAULT_ALLOWED_DOMAINS } from "@orkestrator/protocol/network-allowlist";
import { sanitizeReviewLensPresets } from "@orkestrator/protocol/review-lens";
import {
  DEFAULT_DEBUG_LOG_RETENTION_DAYS,
  normalizeDebugLogRetentionDays,
} from "@orkestrator/protocol/debug-logging";
import { MAX_SSH_AGENT_SOCKET_PATH_CHARS } from "@orkestrator/protocol/ssh-agent-socket";
import { MAX_DEFAULT_PROJECTS_DIRECTORY_CHARS } from "@orkestrator/protocol/project-copy";
import {
  DEFAULT_NOTIFICATION_SOUND_SETTINGS,
  normalizeNotificationSoundSettings,
} from "@orkestrator/protocol/notification-sounds";
import {
  COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
  normalizeCoordinatorProviderTierDefaultVersion,
} from "@orkestrator/protocol/coordinator";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  migrateOpenCodeModelProviders,
  normalizeOpenCodeModelProviders,
} from "@orkestrator/protocol/native-agent";
import {
  isValidClaudeBackgroundCommandLimitHours,
  MAX_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS,
  MIN_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS,
} from "@orkestrator/protocol/claude-background-commands";
import { isSessionTitleGenerationPolicy } from "@orkestrator/protocol/session-title-generation";
import {
  LEGACY_GLOBAL_AGENT_KEYS,
  LEGACY_REPOSITORY_AGENT_KEYS,
  migrateGlobalAgentSettings,
  migrateRepositoryAgentSettings,
} from "./storage-agent-settings.js";
import {
  normalizeOpenCodeRepositoryDefaults,
  selectableOpenCodeDefaultModel,
  storedOpenCodeModelIds,
} from "./storage-opencode-models.js";
import {
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  isValidCodexMaxConcurrentThreads,
  MAX_CODEX_CONCURRENT_THREADS,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";
import type { AppConfig, RepositoryConfig } from "./models.js";
import { isRecord, type JsonRecord } from "./storage-shared-core.js";

export function validateCodexMaxConcurrentThreads(value: unknown): number {
  if (!isValidCodexMaxConcurrentThreads(value)) {
    throw new Error(
      `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
    );
  }
  return value;
}

/** Absent means the Claude CLI's own 2-hour ceiling. */
export function validateClaudeBackgroundCommandLimitHours(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isValidClaudeBackgroundCommandLimitHours(value)) {
    throw new Error(
      `claudeBackgroundCommandLimitHours must be an integer between ${MIN_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS} and ${MAX_CLAUDE_BACKGROUND_COMMAND_LIMIT_HOURS}.`,
    );
  }
  return value;
}

/** Absent means the default policy. */
export function validateSessionTitleGeneration(value: unknown): void {
  if (value !== undefined && !isSessionTitleGenerationPolicy(value)) {
    throw new Error("sessionTitleGeneration must be any-signed-in, own-platform or off.");
  }
}

export function migrateLegacyReviewInstruction(global: JsonRecord): JsonRecord {
  if (
    global.reviewInstruction === undefined &&
    typeof global.reviewPrompt === "string" &&
    getReviewInstructionValidationError(global.reviewPrompt) === null
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

export function validateConfigReviewInstruction(value: unknown): AppConfig {
  if (!isRecord(value) || !isRecord(value.global)) {
    throw new Error("Expected config.global to be an object.");
  }
  const global = migrateLegacyReviewInstruction(value.global);
  parseReviewInstruction(global.reviewInstruction);
  validateCodexMaxConcurrentThreads(global.codexMaxConcurrentThreads);
  validateClaudeBackgroundCommandLimitHours(global.claudeBackgroundCommandLimitHours);
  validateSessionTitleGeneration(global.sessionTitleGeneration);
  return {
    ...value,
    global,
  } as unknown as AppConfig;
}

export function validateGlobalReviewInstruction(value: unknown): AppConfig["global"] {
  if (!isRecord(value)) {
    throw new Error("Expected global config to be an object.");
  }
  const global = migrateLegacyReviewInstruction(value);
  parseReviewInstruction(global.reviewInstruction);
  validateCodexMaxConcurrentThreads(global.codexMaxConcurrentThreads);
  validateClaudeBackgroundCommandLimitHours(global.claudeBackgroundCommandLimitHours);
  validateSessionTitleGeneration(global.sessionTitleGeneration);
  return global as unknown as AppConfig["global"];
}

export function sanitizePersistedReviewInstruction(config: AppConfig): AppConfig {
  const global =
    config && isRecord(config.global) ? (config.global as unknown as JsonRecord) : null;
  if (!global) {
    return config;
  }

  const migratedGlobal = migrateLegacyReviewInstruction(global);
  const instructionError = getReviewInstructionValidationError(migratedGlobal.reviewInstruction);
  if (instructionError === null && migratedGlobal === global) {
    return config;
  }

  const { reviewInstruction: _invalidReviewInstruction, ...globalWithoutInvalidInstruction } =
    migratedGlobal;
  const sanitizedGlobal =
    instructionError === null ? migratedGlobal : globalWithoutInvalidInstruction;

  return {
    ...config,
    global: sanitizedGlobal as unknown as AppConfig["global"],
  };
}

// The OpenCode model helpers moved to their own module, but this one is where
// `storage-shared.ts` and every existing caller reach for them, so the surface
// stays here.
export {
  normalizeOpenCodeRepositoryDefaults,
  selectableOpenCodeDefaultModel,
  storedOpenCodeModelIds,
};

export function normalizePersistedConfig(config: AppConfig): AppConfig {
  const reviewInstructionSanitized = sanitizePersistedReviewInstruction(config);
  const global =
    reviewInstructionSanitized && isRecord(reviewInstructionSanitized.global)
      ? (reviewInstructionSanitized.global as unknown as JsonRecord)
      : null;
  if (!global) return reviewInstructionSanitized;

  const codexMaxConcurrentThreads = resolveCodexMaxConcurrentThreads(
    global.codexMaxConcurrentThreads,
  );
  const claudeBackgroundCommandLimitHours = isValidClaudeBackgroundCommandLimitHours(
    global.claudeBackgroundCommandLimitHours,
  )
    ? global.claudeBackgroundCommandLimitHours
    : undefined;
  const sessionTitleGeneration = isSessionTitleGenerationPolicy(global.sessionTitleGeneration)
    ? global.sessionTitleGeneration
    : undefined;
  const debugLogRetentionDays = normalizeDebugLogRetentionDays(global.debugLogRetentionDays);
  const terminalHistoryRetention = normalizeTerminalHistoryRetention({
    enabled: global.terminalHistoryEnabled,
    sessionMb: global.terminalHistoryRetentionMb,
    globalMb: global.terminalHistoryGlobalRetentionMb,
    days: global.terminalHistoryRetentionDays,
  });
  const notificationSounds = normalizeNotificationSoundSettings(global.notificationSounds);
  // A hand-edited or older list keeps every preset that is still valid; the
  // launchers only ever offer what passes the guard.
  const reviewLensPresets =
    global.reviewLensPresets === undefined
      ? undefined
      : sanitizeReviewLensPresets(global.reviewLensPresets);
  const sshAgentSocketPath =
    typeof global.sshAgentSocketPath === "string" &&
    global.sshAgentSocketPath.trim().length <= MAX_SSH_AGENT_SOCKET_PATH_CHARS &&
    !global.sshAgentSocketPath.includes("\0") &&
    path.isAbsolute(global.sshAgentSocketPath.trim())
      ? global.sshAgentSocketPath.trim()
      : undefined;
  const defaultProjectsDirectory =
    typeof global.defaultProjectsDirectory === "string" &&
    global.defaultProjectsDirectory.trim().length <= MAX_DEFAULT_PROJECTS_DIRECTORY_CHARS &&
    !global.defaultProjectsDirectory.includes("\0") &&
    path.isAbsolute(global.defaultProjectsDirectory.trim())
      ? global.defaultProjectsDirectory.trim()
      : undefined;
  const agentMessaging = normalizeAgentMessagingSettings(
    global.agentMessaging,
    config.schemaVersion === 2
      ? { ...DEFAULT_AGENT_MESSAGING_SETTINGS }
      : { ...DEFAULT_AGENT_MESSAGING_SETTINGS, enabled: false },
  );
  const hasExplicitGitHubCredentialSource = typeof global.useHostGitHubCredentials === "boolean";
  const hasLegacyGitHubToken =
    typeof global.githubToken === "string" && global.githubToken.trim().length > 0;
  // Before the source selector existed, a stored PAT was the user's explicit
  // GitHub credential. Preserve that choice during migration instead of
  // silently replacing it with the host's potentially broader `gh` token.
  const useHostGitHubCredentials = hasExplicitGitHubCredentialSource
    ? global.useHostGitHubCredentials
    : !hasLegacyGitHubToken;
  const normalizedEnabledAgentPlatforms = normalizeAgentPlatforms(
    global.enabledAgentPlatforms,
    LEGACY_ENABLED_AGENT_PLATFORMS,
  );
  const enabledAgentPlatforms =
    normalizedEnabledAgentPlatforms.length > 0
      ? normalizedEnabledAgentPlatforms
      : [...LEGACY_ENABLED_AGENT_PLATFORMS];
  const favoriteModels = Array.isArray(global.favoriteModels)
    ? global.favoriteModels
        .flatMap((value) => {
          if (!isRecord(value) || !isAgentPlatform(value.platform)) return [];
          const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
          return modelId ? [{ platform: value.platform, modelId }] : [];
        })
        .filter(
          (value, index, values) =>
            values.findIndex(
              (candidate) =>
                candidate.platform === value.platform && candidate.modelId === value.modelId,
            ) === index,
        )
    : [];
  // An explicitly stored list is the user's own; an explicitly empty one is
  // them opting into every provider and must survive normalization. Anything
  // else is a pre-existing install being migrated onto the managed pair, which
  // has to keep the providers that install already selected from.
  const openCodeModelProviders = Array.isArray(global.openCodeModelProviders)
    ? normalizeOpenCodeModelProviders(global.openCodeModelProviders)
    : migrateOpenCodeModelProviders(
        storedOpenCodeModelIds(global, reviewInstructionSanitized.repositories),
      );
  // Fold every tier onto the shared agent-settings shape before anything else
  // reads a model or a mode. Downstream normalization below operates on the
  // migrated block only, so there is exactly one shape in play from here on.
  const migratedGlobal = migrateGlobalAgentSettings(global);
  const agentSettings: AgentSettingsTier = {
    ...migratedGlobal,
    // The default agent has to be one the user still has enabled. A stored
    // agent for a platform they since turned off would name a launch surface
    // that no longer exists.
    defaultAgent: firstEnabledAgentPlatform(enabledAgentPlatforms, migratedGlobal.defaultAgent),
    platforms: {
      ...migratedGlobal.platforms,
      opencode: (() => {
        const { model: stored, ...opencode } = migratedGlobal.platforms?.opencode ?? {};
        const model = selectableOpenCodeDefaultModel(
          stored,
          favoriteModels,
          openCodeModelProviders,
        );
        // An unreachable default with no favourite to take its place is
        // cleared, which leaves the effective OpenCode default in charge.
        return typeof model === "string" && model ? { ...opencode, model } : opencode;
      })(),
    },
  };

  const globalDefaultAgent = agentSettings.defaultAgent ?? "claude";
  const migratedRepositories = migrateRepositories(
    reviewInstructionSanitized.repositories,
    globalDefaultAgent,
  );
  // A repository default outranks the global one everywhere it is read, so the
  // repointing has to reach it too or the unreachable id simply survives one
  // level down. Identity is preserved when nothing moved.
  const repositories = normalizeOpenCodeRepositoryDefaults(
    migratedRepositories,
    favoriteModels,
    openCodeModelProviders,
  );

  // The previous release persisted its `enforced` default even when the user
  // only saved an unrelated global setting. With no explicit-choice marker in
  // that format, an unmarked `enforced` value is the legacy implicit default.
  // Remove it once so absence follows the new product default; the version
  // marker prevents a later explicit `enforced` choice from being migrated.
  const storedCoordinatorProviderTierDefaultVersion = global.coordinatorProviderTierDefaultVersion;
  const coordinatorProviderTiers =
    storedCoordinatorProviderTierDefaultVersion === undefined &&
    global.coordinatorProviderTiers === "enforced"
      ? undefined
      : global.coordinatorProviderTiers;
  const coordinatorProviderTierDefaultVersion = normalizeCoordinatorProviderTierDefaultVersion(
    storedCoordinatorProviderTierDefaultVersion,
  );
  const nextGlobal = stripLegacyKeys(
    {
      ...global,
      agentSettings,
      coordinatorProviderTiers,
      coordinatorProviderTierDefaultVersion,
    },
    LEGACY_GLOBAL_AGENT_KEYS,
  ) as unknown as AppConfig["global"];

  if (
    repositories === reviewInstructionSanitized.repositories &&
    global.codexMaxConcurrentThreads === codexMaxConcurrentThreads &&
    global.claudeBackgroundCommandLimitHours === claudeBackgroundCommandLimitHours &&
    global.sessionTitleGeneration === sessionTitleGeneration &&
    global.debugLogRetentionDays === debugLogRetentionDays &&
    global.terminalHistoryEnabled === terminalHistoryRetention.enabled &&
    global.terminalHistoryRetentionMb === terminalHistoryRetention.sessionMb &&
    global.terminalHistoryGlobalRetentionMb === terminalHistoryRetention.globalMb &&
    global.terminalHistoryRetentionDays === terminalHistoryRetention.days &&
    global.sshAgentSocketPath === sshAgentSocketPath &&
    global.defaultProjectsDirectory === defaultProjectsDirectory &&
    global.useHostGitHubCredentials === useHostGitHubCredentials &&
    JSON.stringify(global.enabledAgentPlatforms) === JSON.stringify(enabledAgentPlatforms) &&
    JSON.stringify(global.favoriteModels ?? []) === JSON.stringify(favoriteModels) &&
    JSON.stringify(global.openCodeModelProviders) === JSON.stringify(openCodeModelProviders) &&
    JSON.stringify(global.agentSettings) === JSON.stringify(agentSettings) &&
    JSON.stringify(global.agentMessaging) === JSON.stringify(agentMessaging) &&
    JSON.stringify(global.notificationSounds) === JSON.stringify(notificationSounds) &&
    JSON.stringify(global.reviewLensPresets) === JSON.stringify(reviewLensPresets) &&
    global.coordinatorProviderTiers === coordinatorProviderTiers &&
    global.coordinatorProviderTierDefaultVersion === coordinatorProviderTierDefaultVersion &&
    config.schemaVersion === 2
  ) {
    return reviewInstructionSanitized;
  }

  return {
    ...reviewInstructionSanitized,
    schemaVersion: 2,
    repositories,
    global: {
      ...nextGlobal,
      codexMaxConcurrentThreads,
      claudeBackgroundCommandLimitHours,
      sessionTitleGeneration,
      debugLogRetentionDays,
      terminalHistoryEnabled: terminalHistoryRetention.enabled,
      terminalHistoryRetentionMb: terminalHistoryRetention.sessionMb,
      terminalHistoryGlobalRetentionMb: terminalHistoryRetention.globalMb,
      terminalHistoryRetentionDays: terminalHistoryRetention.days,
      sshAgentSocketPath,
      defaultProjectsDirectory,
      useHostGitHubCredentials,
      enabledAgentPlatforms,
      favoriteModels,
      openCodeModelProviders,
      agentMessaging,
      notificationSounds,
      ...(reviewLensPresets === undefined ? {} : { reviewLensPresets }),
    } as unknown as AppConfig["global"],
  };
}

/** Drop keys a migration has consumed, so only one shape reaches disk. */
function stripLegacyKeys(record: JsonRecord, keys: readonly string[]): JsonRecord {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

function migrateRepositories(
  repositories: AppConfig["repositories"],
  globalDefaultAgent: AgentPlatform,
): AppConfig["repositories"] {
  if (!isRecord(repositories)) return repositories;
  let changed = false;
  const next: JsonRecord = {};
  for (const [id, repository] of Object.entries(repositories)) {
    if (!isRecord(repository)) {
      next[id] = repository;
      continue;
    }
    const migrated = migrateRepositoryAgentSettings(repository, globalDefaultAgent);
    // An empty tier means "inherit everything", which absence already says, so
    // it is omitted rather than written as a `{}` every repository would carry.
    const agentSettings = isEmptyAgentSettings(migrated) ? undefined : migrated;
    if (JSON.stringify(repository.agentSettings) === JSON.stringify(agentSettings)) {
      next[id] = repository;
      continue;
    }
    changed = true;
    const stripped = stripLegacyKeys({ ...repository }, LEGACY_REPOSITORY_AGENT_KEYS);
    if (agentSettings) stripped.agentSettings = agentSettings;
    else delete stripped.agentSettings;
    next[id] = stripped;
  }
  return changed ? (next as AppConfig["repositories"]) : repositories;
}

export function defaultConfig(): AppConfig {
  return {
    schemaVersion: 2,
    version: "1.0.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [".env", ".env.local"],
      useHostGitHubCredentials: true,
      useHostClaudeCredentials: true,
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      enabledAgentPlatforms: [...LEGACY_ENABLED_AGENT_PLATFORMS],
      coordinatorProviderTierDefaultVersion: COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
      favoriteModels: [],
      agentMessaging: { ...DEFAULT_AGENT_MESSAGING_SETTINGS },
      agentSettings: {
        defaultAgent: "claude",
        platforms: {
          claude: {
            mode: DEFAULT_CLAUDE_MODE,
            model: "claude-sonnet-5-5",
            claudeNativeBackend: "sdk",
          },
          // New installs only. An existing config.json already holds a concrete
          // effort, and nothing records whether the user chose it or merely
          // inherited the previous "medium" default, so migrating would
          // overwrite deliberate choices. Existing installs keep their stored
          // value until the user changes it in settings.
          codex: { mode: "native", model: "gpt-5.4", reasoningEffort: "high" },
          // No model: unset is OpenCode's own default among the connected,
          // allowlisted providers, which no fixed id can match for every login.
          opencode: { mode: "terminal" },
          grok: { mode: "terminal" },
        },
      },
      openCodeModelProviders: [...DEFAULT_OPENCODE_MODEL_PROVIDERS],
      codexMaxConcurrentThreads: DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
      terminalAppearance: {
        fontFamily: "FiraCode Nerd Font",
        fontSize: 14,
        backgroundColor: "#0e1014",
      },
      terminalScrollback: 1000,
      terminalHistoryEnabled: DEFAULT_TERMINAL_HISTORY_ENABLED,
      terminalHistoryRetentionMb: DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
      terminalHistoryGlobalRetentionMb: DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
      terminalHistoryRetentionDays: DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
      experimentalCodexRawEventLogging: true,
      debugLogging: false,
      debugLogRetentionDays: DEFAULT_DEBUG_LOG_RETENTION_DAYS,
      webClientEnabled: true,
      notificationSounds: { ...DEFAULT_NOTIFICATION_SOUND_SETTINGS },
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

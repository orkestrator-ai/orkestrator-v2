import {
  coordinatorWebResearchSetting,
  normalizeCoordinatorResearchMcpServers,
} from "@orkestrator/protocol/coordinator-web-research";
import * as shared from "./storage-shared.js";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  INHERITED_GLOBAL_SETTING_KEYS,
  type InheritedGlobalSettings,
} from "@orkestrator/protocol/controller-settings";
import { normalizeAgentSettings } from "@orkestrator/protocol/agent-settings";
import { normalizeDebugLogRetentionDays } from "@orkestrator/protocol/debug-logging";
import { normalizeNotificationSoundSettings } from "@orkestrator/protocol/notification-sounds";
import {
  COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
  coordinatorProviderTierSetting,
  normalizeCoordinatorProviderTierDefaultVersion,
} from "./coordinator-providers.js";
import { normalizeTerminalHistoryRetention } from "@orkestrator/protocol/terminal-history";
import {
  MAX_SSH_AGENT_SOCKET_PATH_CHARS,
  SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES,
} from "@orkestrator/protocol/ssh-agent-socket";
import { MAX_DEFAULT_PROJECTS_DIRECTORY_CHARS } from "@orkestrator/protocol/project-copy";
import {
  createHash,
  defaultConfig,
  defaultRepositoryConfig,
  firstEnabledAgentPlatform,
  fs,
  getUnscopedLegacyOpenCodeModelCatalog,
  isRecord,
  normalizeAcpModelCatalogEntries,
  normalizeAgentPlatforms,
  normalizeClaudeModelCatalogEntries,
  normalizeCodexModelCatalogEntries,
  normalizeOpenCodeConnectedProviderIds,
  normalizeOpenCodeModelCatalogEntries,
  normalizeOpenCodeModelCatalogProjectId,
  normalizePersistedConfig,
  parseOpenCodeModelCatalogStore,
  parsePersistedAgentModelCatalogCache,
  parseStoredDesktopConnections,
  validateConfigReviewInstruction,
  validateGlobalReviewInstruction,
} from "./storage-shared.js";
import {
  REVIEW_LENS_LABEL_MAX_CHARS,
  REVIEW_LENS_PRESETS_MAX,
  isReviewLensPresetList,
  sanitizeReviewLensPresets,
} from "@orkestrator/protocol/review-lens";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type AgentInteractionPolicy = shared.AgentInteractionPolicy;
type AgentInteractionResolutionJournal = shared.AgentInteractionResolutionJournal;
type StoredDesktopConnections = shared.StoredDesktopConnections;
type FeaturePlanningRecord = shared.FeaturePlanningRecord;
type BuildPipelineAgent = shared.BuildPipelineAgent;
type PaneLayoutMergeInput = shared.PaneLayoutMergeInput;
type PaneLayoutSelectionIntent = shared.PaneLayoutSelectionIntent;
type ConditionalResourceSnapshot<T> = shared.ConditionalResourceSnapshot<T>;
type ResourceChange = shared.ResourceChange;
type ResourceKind = shared.ResourceKind;
type ResourceManifestKind = shared.ResourceManifestKind;
type ResourceRevisionManifest = shared.ResourceRevisionManifest;
type ResourceRevisionMap = shared.ResourceRevisionMap;
type ResourceSnapshotRevision = shared.ResourceSnapshotRevision;
type AgentModel = shared.AgentModel;
type AgentActivityState = shared.AgentActivityState;
type AgentActivitySource = shared.AgentActivitySource;
type AgentModelCatalogCache = shared.AgentModelCatalogCache;
type AppConfig = shared.AppConfig;
type ClaudeModelCatalogSnapshot = shared.ClaudeModelCatalogSnapshot;
type ClaudeModelCatalogEntry = shared.ClaudeModelCatalogEntry;
type CodexModelCatalogEntry = shared.CodexModelCatalogEntry;
type CodexReasoningEffort = shared.CodexReasoningEffort;
type Environment = shared.Environment;
type EnvironmentStatus = shared.EnvironmentStatus;
type EnvironmentType = shared.EnvironmentType;
type OpenCodeModelCatalogEntry = shared.OpenCodeModelCatalogEntry;
type OpenCodeModelCatalogSnapshot = shared.OpenCodeModelCatalogSnapshot;
type PortMapping = shared.PortMapping;
type PrState = shared.PrState;
type Project = shared.Project;
type PersistedPaneLayout = shared.PersistedPaneLayout;
type PersistedMultiReviewWorkflow = shared.PersistedMultiReviewWorkflow;
type PersistedBuildPipeline = shared.PersistedBuildPipeline;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
type PersistedNativeAgentPendingDispatch = shared.PersistedNativeAgentPendingDispatch;
type PersistedComposeDraft = shared.PersistedComposeDraft;
type PersistedFileDraft = shared.PersistedFileDraft;
type PersistedPromptQueue = shared.PersistedPromptQueue;
type PersistedAgentHandoff = shared.PersistedAgentHandoff;
type RepositoryConfig = shared.RepositoryConfig;
type Session = shared.Session;
type SessionType = shared.SessionType;
type JsonRecord = shared.JsonRecord;
type KanbanComment = shared.KanbanComment;
type KanbanImage = shared.KanbanImage;
type KanbanStatus = shared.KanbanStatus;
type MutablePaneLayoutLeaf = shared.MutablePaneLayoutLeaf;
type KanbanTask = shared.KanbanTask;
type ProjectNotes = shared.ProjectNotes;
type FeaturePlanStatus = shared.FeaturePlanStatus;
type FeaturePlanMessage = shared.FeaturePlanMessage;
type FeatureStoryCard = shared.FeatureStoryCard;
type FeaturePlan = shared.FeaturePlan;
type LinearAuth = shared.LinearAuth;
type LinearCompletionComment = shared.LinearCompletionComment;
type GitHubCompletionComment = shared.GitHubCompletionComment;
type LoadedNativeAgentSessions = shared.LoadedNativeAgentSessions;
type PersistedOpenCodeModelCatalogStore = shared.PersistedOpenCodeModelCatalogStore;
type ResourceChangeListener = shared.ResourceChangeListener;

export type StorageLayerTypes = [
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  StoredDesktopConnections,
  FeaturePlanningRecord,
  BuildPipelineAgent,
  PaneLayoutMergeInput,
  PaneLayoutSelectionIntent,
  ConditionalResourceSnapshot<unknown>,
  ResourceChange,
  ResourceKind,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  AgentModel,
  AgentActivityState,
  AgentActivitySource,
  AgentModelCatalogCache,
  AppConfig,
  ClaudeModelCatalogSnapshot,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
  CodexReasoningEffort,
  Environment,
  EnvironmentStatus,
  EnvironmentType,
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalogSnapshot,
  PortMapping,
  PrState,
  Project,
  PersistedPaneLayout,
  PersistedMultiReviewWorkflow,
  PersistedBuildPipeline,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
  PersistedAgentHandoff,
  RepositoryConfig,
  Session,
  SessionType,
  JsonRecord,
  KanbanComment,
  KanbanImage,
  KanbanStatus,
  MutablePaneLayoutLeaf,
  KanbanTask,
  ProjectNotes,
  FeaturePlanStatus,
  FeaturePlanMessage,
  FeatureStoryCard,
  FeaturePlan,
  LinearAuth,
  LinearCompletionComment,
  GitHubCompletionComment,
  LoadedNativeAgentSessions,
  PersistedOpenCodeModelCatalogStore,
  ResourceChangeListener,
];

/**
 * Replace inherited preferences with product defaults before layering a
 * controller snapshot or validating only the machine settings in a save.
 */
function withDefaultInheritedSettings(global: AppConfig["global"]): AppConfig["global"] {
  const values = { ...global } as unknown as Record<string, unknown>;
  const defaults = defaultConfig().global as unknown as Record<string, unknown>;
  for (const key of INHERITED_GLOBAL_SETTING_KEYS) {
    delete values[key];
    if (defaults[key] !== undefined) values[key] = defaults[key];
  }
  return values as unknown as AppConfig["global"];
}

export class ConfigRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.configFile(), "configuration storage", operation);
  }

  /**
   * The settings of the command node this node follows while it is a leaf
   * (see `@orkestrator/protocol/controller-settings`). Set by the backend;
   * `null` (or a provider returning `null`) means this node's own settings.
   */
  inheritedGlobalSettings: (() => InheritedGlobalSettings | null) | null = null;

  /**
   * The settings this node works with: its own config, with the inherited
   * settings of its command node laid over it while it is a leaf. Writers
   * use `loadOwnConfig`, so inherited values are never persisted here.
   */
  async loadConfig(): Promise<AppConfig> {
    return this.withInheritedSettings(await this.loadOwnConfig());
  }

  /** The command node's settings changed: everything that reads config re-reads it. */
  announceInheritedSettingsChanged(): void {
    this.context.changes.announce("config", "app");
  }

  private withInheritedSettings(config: AppConfig): AppConfig {
    const inherited = this.inheritedGlobalSettings?.() ?? null;
    if (!inherited) return config;
    // Each snapshot is complete: omitted preferences mean product defaults,
    // never the leaf's persisted override.
    const global = {
      ...withDefaultInheritedSettings(config.global),
      ...inherited,
    } as AppConfig["global"];
    // The command node's default agent may not be enabled on this node.
    const agentSettings = normalizeAgentSettings(global.agentSettings);
    const enabled = normalizeAgentPlatforms(global.enabledAgentPlatforms, []);
    global.agentSettings =
      enabled.length > 0
        ? {
            ...agentSettings,
            defaultAgent: firstEnabledAgentPlatform(enabled, agentSettings.defaultAgent),
          }
        : agentSettings;
    return { ...config, global };
  }

  /**
   * A whole-config save echoes back what `loadConfig` returned, inherited
   * values included. Those are the command node's, so this node keeps its
   * own value for every inherited key the save did not change.
   */
  private keepOwnInheritedValues(
    incoming: AppConfig["global"],
    own: AppConfig["global"],
  ): AppConfig["global"] {
    const inherited = this.inheritedGlobalSettings?.() ?? null;
    if (!inherited) return incoming;
    const effective = this.withInheritedSettings({
      version: "",
      global: own,
      repositories: {},
    }).global as unknown as Record<string, unknown>;
    const next = { ...incoming } as unknown as Record<string, unknown>;
    const ownValues = own as unknown as Record<string, unknown>;
    for (const key of INHERITED_GLOBAL_SETTING_KEYS) {
      if (!isDeepStrictEqual(next[key], effective[key])) continue;
      if (ownValues[key] === undefined) delete next[key];
      else next[key] = ownValues[key];
    }
    return next as unknown as AppConfig["global"];
  }

  /** This node's own persisted config, without anything inherited from a command node. */
  async loadOwnConfig(): Promise<AppConfig> {
    const configExists = await fs.access(this.files.configFile()).then(
      () => true,
      () => false,
    );
    const config = await this.context.loadJsonCached<AppConfig>(
      this.files.configFile(),
      defaultConfig,
    );
    const normalized = normalizePersistedConfig(config);
    if (configExists) {
      return normalized;
    }
    const sidecar = await this.context.loadJson<unknown>(
      this.files.agentPlatformsFile(),
      () => null,
    );
    if (!sidecar || !isRecord(sidecar)) return normalized;
    const enabledAgentPlatforms = normalizeAgentPlatforms(sidecar.enabled, []);
    return enabledAgentPlatforms.length === 0
      ? normalized
      : {
          ...normalized,
          global: {
            ...normalized.global,
            enabledAgentPlatforms,
            agentSettings: {
              ...normalized.global.agentSettings,
              defaultAgent: firstEnabledAgentPlatform(
                enabledAgentPlatforms,
                normalized.global.agentSettings?.defaultAgent,
              ),
            },
          },
        };
  }

  /**
   * Persist the one-shot schema migration before services begin concurrent
   * reads. Re-read under the same cross-process lock used by every config
   * writer so a stale migration snapshot cannot revert a settings save.
   */
  async migrateConfigSchema(): Promise<void> {
    await this.enqueueConfigMutation(async () => {
      const configExists = await fs.access(this.files.configFile()).then(
        () => true,
        () => false,
      );
      if (!configExists) return;
      const current = await this.context.loadJsonCached<AppConfig>(
        this.files.configFile(),
        defaultConfig,
      );
      const normalized = normalizePersistedConfig(current);
      if (normalized === current) return;
      await this.context.saveSensitiveJson(this.files.configFile(), normalized);
    });
  }

  async saveConfig(
    config: AppConfig,
    options: { preserveCredentials?: boolean } = {},
  ): Promise<void> {
    const validated = validateConfigReviewInstruction(config);
    await this.enqueueConfigMutation(async () => {
      const own = await this.loadOwnConfig();
      const current = options.preserveCredentials ? own : null;
      const ownGlobal = this.keepOwnInheritedValues(validated.global, own.global);
      const next = current
        ? {
            ...validated,
            global: {
              ...ownGlobal,
              ...(current.global.githubToken ? { githubToken: current.global.githubToken } : {}),
              ...(current.global.anthropicApiKey
                ? { anthropicApiKey: current.global.anthropicApiKey }
                : {}),
              ...(current.global.cursorApiKey ? { cursorApiKey: current.global.cursorApiKey } : {}),
              ...(current.global.openCodeZenApiKey
                ? { openCodeZenApiKey: current.global.openCodeZenApiKey }
                : {}),
            },
          }
        : { ...validated, global: ownGlobal };
      await this.context.saveSensitiveJson(this.files.configFile(), next);
    });
    this.context.changes.announce("config", "app");
  }

  async getAgentModelCatalogCache(): Promise<AgentModelCatalogCache> {
    const persisted = await this.context.loadJson<unknown>(
      this.files.agentModelCatalogFile(),
      () => null,
    );
    return parsePersistedAgentModelCatalogCache(persisted);
  }

  /** `StorageService`'s overloads pair each agent with its model type. */
  async cacheAgentModelCatalog(
    agent: "claude" | "codex" | "cursor" | "grok" | "pi",
    models: ClaudeModelCatalogEntry[] | CodexModelCatalogEntry[] | AgentModel[],
  ): Promise<AgentModelCatalogCache> {
    const normalizedModels =
      agent === "claude"
        ? normalizeClaudeModelCatalogEntries(models)
        : agent === "codex"
          ? normalizeCodexModelCatalogEntries(models)
          : normalizeAcpModelCatalogEntries(models, agent);
    if (normalizedModels.length === 0) {
      throw new Error(`${agent} model catalogue must contain at least one valid model.`);
    }

    return this.context.serialize(
      this.files.agentModelCatalogFile(),
      "Agent model catalogue storage",
      async () => {
        const current = await this.getAgentModelCatalogCache();
        const existing = current[agent];
        if (existing && JSON.stringify(existing.models) === JSON.stringify(normalizedModels)) {
          return current;
        }
        const next: AgentModelCatalogCache = {
          ...current,
          [agent]: {
            updatedAt: new Date().toISOString(),
            models: normalizedModels,
          },
        };
        await this.context.saveJson(this.files.agentModelCatalogFile(), next);
        return next;
      },
    );
  }

  async getOpenCodeModelCatalog(projectId: string): Promise<OpenCodeModelCatalogSnapshot | null> {
    const normalizedProjectId = normalizeOpenCodeModelCatalogProjectId(projectId);
    const store = await this.context.loadJson<unknown>(
      this.files.openCodeModelCatalogFile(),
      () => null,
    );
    return parseOpenCodeModelCatalogStore(store)[normalizedProjectId] ?? null;
  }

  /**
   * `connectedProviderIds` is OpenCode's connectivity report from the same
   * read. Omitted, the snapshot keeps the last one it was given, so a catalogue
   * refresh from a source without connectivity cannot erase it.
   */
  async cacheOpenCodeModelCatalog(
    projectId: string,
    models: OpenCodeModelCatalogEntry[],
    connectedProviderIds?: readonly string[],
  ): Promise<OpenCodeModelCatalogSnapshot> {
    const normalizedProjectId = normalizeOpenCodeModelCatalogProjectId(projectId);
    const normalizedModels = normalizeOpenCodeModelCatalogEntries(models);
    const normalizedConnected = normalizeOpenCodeConnectedProviderIds(connectedProviderIds);
    if (normalizedModels.length === 0) {
      throw new Error("OpenCode model catalogue must contain at least one model.");
    }

    const catalogVersion = createHash("sha256")
      .update(JSON.stringify(normalizedModels))
      .digest("hex");

    return this.context.serialize(
      this.files.openCodeModelCatalogFile(),
      "OpenCode model catalogue storage",
      async () => {
        const persisted = await this.context.loadJson<unknown>(
          this.files.openCodeModelCatalogFile(),
          () => null,
        );
        const catalogs = parseOpenCodeModelCatalogStore(persisted);
        const current = catalogs[normalizedProjectId];
        const connectivityChanged =
          normalizedConnected !== undefined &&
          JSON.stringify(normalizedConnected) !== JSON.stringify(current?.connectedProviderIds);
        if (current?.catalogVersion === catalogVersion && !connectivityChanged) return current;

        const now = new Date().toISOString();
        const snapshot: OpenCodeModelCatalogSnapshot = {
          schemaVersion: 2,
          projectId: normalizedProjectId,
          catalogVersion,
          updatedAt: current?.catalogVersion === catalogVersion ? current.updatedAt : now,
          models: normalizedModels,
          ...(normalizedConnected
            ? { connectedProviderIds: normalizedConnected, connectedProvidersCheckedAt: now }
            : current?.connectedProviderIds && current.connectedProvidersCheckedAt
              ? {
                  connectedProviderIds: current.connectedProviderIds,
                  connectedProvidersCheckedAt: current.connectedProvidersCheckedAt,
                }
              : {}),
        };
        catalogs[normalizedProjectId] = snapshot;
        const legacyUnscoped = getUnscopedLegacyOpenCodeModelCatalog(persisted);
        const store: PersistedOpenCodeModelCatalogStore = {
          schemaVersion: 2,
          catalogs,
          ...(legacyUnscoped === undefined ? {} : { legacyUnscoped }),
        };
        await this.context.saveJson(this.files.openCodeModelCatalogFile(), store);
        return snapshot;
      },
    );
  }

  async getDesktopConnections(): Promise<StoredDesktopConnections> {
    const config = await this.loadConfig();
    if (config.desktopConnections === undefined)
      return { activeConnectionId: "local", connections: [] };
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
      const config = await this.loadOwnConfig();
      config.desktopConnections = validated;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
    });
    this.context.changes.announce("config", "app");
  }

  async getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
    const config = await this.loadConfig();
    return config.repositories[projectId] ?? defaultRepositoryConfig();
  }

  async updateRepositoryConfig(
    projectId: string,
    repoConfig: RepositoryConfig,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      config.repositories[projectId] = { ...defaultRepositoryConfig(), ...repoConfig };
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  /**
   * Update user-editable repository settings without accepting a stale renderer
   * echo for state owned by successful environment creation.
   */
  async updateRepositorySettings(
    projectId: string,
    repoConfig: RepositoryConfig,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      const current = config.repositories[projectId] ?? defaultRepositoryConfig();
      const userSettings = { ...repoConfig };
      delete userSettings.lastEnvironmentType;
      delete userSettings.lastEnvironmentAgentSelection;
      config.repositories[projectId] = {
        ...defaultRepositoryConfig(),
        ...userSettings,
        ...(current.lastEnvironmentType !== undefined
          ? { lastEnvironmentType: current.lastEnvironmentType }
          : {}),
        ...(current.lastEnvironmentAgentSelection !== undefined
          ? {
              lastEnvironmentAgentSelection: current.lastEnvironmentAgentSelection,
            }
          : {}),
      };
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  /** Atomically patch backend-owned repository state under the config lock. */
  async patchRepositoryConfig(
    projectId: string,
    updates: Partial<RepositoryConfig>,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      const current = config.repositories[projectId] ?? defaultRepositoryConfig();
      config.repositories[projectId] = {
        ...defaultRepositoryConfig(),
        ...current,
        ...updates,
      };
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  async updateGlobalConfig(
    globalConfig: AppConfig["global"],
    options: { preserveCredentials?: boolean; preserveInheritedSettings?: boolean } = {},
  ): Promise<AppConfig> {
    const reviewValidated = validateGlobalReviewInstruction(
      options.preserveInheritedSettings ? withDefaultInheritedSettings(globalConfig) : globalConfig,
    );
    const enabledAgentPlatforms = normalizeAgentPlatforms(
      reviewValidated.enabledAgentPlatforms,
      [],
    );
    if (enabledAgentPlatforms.length === 0) {
      throw new Error("Select at least one agent platform");
    }
    // The renderer writes the whole agent-settings block, so a malformed or
    // partial entry must be dropped here rather than persisted and later
    // applied to a launch the user cannot see being configured.
    const agentSettings = normalizeAgentSettings(reviewValidated.agentSettings);
    const terminalHistoryRetention = normalizeTerminalHistoryRetention({
      enabled: reviewValidated.terminalHistoryEnabled,
      sessionMb: reviewValidated.terminalHistoryRetentionMb,
      globalMb: reviewValidated.terminalHistoryGlobalRetentionMb,
      days: reviewValidated.terminalHistoryRetentionDays,
    });
    const rawSshAgentSocketPath = reviewValidated.sshAgentSocketPath as unknown;
    if (rawSshAgentSocketPath !== undefined && typeof rawSshAgentSocketPath !== "string") {
      throw new Error("SSH agent socket path must be a string");
    }
    const requestedSshAgentSocketPath = rawSshAgentSocketPath?.trim();
    if (requestedSshAgentSocketPath) {
      if (requestedSshAgentSocketPath.length > MAX_SSH_AGENT_SOCKET_PATH_CHARS) {
        throw new Error(SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES.tooLong);
      }
      if (requestedSshAgentSocketPath.includes("\0")) {
        throw new Error(SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES.containsNull);
      }
      if (!path.isAbsolute(requestedSshAgentSocketPath)) {
        throw new Error(SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES.notAbsolute);
      }
    }
    const rawDefaultProjectsDirectory = reviewValidated.defaultProjectsDirectory as unknown;
    if (
      rawDefaultProjectsDirectory !== undefined &&
      typeof rawDefaultProjectsDirectory !== "string"
    ) {
      throw new Error("Default projects folder must be a string");
    }
    const requestedDefaultProjectsDirectory = rawDefaultProjectsDirectory?.trim();
    if (requestedDefaultProjectsDirectory) {
      if (
        requestedDefaultProjectsDirectory.length > MAX_DEFAULT_PROJECTS_DIRECTORY_CHARS ||
        requestedDefaultProjectsDirectory.includes("\0") ||
        !path.isAbsolute(requestedDefaultProjectsDirectory)
      ) {
        throw new Error("Default projects folder must be an absolute path");
      }
    }
    // A launcher copies a preset's text into the reviewer it starts, so a list
    // that breaks the bounds is refused here rather than trimmed.
    const reviewLensPresets = reviewValidated.reviewLensPresets as unknown;
    if (reviewLensPresets !== undefined && !isReviewLensPresetList(reviewLensPresets)) {
      throw new Error(
        `Review focus presets must be at most ${REVIEW_LENS_PRESETS_MAX} presets with distinct ids, each with a label of at most ${REVIEW_LENS_LABEL_MAX_CHARS} characters and an instruction of at most 4 KiB`,
      );
    }
    const validated: AppConfig["global"] = {
      ...reviewValidated,
      ...(reviewLensPresets === undefined
        ? {}
        : { reviewLensPresets: sanitizeReviewLensPresets(reviewLensPresets) }),
      notificationSounds: normalizeNotificationSoundSettings(reviewValidated.notificationSounds),
      sshAgentSocketPath: requestedSshAgentSocketPath || undefined,
      defaultProjectsDirectory: requestedDefaultProjectsDirectory || undefined,
      debugLogRetentionDays: normalizeDebugLogRetentionDays(reviewValidated.debugLogRetentionDays),
      terminalHistoryEnabled: terminalHistoryRetention.enabled,
      terminalHistoryRetentionMb: terminalHistoryRetention.sessionMb,
      terminalHistoryGlobalRetentionMb: terminalHistoryRetention.globalMb,
      terminalHistoryRetentionDays: terminalHistoryRetention.days,
      enabledAgentPlatforms,
      // Missing follows the product default. Malformed input fails closed to
      // enforced rather than widening the read-only boundary.
      coordinatorProviderTiers: coordinatorProviderTierSetting(
        reviewValidated.coordinatorProviderTiers,
      ),
      coordinatorProviderTierDefaultVersion: normalizeCoordinatorProviderTierDefaultVersion(
        reviewValidated.coordinatorProviderTierDefaultVersion,
      ),
      // Missing follows the product default. A malformed mode fails closed to
      // `off`; an unacceptable research server is dropped, never repaired.
      ...(reviewValidated.coordinatorWebResearch === undefined
        ? {}
        : {
            coordinatorWebResearch: coordinatorWebResearchSetting(
              reviewValidated.coordinatorWebResearch,
            ),
          }),
      ...(reviewValidated.coordinatorResearchMcpServers === undefined
        ? {}
        : {
            coordinatorResearchMcpServers: normalizeCoordinatorResearchMcpServers(
              reviewValidated.coordinatorResearchMcpServers,
            ),
          }),
      agentSettings: {
        ...agentSettings,
        defaultAgent: firstEnabledAgentPlatform(enabledAgentPlatforms, agentSettings.defaultAgent),
      },
    };
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      validated.coordinatorProviderTierDefaultVersion = Math.max(
        validated.coordinatorProviderTierDefaultVersion ??
          COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
        normalizeCoordinatorProviderTierDefaultVersion(
          config.global.coordinatorProviderTierDefaultVersion,
        ),
      );
      // Backend-owned rollout gate: a renderer settings save that does not
      // carry it must not silently re-enable a switched-off feature.
      if (validated.mcpManagement === undefined && config.global.mcpManagement !== undefined)
        validated.mcpManagement = config.global.mcpManagement;
      if (
        validated.containerResourceLimits === undefined &&
        config.global.containerResourceLimits !== undefined
      )
        validated.containerResourceLimits = config.global.containerResourceLimits;
      // Written only by `updateWorktreeLocations`; the settings form never sends it.
      if (config.global.worktreeLocations !== undefined)
        validated.worktreeLocations = config.global.worktreeLocations;
      else delete validated.worktreeLocations;
      // Written only by `setGitHubCliReminderDismissed`, likewise.
      if (config.global.githubCliReminderDismissed) validated.githubCliReminderDismissed = true;
      else delete validated.githubCliReminderDismissed;
      const ownGlobal = this.keepOwnInheritedValues(validated, config.global);
      if (options.preserveInheritedSettings) {
        // A leaf-window save routes preferences separately. Its machine save
        // must preserve local preferences even if a newer sync arrived first.
        for (const key of INHERITED_GLOBAL_SETTING_KEYS) {
          delete ownGlobal[key];
          if (config.global[key] !== undefined)
            Object.assign(ownGlobal, { [key]: config.global[key] });
        }
      }
      config.global = options.preserveCredentials
        ? {
            ...ownGlobal,
            ...(config.global.githubToken ? { githubToken: config.global.githubToken } : {}),
            ...(config.global.anthropicApiKey
              ? { anthropicApiKey: config.global.anthropicApiKey }
              : {}),
            ...(config.global.cursorApiKey ? { cursorApiKey: config.global.cursorApiKey } : {}),
            ...(config.global.openCodeZenApiKey
              ? { openCodeZenApiKey: config.global.openCodeZenApiKey }
              : {}),
          }
        : ownGlobal;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  /** Replace where new worktrees are created; paths are validated by the caller. */
  async updateWorktreeLocations(
    locations: import("@orkestrator/protocol/disk-usage").WorktreeLocationSettings,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      const next = {
        ...(locations.environments ? { environments: locations.environments } : {}),
        ...(locations.dev ? { dev: locations.dev } : {}),
      };
      if (Object.keys(next).length > 0) config.global.worktreeLocations = next;
      else delete config.global.worktreeLocations;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  /** Atomically replace the backend-owned MCP management rollout gate. */
  async updateMcpManagementRollout(
    settings: import("@orkestrator/protocol/mcp-management").McpManagementRolloutSettings,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      config.global = { ...config.global, mcpManagement: settings };
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  /** Atomically patch renderer-owned sound preferences without replacing global config. */
  async updateNotificationSoundSettings(settings: unknown): Promise<AppConfig> {
    const notificationSounds = normalizeNotificationSoundSettings(settings);
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      config.global = {
        ...config.global,
        notificationSounds,
      };
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  /**
   * The Settings → Container budget for new runtimes. `undefined` removes it,
   * so new runtimes get the built-in default; a budget whose limits are all
   * `null` is explicitly unrestricted. A settings save that omits the field
   * keeps it, so this is the only way to remove it.
   */
  async setContainerResourceLimits(
    limits: import("@orkestrator/protocol/container-resources").ContainerResourceLimits | undefined,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      if (limits) config.global.containerResourceLimits = limits;
      else delete config.global.containerResourceLimits;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  /** Turn the startup GitHub CLI reminder off, or back on. */
  async setGitHubCliReminderDismissed(dismissed: boolean): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      if (dismissed) config.global.githubCliReminderDismissed = true;
      else delete config.global.githubCliReminderDismissed;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  async setGitHubToken(token: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      if (token === null) delete config.global.githubToken;
      else config.global.githubToken = token;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  async setCursorApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      if (apiKey === null) delete config.global.cursorApiKey;
      else config.global.cursorApiKey = apiKey;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  async setAnthropicApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      if (apiKey === null) delete config.global.anthropicApiKey;
      else config.global.anthropicApiKey = apiKey;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }

  async setOpenCodeZenApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadOwnConfig();
      if (apiKey === null) delete config.global.openCodeZenApiKey;
      else config.global.openCodeZenApiKey = apiKey;
      await this.context.saveSensitiveJson(this.files.configFile(), config);
      this.context.changes.announce("config", "app");
      return this.withInheritedSettings(config);
    });
  }
}

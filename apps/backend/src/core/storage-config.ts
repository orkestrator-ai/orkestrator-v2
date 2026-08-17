import * as shared from "./storage-shared.js";
import { normalizeActionDefaults } from "@orkestrator/protocol/action-defaults";
import {
  createHash,
  defaultConfig,
  defaultRepositoryConfig,
  firstEnabledAgentPlatform,
  fs,
  getUnscopedLegacyOpenCodeModelCatalog,
  isAgentPlatform,
  isRecord,
  normalizeAcpModelCatalogEntries,
  normalizeAgentPlatforms,
  normalizeClaudeModelCatalogEntries,
  normalizeCodexModelCatalogEntries,
  normalizeOpenCodeModelCatalogEntries,
  normalizeOpenCodeModelCatalogProjectId,
  normalizePersistedConfig,
  parseOpenCodeModelCatalogStore,
  parsePersistedAgentModelCatalogCache,
  parseStoredDesktopConnections,
  validateConfigReviewInstruction,
  validateGlobalReviewInstruction,
} from "./storage-shared.js";
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
type AgentModelConfigKey = shared.AgentModelConfigKey;
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
type PersistedLoopedReviewWorkflow = shared.PersistedLoopedReviewWorkflow;
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

import { StorageProjects } from "./storage-projects.ts";

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
    AgentModelConfigKey,
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
    PersistedLoopedReviewWorkflow,
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
    ResourceChangeListener
];

export abstract class StorageConfig extends StorageProjects {
  async loadConfig(): Promise<AppConfig> {
    const configExists = await fs.access(this.configFile()).then(
      () => true,
      () => false,
    );
    const config = await this.loadJsonCached<AppConfig>(this.configFile(), defaultConfig);
    const normalized = normalizePersistedConfig(config);
    if (configExists) return normalized;
    const sidecar = await this.loadJson<unknown>(
      this.agentPlatformsFile(),
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
            defaultAgent: firstEnabledAgentPlatform(
              enabledAgentPlatforms,
              normalized.global.defaultAgent,
            ),
          },
        };
  }

  async saveConfig(
    config: AppConfig,
    options: { preserveCredentials?: boolean } = {},
  ): Promise<void> {
    const validated = validateConfigReviewInstruction(config);
    await this.enqueueConfigMutation(async () => {
      const current = options.preserveCredentials ? await this.loadConfig() : null;
      const next = current
        ? {
            ...validated,
            global: {
              ...validated.global,
              ...(current.global.githubToken
                ? { githubToken: current.global.githubToken }
                : {}),
              ...(current.global.anthropicApiKey
                ? { anthropicApiKey: current.global.anthropicApiKey }
                : {}),
              ...(current.global.cursorApiKey
                ? { cursorApiKey: current.global.cursorApiKey }
                : {}),
            },
          }
        : validated;
      await this.saveJson(this.configFile(), next);
    });
    this.announce("config", "app");
  }

  async getAgentModelCatalogCache(): Promise<AgentModelCatalogCache> {
    const persisted = await this.loadJson<unknown>(
      this.agentModelCatalogFile(),
      () => null,
    );
    return parsePersistedAgentModelCatalogCache(persisted);
  }

  async cacheAgentModelCatalog(
    agent: "claude",
    models: ClaudeModelCatalogEntry[],
  ): Promise<AgentModelCatalogCache>;
  async cacheAgentModelCatalog(
    agent: "codex",
    models: CodexModelCatalogEntry[],
  ): Promise<AgentModelCatalogCache>;
  async cacheAgentModelCatalog(
    agent: "cursor" | "grok",
    models: AgentModel[],
  ): Promise<AgentModelCatalogCache>;
  async cacheAgentModelCatalog(
    agent: "claude" | "codex" | "cursor" | "grok",
    models: ClaudeModelCatalogEntry[] | CodexModelCatalogEntry[] | AgentModel[],
  ): Promise<AgentModelCatalogCache> {
    const normalizedModels = agent === "claude"
      ? normalizeClaudeModelCatalogEntries(models)
      : agent === "codex"
        ? normalizeCodexModelCatalogEntries(models)
        : normalizeAcpModelCatalogEntries(models, agent);
    if (normalizedModels.length === 0) {
      throw new Error(`${agent} model catalogue must contain at least one valid model.`);
    }

    const run = async () => {
      const release = await this.acquireMutationLock(
        this.agentModelCatalogFile(),
        "Agent model catalogue storage",
      );
      try {
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
        await this.saveJson(this.agentModelCatalogFile(), next);
        return next;
      } finally {
        await release();
      }
    };

    const next = this.agentModelCatalogMutationQueue.then(run, run);
    this.agentModelCatalogMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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

  /**
   * Update user-editable repository settings without accepting a stale renderer
   * echo for state owned by successful environment creation.
   */
  async updateRepositorySettings(
    projectId: string,
    repoConfig: RepositoryConfig,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
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
              lastEnvironmentAgentSelection:
                current.lastEnvironmentAgentSelection,
            }
          : {}),
      };
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  /** Atomically patch backend-owned repository state under the config lock. */
  async patchRepositoryConfig(
    projectId: string,
    updates: Partial<RepositoryConfig>,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      const current = config.repositories[projectId] ?? defaultRepositoryConfig();
      config.repositories[projectId] = {
        ...defaultRepositoryConfig(),
        ...current,
        ...updates,
      };
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async updateGlobalConfig(
    globalConfig: AppConfig["global"],
    options: { preserveCredentials?: boolean } = {},
  ): Promise<AppConfig> {
    const reviewValidated = validateGlobalReviewInstruction(globalConfig);
    const enabledAgentPlatforms = normalizeAgentPlatforms(
      reviewValidated.enabledAgentPlatforms,
      [],
    );
    if (enabledAgentPlatforms.length === 0) {
      throw new Error("Select at least one agent platform");
    }
    const validated: AppConfig["global"] = {
      ...reviewValidated,
      enabledAgentPlatforms,
      defaultAgent: firstEnabledAgentPlatform(
        enabledAgentPlatforms,
        isAgentPlatform(reviewValidated.defaultAgent)
          ? reviewValidated.defaultAgent
          : undefined,
      ),
      // The renderer writes this object wholesale, so a malformed or partial
      // entry must be dropped here rather than persisted and later applied to
      // a launch the user cannot see being configured.
      actionDefaults: normalizeActionDefaults(reviewValidated.actionDefaults),
    };
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.global = options.preserveCredentials
        ? {
            ...validated,
            ...(config.global.githubToken
              ? { githubToken: config.global.githubToken }
              : {}),
            ...(config.global.anthropicApiKey
              ? { anthropicApiKey: config.global.anthropicApiKey }
              : {}),
            ...(config.global.cursorApiKey
              ? { cursorApiKey: config.global.cursorApiKey }
              : {}),
          }
        : validated;
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

  async setCursorApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      if (apiKey === null) delete config.global.cursorApiKey;
      else config.global.cursorApiKey = apiKey;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async setAnthropicApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      if (apiKey === null) delete config.global.anthropicApiKey;
      else config.global.anthropicApiKey = apiKey;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }


}

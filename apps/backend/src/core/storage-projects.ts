import { MAX_LIFECYCLE_RECORD_BYTES } from "@orkestrator/protocol/container-lifecycle";
import { parseResourceLimits } from "@orkestrator/protocol/container-resources";
import * as shared from "./storage-shared.js";
import {
  MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES,
  serializedInitialPromptAttachmentBytes,
  toDurableInitialPromptAttachments,
} from "@orkestrator/protocol/initial-prompt-attachments";
import {
  LEGACY_ENVIRONMENT_AGENT_KEYS,
  migrateEnvironmentAgentSettings,
} from "./storage-agent-settings.js";
import { isEmptyAgentSettings, normalizeAgentSettings } from "@orkestrator/protocol/agent-settings";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { isTrustedUserPromptPresentation } from "@orkestrator/protocol/review-evidence-frames";
import { withoutUrlCredentials } from "@orkestrator/protocol/git-remote-url";
import { normalizeProjectIcon } from "@orkestrator/protocol/project-icon";
import { isPrMergeability } from "@orkestrator/protocol/pr-merge-readiness";
import { parseEnvironmentDiffBaseOverride } from "@orkestrator/protocol/diff-stats";
import type { AgentActivityCompletionOutcome, EnvironmentUnreadReason } from "./models.js";
import {
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  AGENT_ACTIVITY_SOURCES,
  AGENT_ACTIVITY_STATES,
  FRONTEND_AGENT_ACTIVITY_LEASE_MS,
  MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS,
  agentActivityStructureFingerprint,
  aggregateEnvironmentAgentActivity,
  frontendAgentActivityObserverKey,
  isAgentActivityTimestamp,
  isClaudeModelCatalogSnapshot,
  isInitialPromptImageAttachment,
  isNonBlankString,
  isOneOf,
  isPortMapping,
  isPortNumber,
  isPositiveInteger,
  isRecord,
  isStartupAgentSession,
  isTabTeardownKind,
  nextAgentActivityTimestamp,
  parseUsableAgentActivityTime,
  readAgentActivitySources,
  readFrontendAgentActivityObservers,
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

import type { WorktreeMoveRecord } from "./models.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeProjectFolderName } from "@orkestrator/protocol/project-folders";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";

/**
 * Writes a folder assignment onto a project record.
 *
 * The key is deleted rather than set to null when membership is cleared, so a
 * project that has never been foldered and one that was dragged back out
 * serialize identically. That keeps projects.json from accumulating a null
 * folder on every record the first time anyone uses the feature.
 */
export function applyProjectFolder(project: Project, folder: unknown): void {
  const normalized = normalizeProjectFolderName(folder);
  if (normalized) project.folder = normalized;
  else delete project.folder;
}

/** Sets or clears a project's sidebar icon; blank or null clears it. */
export function applyProjectIcon(project: Project, icon: unknown): void {
  if (icon === null || icon === undefined || icon === "") {
    delete project.icon;
    return;
  }
  const normalized = normalizeProjectIcon(icon);
  if (!normalized) throw new Error("Project icon must be a small PNG, JPEG, WebP or GIF image");
  project.icon = normalized;
}

/** Validates a durable environment-move record; paths are absolute and bounded. */
export function parseWorktreeMoveRecord(value: unknown): WorktreeMoveRecord {
  if (!isRecord(value)) throw new Error("Invalid worktree move record");
  const absolute = (field: string, candidate: unknown): string => {
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      candidate.length > 4096 ||
      candidate.includes("\0")
    ) {
      throw new Error(`Invalid worktree move ${field}`);
    }
    return candidate;
  };
  if (value.phase !== "moving" && value.phase !== "copied" && value.phase !== "committed") {
    throw new Error("Invalid worktree move phase");
  }
  if (typeof value.startedAt !== "string" || value.startedAt.length > 64) {
    throw new Error("Invalid worktree move start time");
  }
  if (value.removeSource !== undefined && typeof value.removeSource !== "boolean") {
    throw new Error("Invalid worktree move source cleanup flag");
  }
  if (value.sourceCleaned !== undefined && typeof value.sourceCleaned !== "boolean")
    throw new Error("Invalid worktree move cleanup completion");
  if (
    value.sourceIdentity !== undefined &&
    (!isRecord(value.sourceIdentity) ||
      !Number.isSafeInteger(value.sourceIdentity.dev) ||
      !Number.isSafeInteger(value.sourceIdentity.ino) ||
      (value.sourceIdentity.dev as number) < 0 ||
      (value.sourceIdentity.ino as number) < 0)
  )
    throw new Error("Invalid worktree move source identity");
  let submodules: WorktreeMoveRecord["submodules"];
  if (value.submodules !== undefined) {
    if (!Array.isArray(value.submodules) || value.submodules.length > 10_000) {
      throw new Error("Invalid worktree move submodules");
    }
    submodules = value.submodules.map((entry: unknown) => {
      const relative = isRecord(entry) ? entry.path : undefined;
      if (
        !isRecord(entry) ||
        typeof relative !== "string" ||
        !relative ||
        path.isAbsolute(relative) ||
        relative.length > 4096 ||
        relative.includes("\0") ||
        relative.split(/[\\/]/).some((segment) => segment === "" || segment === "..")
      ) {
        throw new Error("Invalid worktree move submodule path");
      }
      return { path: relative, gitDir: absolute("submodule git dir", entry.gitDir) };
    });
  }
  return {
    from: absolute("source", value.from),
    to: absolute("destination", value.to),
    ...(value.staging === undefined ? {} : { staging: absolute("staging path", value.staging) }),
    ...(value.fromCanonical === undefined
      ? {}
      : { fromCanonical: absolute("canonical source", value.fromCanonical) }),
    ...(value.fromRoot === undefined ? {} : { fromRoot: absolute("source root", value.fromRoot) }),
    ...(value.removeSource === undefined ? {} : { removeSource: value.removeSource === true }),
    ...(value.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: value.sourceIdentity as { dev: number; ino: number } }),
    ...(value.sourceCleaned === undefined ? {} : { sourceCleaned: value.sourceCleaned === true }),
    ...(submodules ? { submodules } : {}),
    phase: value.phase,
    startedAt: value.startedAt,
  };
}

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

const MAX_PROJECT_REMOVAL_FENCES = 1_000;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

/** A project still owns environments; removal would orphan them. */
export class ProjectHasEnvironmentsError extends Error {
  constructor(
    readonly projectId: string,
    readonly environmentCount: number,
  ) {
    super(`Project has ${environmentCount} environment(s); delete them before removing it`);
    this.name = "ProjectHasEnvironmentsError";
  }
}

/** A control request ID was reused with a different creation intent. */
export class ControlRequestConflictError extends Error {
  constructor(
    readonly controlRequestId: string,
    readonly environmentId: string,
  ) {
    super("controlRequestId was already used with a different environment request");
    this.name = "ControlRequestConflictError";
  }
}

export class ProjectsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  enqueueEnvironmentMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.environmentsFile(), "environment storage", operation);
  }

  /** Serializes every project-store read-modify-write across processes. */
  enqueueProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.projectsFile(), "project storage", operation);
  }

  /**
   * Reserves one canonical local path for the complete repository creation
   * transaction. The hashed lease name avoids putting user paths in storage
   * or logs while still coordinating backend processes that share dataDir.
   *
   * The default acquire timeout covers one critical section: scratch creation
   * spans `git init`, a commit, `gh repo create` and a push (310s), and a path
   * key may be held across a 600s clone. Callers that nest a path-key wait
   * inside a Git-URL lock must pass a larger `acquireTimeoutMs` so a waiter
   * can outlast that composed hold. The stale threshold must survive a holder
   * whose event loop stalls — otherwise two backends enter and one rolls back
   * the other's work.
   */
  private static readonly PROJECT_CREATION_LOCK_STALE_MS = 90_000;

  private static readonly PROJECT_CREATION_LOCK_TIMEOUT_MS = 660_000;

  async withProjectCreationLock<T>(
    canonicalProjectPath: string,
    operation: () => Promise<T>,
    options?: { acquireTimeoutMs?: number },
  ): Promise<T> {
    const key = createHash("sha256").update(canonicalProjectPath).digest("hex");
    return this.context.serialize(
      this.context.file(path.join("project-creation-locks", key)),
      "project creation",
      operation,
      {
        staleMs: ProjectsRepository.PROJECT_CREATION_LOCK_STALE_MS,
        acquireTimeoutMs:
          options?.acquireTimeoutMs ?? ProjectsRepository.PROJECT_CREATION_LOCK_TIMEOUT_MS,
      },
    );
  }

  async loadProjects(): Promise<Project[]> {
    const projects = await this.context.loadJsonCached<Project[]>(
      this.files.projectsFile(),
      () => [],
    );
    return projects.sort((a, b) => a.order - b.order);
  }

  /**
   * `validate` runs inside the projects.json critical section, so a caller that
   * must reject against the *current* stored set — a duplicate local path, say
   * — cannot be raced by a concurrent writer between its own check and this
   * insert.
   */
  async addProject(
    project: Project,
    validate?: (projects: Project[]) => void | Promise<void>,
  ): Promise<Project> {
    const added = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      if (projects.some((candidate) => candidate.gitUrl === project.gitUrl)) {
        throw new Error(`Duplicate project URL: ${project.gitUrl}`);
      }
      if (validate) await validate(projects);

      project.order = Math.max(-1, ...projects.map((item) => item.order)) + 1;
      projects.push(project);
      await this.context.saveJson(this.files.projectsFile(), projects);
      return project;
    });
    this.context.changes.announce("project", project.id);
    return added;
  }

  async removeProject(projectId: string): Promise<void> {
    await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const filtered = projects.filter((project) => project.id !== projectId);
      if (filtered.length === projects.length) throw new Error(`Project not found: ${projectId}`);
      await this.context.saveJson(this.files.projectsFile(), filtered);
    });
    await this.repos.drafts.deleteComposeDraftsByProject(projectId);
    // A project's permission rules have nothing left to answer for (todo 0723).
    try {
      this.repos.permissionRules.store().deleteForProject(projectId);
    } catch (error) {
      console.warn(
        `[backend] permission rule cleanup failed for ${projectId}:`,
        error instanceof Error ? error.name : "unknown",
      );
    }
    // Its template trust records and capability ceiling (item 109) go with it.
    this.repos.graphTemplates.deleteGraphProjectSettings(projectId);
    this.context.changes.announce("project", projectId, undefined, undefined, true);
  }

  async getProject(projectId: string): Promise<Project | null> {
    return (await this.loadProjects()).find((project) => project.id === projectId) ?? null;
  }

  async updateProject(
    projectId: string,
    updates: Partial<Pick<Project, "name" | "gitUrl" | "localPath" | "folder" | "icon">>,
  ): Promise<Project> {
    const project = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (typeof updates.gitUrl === "string") {
        // A repository that moved keeps its project: settings, environments,
        // and history are keyed by project id, not by remote URL.
        const gitUrl = withoutUrlCredentials(updates.gitUrl.trim());
        if (!gitUrl) throw new Error("Git URL cannot be empty");
        if (
          projects.some((candidate) => candidate.id !== projectId && candidate.gitUrl === gitUrl)
        ) {
          throw new Error(`Duplicate project URL: ${gitUrl}`);
        }
        project.gitUrl = gitUrl;
      }
      if (typeof updates.name === "string") project.name = updates.name;
      if ("localPath" in updates) project.localPath = updates.localPath ?? null;
      if ("folder" in updates) applyProjectFolder(project, updates.folder);
      if ("icon" in updates) applyProjectIcon(project, updates.icon);
      await this.context.saveJson(this.files.projectsFile(), projects);
      return project;
    });
    this.context.changes.announce("project", projectId);
    return project;
  }

  async reorderProjects(projectIds: string[]): Promise<Project[]> {
    return this.arrangeProjects(projectIds);
  }

  /**
   * Reorders the sidebar and moves projects between folders in one write.
   *
   * A folder drag changes both at once — a project lands in a new folder *and*
   * at a new position — and the sidebar derives a folder's position from its
   * first member. Persisting the two halves as separate mutations would let a
   * client observe the intermediate state, in which the folder has jumped to
   * wherever the moved project used to be.
   */
  async arrangeProjects(
    projectIds: string[],
    folders: Readonly<Record<string, string | null>> = {},
  ): Promise<Project[]> {
    const projects = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const byId = new Map(projects.map((project) => [project.id, project]));
      for (const [projectId, folder] of Object.entries(folders)) {
        const project = byId.get(projectId);
        // A project deleted by another client is not an error here: the caller
        // computed this arrangement against a snapshot that still had it, and
        // failing the whole write would discard every other move it made.
        if (project) applyProjectFolder(project, folder);
      }

      const provided = new Set(projectIds);
      for (const [index, id] of projectIds.entries()) {
        const project = byId.get(id);
        if (project) project.order = index;
      }

      let order = projectIds.length;
      for (const project of projects) {
        if (!provided.has(project.id)) project.order = order++;
      }

      await this.context.saveJson(this.files.projectsFile(), projects);
      return projects.sort((a, b) => a.order - b.order);
    });
    for (const project of projects) this.context.changes.announce("project", project.id);
    return projects;
  }

  /** Destructive reconciliation needs a complete owner set, never a fallback. */
  async loadEnvironmentIdsForCleanup(): Promise<Set<string>> {
    const snapshot = this.context.loadStoreStrict<unknown>(this.files.environmentsFile());
    if (!snapshot || !Array.isArray(snapshot.value)) {
      throw new Error("Environment store is missing or invalid; cleanup refused");
    }
    const ids = new Set<string>();
    for (const environment of snapshot.value) {
      if (!isRecord(environment) || !isNonBlankString(environment.id) || ids.has(environment.id)) {
        throw new Error("Environment owner is invalid; cleanup refused");
      }
      ids.add(environment.id);
    }
    return ids;
  }

  async loadEnvironments(): Promise<Environment[]> {
    const environments = await this.context.loadJsonCached<Environment[]>(
      this.files.environmentsFile(),
      () => [],
    );
    // One-release migration for records written before setupPhase existed.
    // The backend remains authoritative even before the next mutation persists
    // the normalized fields.
    for (const environment of environments) {
      environment.setupPhase ??= environment.setupScriptsComplete ? "ready" : "pending";
      environment.setupOverride ??= false;
      // Fold the five per-platform agent fields onto the shared tier shape. The
      // legacy keys are deleted here rather than left beside the new block, so
      // a stale value cannot be read back by anything that still remembers the
      // old name and the two shapes cannot drift while both sit on disk.
      const migrated = migrateEnvironmentAgentSettings(
        environment as unknown as Record<string, unknown>,
      );
      // Absence already means "inherit everything", so an empty tier is not
      // written back onto every environment record.
      if (isEmptyAgentSettings(migrated)) delete environment.agentSettings;
      else environment.agentSettings = migrated;
      for (const key of LEGACY_ENVIRONMENT_AGENT_KEYS) {
        delete (environment as unknown as Record<string, unknown>)[key];
      }
    }
    return environments.sort((a, b) => a.order - b.order);
  }

  async saveEnvironments(
    environments: Environment[],
    options: { backup?: boolean } = {},
  ): Promise<void> {
    // Launch attachments can contain full base64 image payloads. Treat the
    // complete environment store and every rotated backup as sensitive.
    await this.context.saveSensitiveJson(this.files.environmentsFile(), environments, options);
  }

  /**
   * Makes superseded launch attachments (or a deleted environment record)
   * unrecoverable after the environment write that removed them committed.
   * Runs while the environment mutation lock is held.
   */
  private async scrubEnvironmentBackups(
    environmentId: string,
    removeEnvironment: boolean,
  ): Promise<void> {
    this.context.scrubLegacyArchive("environments", (value) => {
      if (!Array.isArray(value)) throw new Error("Unattributable environment archive");
      return value
        .filter((entry) => !removeEnvironment || !isRecord(entry) || entry.id !== environmentId)
        .map((entry) => {
          if (!isRecord(entry) || entry.id !== environmentId) return entry;
          const next = { ...entry };
          delete next.initialPromptAttachments;
          return next;
        });
    });
    this.context.scrubDeletedDatabaseContent();
  }

  async getEnvironmentsByProject(projectId: string): Promise<Environment[]> {
    return (await this.loadEnvironments()).filter(
      (environment) => environment.projectId === projectId,
    );
  }

  async getEnvironment(environmentId: string): Promise<Environment | null> {
    return (
      (await this.loadEnvironments()).find((environment) => environment.id === environmentId) ??
      null
    );
  }

  private projectRemovalFencesFile(): string {
    return this.context.file("project-removal-fences.json");
  }

  /** Projects whose removal was admitted; read under the environment lock. */
  private async loadProjectRemovalFences(): Promise<Record<string, string>> {
    const value = await this.context.loadJsonCached<unknown>(
      this.projectRemovalFencesFile(),
      () => ({}),
    );
    if (!isRecord(value)) return {};
    const fences: Record<string, string> = {};
    for (const [projectId, requestedAt] of Object.entries(value)) {
      if (typeof requestedAt === "string") fences[projectId] = requestedAt;
    }
    return fences;
  }

  /**
   * Admit the removal of a project that has no environments.
   *
   * The emptiness check and the fence are written under the environment lock,
   * and `addEnvironment` consults the fence under the same lock, so a create
   * racing the removal either lands first (and the removal is refused) or is
   * refused itself. The fence outlives the removal, so a late create can never
   * attach an environment to a project that no longer exists.
   */
  async fenceEmptyProjectForRemoval(projectId: string): Promise<void> {
    await this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const count = environments.filter(
        (environment) => environment.projectId === projectId,
      ).length;
      if (count > 0) throw new ProjectHasEnvironmentsError(projectId, count);
      const fences = await this.loadProjectRemovalFences();
      if (fences[projectId]) return;
      fences[projectId] = new Date().toISOString();
      const entries = Object.entries(fences)
        .sort(([, a], [, b]) => a.localeCompare(b))
        .slice(-MAX_PROJECT_REMOVAL_FENCES);
      await this.context.saveJson(this.projectRemovalFencesFile(), Object.fromEntries(entries));
    });
  }

  /** Undo a fence whose removal did not complete, so the project stays usable. */
  async releaseProjectRemovalFence(projectId: string): Promise<void> {
    await this.enqueueEnvironmentMutation(async () => {
      const fences = await this.loadProjectRemovalFences();
      if (!fences[projectId]) return;
      delete fences[projectId];
      await this.context.saveJson(this.projectRemovalFencesFile(), fences);
    });
  }

  async addEnvironment(environment: Environment): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      if (environment.controlRequestId) {
        const existing = environments.find(
          (candidate) =>
            candidate.projectId === environment.projectId &&
            candidate.controlRequestId === environment.controlRequestId,
        );
        if (existing) {
          // Legacy records carry no fingerprint and cannot prove the intent
          // matches; they converge as before. A recorded fingerprint must match.
          if (
            existing.controlRequestFingerprint &&
            environment.controlRequestFingerprint &&
            existing.controlRequestFingerprint !== environment.controlRequestFingerprint
          ) {
            throw new ControlRequestConflictError(environment.controlRequestId, existing.id);
          }
          return existing;
        }
      }
      if ((await this.loadProjectRemovalFences())[environment.projectId]) {
        throw new Error(`Project is being removed: ${environment.projectId}`);
      }
      environment.order =
        Math.max(
          -1,
          ...environments
            .filter((item) => item.projectId === environment.projectId)
            .map((item) => item.order),
        ) + 1;
      environments.push(environment);
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environment.id, environment.projectId);
      return environment;
    });
  }

  /** Bounded terminal PR tombstones survive deletion and missed node events. */
  async getFinalEnvironmentPr(environmentId: string): Promise<{
    id: string;
    projectId: string;
    name: string;
    prUrl: string;
    prState: "merged" | "closed";
    finalPrState: true;
  } | null> {
    const rows = await this.context.loadJson<
      Array<{
        id: string;
        projectId: string;
        name: string;
        prUrl: string;
        prState: "merged" | "closed";
        finalPrState: true;
      }>
    >(this.files.environmentFinalPrFile(), () => []);
    return rows.find((row) => row.id === environmentId) ?? null;
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const removed = environments.find((environment) => environment.id === environmentId);
      const filtered = environments.filter((environment) => environment.id !== environmentId);
      if (filtered.length === environments.length) {
        // A previous attempt may have committed the primary removal and then
        // failed while sanitizing retained backups. Keep deletion idempotent so
        // retrying can finish the privacy cleanup before preserving the public
        // not-found contract.
        await this.scrubEnvironmentBackups(environmentId, true);
        throw new Error(`Environment not found: ${environmentId}`);
      }
      if (removed?.prUrl && (removed.prState === "merged" || removed.prState === "closed")) {
        const file = this.files.environmentFinalPrFile();
        const rows = await this.context.loadJson<Array<Record<string, unknown>>>(file, () => []);
        const final = {
          id: removed.id,
          projectId: removed.projectId,
          name: removed.name,
          prUrl: removed.prUrl,
          prState: removed.prState,
          finalPrState: true,
        };
        await this.context.saveSensitiveJson(file, [
          ...rows.filter((row) => row.id !== removed.id).slice(-999),
          final,
        ]);
      }
      await this.saveEnvironments(filtered);
      await this.scrubEnvironmentBackups(environmentId, true);
      this.context.changes.announce(
        "environment",
        environmentId,
        removed?.projectId,
        undefined,
        true,
      );
    });
  }

  async updateEnvironment(
    environmentId: string,
    updates: JsonRecord,
    shouldUpdate?: (environment: Readonly<Environment>) => boolean | Promise<boolean>,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      // Fence observations against mutations (for example a PR becoming merged)
      // under the same cross-process lock as the write. A caller-side read alone
      // leaves a gap while this mutation waits for admission.
      if (shouldUpdate && !(await shouldUpdate(environment))) return environment;
      const beforeJson = JSON.stringify(environment);

      if ("containerResourceLimits" in updates) {
        const value = updates.containerResourceLimits;
        if (value === null || value === undefined) {
          environment.containerResourceLimits = undefined;
        } else {
          if (!isRecord(value)) throw new Error("Invalid container resource limits");
          const parsed = parseResourceLimits(value);
          if (!parsed.ok)
            throw new Error(`Invalid container resource limit: ${parsed.field} ${parsed.reason}`);
          environment.containerResourceLimits = parsed.limits;
        }
      }

      const previousPrUrl = environment.prUrl;
      const previousBranch = environment.branch;
      if (isNonBlankString(updates.name)) environment.name = updates.name;
      if (isNonBlankString(updates.branch)) environment.branch = updates.branch;
      if (
        "branchRevision" in updates &&
        typeof updates.branchRevision === "number" &&
        Number.isSafeInteger(updates.branchRevision) &&
        updates.branchRevision >= 0
      ) {
        environment.branchRevision = updates.branchRevision;
      }
      if (
        "status" in updates &&
        isOneOf(updates.status, ["running", "stopped", "error", "creating", "stopping"])
      ) {
        if (updates.status === "stopped" && environment.status !== "stopped") {
          environment.stopGeneration = (environment.stopGeneration ?? 0) + 1;
        }
        environment.status = updates.status;
        if (updates.status === "stopped" || updates.status === "error") {
          // Idempotent: re-stopping an environment whose activity is already
          // fully cleared must not bump the activity token, or the repeated
          // update could never take the equality bail-out below.
          const alreadyCleared =
            environment.agentActivityState === "idle" &&
            isRecord(environment.agentActivitySources) &&
            Object.keys(environment.agentActivitySources).length === 0 &&
            isRecord(environment.frontendAgentActivityObservers) &&
            Object.keys(environment.frontendAgentActivityObservers).length === 0;
          if (!alreadyCleared) {
            environment.agentActivityState = "idle";
            environment.agentActivitySources = {};
            environment.frontendAgentActivityObservers = {};
            environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
              environment.agentActivityUpdatedAt,
            );
          }
        }
      }
      if (
        "environmentType" in updates &&
        isOneOf(updates.environmentType, ["containerized", "local"])
      ) {
        environment.environmentType = updates.environmentType;
      }

      const optionalStringFields = [
        "worktreePath",
        "worktreeBaseDir",
        "initialPrompt",
        "initialAgentModel",
        "initialReasoningEffort",
        "prRecheckAfterAgentCompletionArmedAt",
        "pendingRenamePrompt",
        "createdFromCommit",
        "lastActivityAt",
        "deletionRequestedAt",
        "cleanupAfterMergeRequestedAt",
        "cleanupAfterMergeError",
        "lifecycleOperationStartedAt",
        "setupSessionId",
        "setupStartedAt",
        "setupCompletedAt",
      ] as const;
      for (const field of optionalStringFields) {
        if (field in updates) {
          const value = updates[field];
          if (value === null || value === undefined || typeof value === "string") {
            (environment as unknown as Record<string, unknown>)[field] = value ?? undefined;
          }
        }
      }
      if ("lifecycleError" in updates) {
        const value = updates.lifecycleError;
        if (value === null || value === undefined || typeof value === "string") {
          // Cleared as an explicit `null`, not `undefined`. Renderers merge
          // snapshots field-by-field and `JSON.stringify` drops undefined keys
          // entirely, so a cleared failure would arrive as an absent key and
          // leave the stale message on screen.
          environment.lifecycleError = value ?? null;
        }
      }
      if ("diffBaseline" in updates) {
        const value = updates.diffBaseline;
        if (value === null || value === undefined) {
          // Explicit null, like lifecycleError: renderers merge field-by-field.
          environment.diffBaseline = null;
        } else if (
          isRecord(value) &&
          typeof value.createdFromCommit === "string" &&
          FULL_COMMIT_SHA.test(value.createdFromCommit) &&
          typeof value.commit === "string" &&
          FULL_COMMIT_SHA.test(value.commit)
        ) {
          environment.diffBaseline = {
            createdFromCommit: value.createdFromCommit.toLowerCase(),
            commit: value.commit.toLowerCase(),
          };
        } else {
          throw new Error("Invalid environment diff baseline");
        }
      }
      if ("diffBaseOverride" in updates) {
        const value = updates.diffBaseOverride;
        // Explicit null, like diffBaseline: renderers merge field-by-field.
        environment.diffBaseOverride =
          value === null || value === undefined ? null : parseEnvironmentDiffBaseOverride(value);
      }
      if ("worktreeMove" in updates) {
        const value = updates.worktreeMove;
        if (value === null || value === undefined) {
          environment.worktreeMove = undefined;
        } else {
          environment.worktreeMove = parseWorktreeMoveRecord(value);
        }
      }
      if ("lifecycleOperation" in updates) {
        if (updates.lifecycleOperation == null) {
          environment.lifecycleOperation = undefined;
        } else if (
          updates.lifecycleOperation === "deleting" ||
          updates.lifecycleOperation === "merging" ||
          updates.lifecycleOperation === "moving"
        ) {
          environment.lifecycleOperation = updates.lifecycleOperation;
        }
      }

      if ("containerLifecycle" in updates) {
        const value = updates.containerLifecycle;
        if (value == null) {
          environment.containerLifecycle = undefined;
        } else if (isRecord(value)) {
          if (JSON.stringify(value).length > MAX_LIFECYCLE_RECORD_BYTES) {
            throw new Error("Container lifecycle record exceeds its size bound");
          }
          environment.containerLifecycle = value as unknown as Environment["containerLifecycle"];
        } else {
          throw new Error("Container lifecycle record is malformed");
        }
      }
      if (
        "containerId" in updates &&
        (updates.containerId == null || typeof updates.containerId === "string")
      ) {
        environment.containerId = updates.containerId ?? null;
      }
      if ("prUrl" in updates && (updates.prUrl == null || typeof updates.prUrl === "string")) {
        if (environment.prUrl !== updates.prUrl || updates.prUrl == null) {
          environment.prBaseBranch = null;
          // A merge state describes one PR; never carry it to a replacement.
          if (environment.prMergeability !== undefined) environment.prMergeability = null;
        }
        environment.prUrl = updates.prUrl ?? null;
      }
      if ("prState" in updates) {
        if (updates.prState == null) environment.prState = null;
        else if (isOneOf(updates.prState, ["open", "merged", "closed"]))
          environment.prState = updates.prState;
      }
      if (
        "prBaseBranch" in updates &&
        (updates.prBaseBranch == null || typeof updates.prBaseBranch === "string")
      ) {
        environment.prBaseBranch = updates.prBaseBranch ?? null;
      }
      if ("hasMergeConflicts" in updates) {
        if (updates.hasMergeConflicts == null) environment.hasMergeConflicts = null;
        else if (typeof updates.hasMergeConflicts === "boolean")
          environment.hasMergeConflicts = updates.hasMergeConflicts;
      }
      if ("prMergeability" in updates) {
        environment.prMergeability = isPrMergeability(updates.prMergeability)
          ? updates.prMergeability
          : null;
      }
      if ("revokedInputProviders" in updates) {
        const revoked = Array.isArray(updates.revokedInputProviders)
          ? [...new Set(updates.revokedInputProviders.filter(isAgentPlatform))]
          : [];
        environment.revokedInputProviders = revoked.length > 0 ? revoked : undefined;
      }
      if ("allowedDomains" in updates)
        environment.allowedDomains = Array.isArray(updates.allowedDomains)
          ? updates.allowedDomains.filter((value): value is string => typeof value === "string")
          : undefined;
      if ("portMappings" in updates) {
        if (updates.portMappings == null) environment.portMappings = undefined;
        else if (Array.isArray(updates.portMappings) && updates.portMappings.every(isPortMapping)) {
          environment.portMappings = updates.portMappings;
        }
      }

      const pidFields = [
        "opencodePid",
        "claudeBridgePid",
        "codexBridgePid",
        "cursorBridgePid",
        "grokBridgePid",
        "piBridgePid",
      ] as const;
      for (const field of pidFields) {
        if (!(field in updates)) continue;
        const value = updates[field];
        if (value == null) environment[field] = undefined;
        else if (isPositiveInteger(value)) environment[field] = value;
      }

      const portFields = [
        "localOpencodePort",
        "localClaudePort",
        "localCodexPort",
        "localCursorPort",
        "localGrokPort",
        "localPiPort",
        "entryPort",
        "hostEntryPort",
      ] as const;
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
        if (!environment.hasUnreadWork) delete environment.unreadReason;
      }
      if ("setupScriptsComplete" in updates) {
        if (updates.setupScriptsComplete == null) environment.setupScriptsComplete = false;
        else if (typeof updates.setupScriptsComplete === "boolean") {
          environment.setupScriptsComplete = updates.setupScriptsComplete;
        }
      }
      if (
        "setupPhase" in updates &&
        isOneOf(updates.setupPhase, ["pending", "running", "ready", "failed"])
      ) {
        environment.setupPhase = updates.setupPhase;
      }
      if ("setupOverride" in updates && typeof updates.setupOverride === "boolean") {
        environment.setupOverride = updates.setupOverride;
      }
      if ("autoMerge" in updates) {
        // Off is an explicit `false`, like lifecycleError's `null`: renderers
        // merge snapshots field-by-field, so a dropped key would leave it on.
        environment.autoMerge =
          updates.autoMerge === true && !!environment.prUrl && environment.prState === "open";
        environment.autoMergePrUrl = environment.autoMerge ? environment.prUrl : null;
        environment.autoMergeEnabledAt = environment.autoMerge ? new Date().toISOString() : null;
        environment.autoMergeError = null;
      }
      if ("autoMergeError" in updates) {
        environment.autoMergeError =
          typeof updates.autoMergeError === "string" ? updates.autoMergeError.slice(0, 2000) : null;
      }
      if (
        environment.autoMerge &&
        (environment.prUrl !== previousPrUrl ||
          environment.branch !== previousBranch ||
          environment.prState !== "open" ||
          (environment.autoMergePrUrl != null && environment.autoMergePrUrl !== environment.prUrl))
      ) {
        environment.autoMerge = false;
        environment.autoMergePrUrl = null;
        environment.autoMergeEnabledAt = null;
        environment.autoMergeError = null;
      }
      if (
        !environment.autoMerge ||
        environment.hasMergeConflicts === false ||
        environment.prUrl !== previousPrUrl
      ) {
        environment.autoMergeResolveRequestId = undefined;
      }
      if ("tabTeardownIntents" in updates) {
        const intents = updates.tabTeardownIntents;
        if (intents === undefined || intents === null) {
          environment.tabTeardownIntents = undefined;
        } else if (
          isRecord(intents) &&
          Object.values(intents).every(
            (intent) =>
              isRecord(intent) &&
              isNonBlankString(intent.tabId) &&
              isTabTeardownKind(intent.kind) &&
              isNonBlankString(intent.createdAt) &&
              (intent.sessionId === undefined || typeof intent.sessionId === "string") &&
              (intent.persistentSessionId === undefined ||
                typeof intent.persistentSessionId === "string"),
          )
        ) {
          environment.tabTeardownIntents = intents as Environment["tabTeardownIntents"];
        } else {
          throw new Error("Tab teardown intents are malformed");
        }
      }
      if ("pendingAgentLaunch" in updates && typeof updates.pendingAgentLaunch === "boolean") {
        environment.pendingAgentLaunch = updates.pendingAgentLaunch;
      }
      if ("initialAgentPlatform" in updates) {
        const value = updates.initialAgentPlatform;
        if (value == null) environment.initialAgentPlatform = undefined;
        else if (isAgentPlatform(value)) environment.initialAgentPlatform = value;
        else throw new Error("Invalid initial agent platform");
      }
      if ("initialConversationMode" in updates) {
        const value = updates.initialConversationMode;
        if (value == null) environment.initialConversationMode = undefined;
        else if (value === "plan" || value === "build") environment.initialConversationMode = value;
        else throw new Error("Invalid initial conversation mode");
      }
      if ("initialFastMode" in updates) {
        const value = updates.initialFastMode;
        // Key presence rather than truthiness, so clearing the launch intent
        // and choosing Normal stay distinguishable.
        if (value == null) environment.initialFastMode = undefined;
        else if (typeof value === "boolean") environment.initialFastMode = value;
        else throw new Error("Invalid initial fast mode");
      }
      if ("initialPromptAttachments" in updates) {
        if (updates.initialPromptAttachments == null) {
          environment.initialPromptAttachments = undefined;
        } else if (
          Array.isArray(updates.initialPromptAttachments) &&
          updates.initialPromptAttachments.every(isInitialPromptImageAttachment)
        ) {
          if (
            serializedInitialPromptAttachmentBytes(updates.initialPromptAttachments) >
            MAX_INITIAL_PROMPT_ATTACHMENT_STORAGE_BYTES
          ) {
            throw new Error("Initial prompt attachments exceed the 32 MB limit");
          }
          environment.initialPromptAttachments = toDurableInitialPromptAttachments(
            updates.initialPromptAttachments,
          );
        } else {
          throw new Error("Initial prompt attachments are malformed");
        }
      }
      if ("initialPromptPresentation" in updates) {
        if (updates.initialPromptPresentation == null) {
          environment.initialPromptPresentation = undefined;
        } else if (isTrustedUserPromptPresentation(updates.initialPromptPresentation)) {
          environment.initialPromptPresentation = updates.initialPromptPresentation;
        } else {
          throw new Error("Initial prompt presentation metadata is malformed");
        }
      }
      if ("startupAgentSession" in updates) {
        if (updates.startupAgentSession == null) {
          environment.startupAgentSession = undefined;
        } else if (isStartupAgentSession(updates.startupAgentSession)) {
          environment.startupAgentSession = updates.startupAgentSession;
        } else {
          throw new Error("Startup agent session is malformed");
        }
      }
      if ("claudeModelCatalog" in updates) {
        if (updates.claudeModelCatalog == null) {
          environment.claudeModelCatalog = undefined;
        } else if (isClaudeModelCatalogSnapshot(updates.claudeModelCatalog, environmentId)) {
          environment.claudeModelCatalog = updates.claudeModelCatalog;
        }
      }
      if (
        "networkAccessMode" in updates &&
        (updates.networkAccessMode === "full" || updates.networkAccessMode === "restricted")
      ) {
        environment.networkAccessMode = updates.networkAccessMode;
      }
      if ("agentSettings" in updates) {
        // The settings panes write this block wholesale, and an absent field
        // inside it is the user choosing "Inherit". Normalizing here keeps a
        // malformed or partial write out of persisted config, exactly as the
        // action-defaults normalizer does for its own object.
        environment.agentSettings = updates.agentSettings
          ? normalizeAgentSettings(updates.agentSettings)
          : undefined;
      }

      // A merge that changed nothing persists nothing. Rewriting the whole
      // store — and announcing a change that makes every client refetch every
      // project — for a field-equal record is pure churn.
      if (JSON.stringify(environment) === beforeJson) {
        // Attachment cleanup is a retryable two-step operation: the primary
        // may already be clean while a retained backup still contains the
        // payload. Explicit attachment updates must therefore finish scrubbing
        // even when the primary record no longer changes.
        if ("initialPromptAttachments" in updates) {
          await this.scrubEnvironmentBackups(environmentId, false);
        }
        return environment;
      }

      await this.saveEnvironments(environments);
      if ("initialPromptAttachments" in updates) {
        await this.scrubEnvironmentBackups(environmentId, false);
      }
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Journals one teardown against the latest environment snapshot while the
   * environment mutation lock is held. Whole-map updates from command callers
   * can otherwise overwrite a sibling teardown that was added concurrently.
   */
  async setTabTeardownIntent(
    environmentId: string,
    intent: NonNullable<Environment["tabTeardownIntents"]>[string],
  ): Promise<Environment> {
    if (
      !isNonBlankString(intent.tabId) ||
      !isTabTeardownKind(intent.kind) ||
      !isNonBlankString(intent.createdAt) ||
      (intent.sessionId !== undefined && !isNonBlankString(intent.sessionId)) ||
      (intent.persistentSessionId !== undefined && !isNonBlankString(intent.persistentSessionId))
    ) {
      throw new Error("Tab teardown intent is malformed");
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      environment.tabTeardownIntents = {
        ...environment.tabTeardownIntents,
        [intent.tabId]: intent,
      };
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /** Capture identity without overwriting a newer teardown for the tab. */
  async recordTabTeardownSessionId(
    environmentId: string,
    tabId: string,
    expectedCreatedAt: string,
    resumableSessionId: string,
  ): Promise<void> {
    if (!isNonBlankString(resumableSessionId)) throw new Error("Resume identity is blank");
    await this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      const intent = environment?.tabTeardownIntents?.[tabId];
      if (!intent || intent.createdAt !== expectedCreatedAt)
        throw new Error("Tab teardown changed before identity capture");
      if (intent.resumableSessionId) return;
      intent.resumableSessionId = resumableSessionId;
      await this.saveEnvironments(environments);
    });
  }

  /** Clears only the intent this caller completed, preserving newer retries. */
  async clearTabTeardownIntent(
    environmentId: string,
    tabId: string,
    expectedCreatedAt: string,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const current = environment.tabTeardownIntents?.[tabId];
      if (!current || current.createdAt !== expectedCreatedAt) return environment;
      const intents = { ...environment.tabTeardownIntents };
      delete intents[tabId];
      environment.tabTeardownIntents = Object.keys(intents).length > 0 ? intents : undefined;
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Atomically arms conflict-resolution reconciliation, including when the PR's
   * mergeability is pending. Serializing the predicate with the write prevents
   * an older Resolve click from re-arming an intent after a concurrent monitor
   * check already proved the PR mergeable.
   */
  async armPrRecheckAfterAgentCompletion(
    environmentId: string,
    claim?: {
      onlyIfUnarmed?: boolean;
      autoMergePrUrl?: string;
      autoMergeEnabledAt?: string;
      requestId?: string;
    },
  ): Promise<{ environment: Environment; armedAt: string | null; previousArmedAt?: string }> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      if (
        !environment.prUrl ||
        environment.prState !== "open" ||
        environment.hasMergeConflicts === false
      )
        return { environment, armedAt: null };

      if (claim?.onlyIfUnarmed && environment.prRecheckAfterAgentCompletionArmedAt)
        return { environment, armedAt: null };
      if (
        claim?.autoMergePrUrl &&
        (environment.autoMerge !== true ||
          environment.autoMergePrUrl !== claim.autoMergePrUrl ||
          (claim.autoMergeEnabledAt !== undefined &&
            environment.autoMergeEnabledAt !== claim.autoMergeEnabledAt) ||
          environment.prUrl !== claim.autoMergePrUrl ||
          environment.hasMergeConflicts !== true ||
          environment.deletionRequestedAt ||
          environment.lifecycleOperation ||
          environment.status !== "running" ||
          !(
            environment.setupPhase === "ready" ||
            environment.setupScriptsComplete ||
            environment.setupOverride
          ))
      )
        return { environment, armedAt: null };
      if (claim?.autoMergePrUrl && !environment.autoMergeResolveRequestId)
        environment.autoMergeResolveRequestId = claim.requestId;
      const previousArmedAt = environment.prRecheckAfterAgentCompletionArmedAt;
      const now = Date.now();
      const previous = environment.prRecheckAfterAgentCompletionArmedAt
        ? Date.parse(environment.prRecheckAfterAgentCompletionArmedAt)
        : Number.NEGATIVE_INFINITY;
      environment.prRecheckAfterAgentCompletionArmedAt = new Date(
        Number.isFinite(previous) && previous >= now ? previous + 1 : now,
      ).toISOString();
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return {
        environment,
        armedAt: environment.prRecheckAfterAgentCompletionArmedAt,
        previousArmedAt,
      };
    });
  }

  /** Clears only the exact Resolve request whose tab launch failed. */
  async disarmPrRecheckAfterAgentCompletion(
    environmentId: string,
    armedAt: string,
    previousArmedAt?: string,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      if (environment.prRecheckAfterAgentCompletionArmedAt !== armedAt) return environment;

      environment.prRecheckAfterAgentCompletionArmedAt = previousArmedAt;
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Clears the backend-to-renderer startup-session projection only after the
   * matching pane tab has been persisted. The identity checks keep a delayed
   * acknowledgement from an old renderer from consuming a newer launch.
   */
  async acknowledgeStartupAgentSession(
    environmentId: string,
    providerSessionId: string | undefined,
    startedAt: string | undefined,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const startupSession = environment.startupAgentSession;
      if (!startupSession) return environment;
      if (
        providerSessionId !== undefined &&
        startupSession.providerSessionId !== providerSessionId
      ) {
        return environment;
      }
      if (startedAt !== undefined && startupSession.startedAt !== startedAt) {
        return environment;
      }
      environment.startupAgentSession = undefined;
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
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
      // Activity timestamps churn constantly and are reconstructed from live
      // observation anyway; rotating five backups for each refresh is waste.
      await this.saveEnvironments(environments, { backup: false });
      this.context.changes.announce("environment", environmentId, environment.projectId);
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
    stale = false,
    options: {
      completionAttention?: boolean;
      completionOutcome?: AgentActivityCompletionOutcome;
    } = {},
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
      throw new Error(
        "source must be frontend, claude-terminal, claude-tmux, native-agent, multi-review, graph-run, or build-pipeline",
      );
    }
    if (
      observerId !== undefined &&
      (source !== "frontend" || !isNonBlankString(observerId) || observerId.length > 256)
    ) {
      throw new Error(
        "observerId must be a non-blank string of at most 256 characters for frontend activity",
      );
    }

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const structureBefore = agentActivityStructureFingerprint(environment);
      const previousAggregate = environment.agentActivityState ?? "idle";

      const referenceTime = Date.now();
      const sources = readAgentActivitySources(environment, referenceTime);
      const observers = readFrontendAgentActivityObservers(environment, referenceTime);

      const observerKey = observerId ? frontendAgentActivityObserverKey(observerId) : undefined;
      if (
        observerKey &&
        !observers[observerKey] &&
        Object.keys(observers).length >= MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS
      ) {
        throw new Error("too many frontend agent activity observers");
      }
      const previousSource = observerKey ? observers[observerKey] : sources[source];
      const previousTime = previousSource
        ? Date.parse(previousSource.updatedAt)
        : observerKey
          ? Number.NEGATIVE_INFINITY
          : parseUsableAgentActivityTime(environment.agentActivityUpdatedAt, referenceTime);
      let acceptedOccurredTime = occurredTime;
      if (Number.isFinite(previousTime) && previousTime >= occurredTime) {
        if (source === "frontend") return environment;
        // Backend polling is serialized, so arrival order is authoritative even
        // when observations share a millisecond: keep the per-source token
        // monotonic instead of dropping a real transition. Staleness is judged
        // against when the held observation was really made, not its token,
        // which a run of same-millisecond observations pushes ahead of the
        // clock. An observation older than the held one is still rejected.
        const previousObserved =
          !observerKey && previousSource?.observedAt !== undefined
            ? Date.parse(previousSource.observedAt)
            : previousTime;
        if (previousObserved > occurredTime) return environment;
        acceptedOccurredTime = previousTime + 1;
      }
      const normalizedOccurredAt = new Date(acceptedOccurredTime).toISOString();

      if (observerKey) {
        observers[observerKey] = {
          state,
          updatedAt: normalizedOccurredAt,
          leaseExpiresAt: new Date(referenceTime + FRONTEND_AGENT_ACTIVITY_LEASE_MS).toISOString(),
        };
      } else {
        sources[source] = {
          state,
          updatedAt: normalizedOccurredAt,
          ...(stale ? { stale: true } : {}),
          ...(source === "frontend" ? {} : { observedAt: new Date(occurredTime).toISOString() }),
        };
      }

      environment.agentActivitySources = sources;
      environment.frontendAgentActivityObservers = observers;
      environment.agentActivityState = aggregateEnvironmentAgentActivity(sources, observers);
      const nextAggregate = environment.agentActivityState;
      const aggregateTime = parseUsableAgentActivityTime(
        environment.agentActivityUpdatedAt,
        referenceTime,
      );
      environment.agentActivityUpdatedAt = new Date(
        Math.max(
          acceptedOccurredTime,
          Number.isFinite(aggregateTime) ? aggregateTime : Number.NEGATIVE_INFINITY,
        ),
      ).toISOString();
      const activityTransition =
        previousAggregate !== nextAggregate &&
        (nextAggregate === "working" ||
          nextAggregate === "waiting" ||
          (previousAggregate === "working" && nextAggregate === "idle"));
      // A failure belongs to this source's own work, so it rings on the source's
      // edge: a sibling that keeps the aggregate working could otherwise end
      // later with attention turned off, and the failure would never ring.
      const failedEnd =
        options.completionOutcome === "failed" &&
        previousSource?.state === "working" &&
        state !== "working";
      // Native reconciliation owns exact per-session attention edges. Its
      // aggregate can later go idle when a detached shell exits, after the
      // root completion was already announced and read.
      // A sibling may end quietly later. Announce known success on this
      // source's own edge so that later idle write cannot swallow it.
      const successfulEnd =
        previousSource?.state === "working" &&
        state === "idle" &&
        options.completionOutcome === undefined;
      const completionTransition =
        options.completionAttention !== false &&
        (successfulEnd ||
          (previousAggregate === "working" &&
            ((nextAggregate === "idle" && options.completionOutcome !== "none") ||
              nextAggregate === "waiting")));
      if (activityTransition || failedEnd || completionTransition) {
        const previousLastActivityAt = Date.parse(environment.lastActivityAt ?? "");
        environment.lastActivityAt = new Date(
          Math.max(
            acceptedOccurredTime,
            Number.isFinite(previousLastActivityAt)
              ? previousLastActivityAt
              : Number.NEGATIVE_INFINITY,
          ),
        ).toISOString();
      }
      if (failedEnd) {
        environment.hasUnreadWork = true;
        environment.unreadReason = "agent_failed";
      } else if (completionTransition) {
        // The aggregate alone cannot say what ended, so it must not replace a
        // failure nobody has read with "completed its work".
        const unreadFailure =
          environment.hasUnreadWork === true && environment.unreadReason === "agent_failed";
        environment.hasUnreadWork = true;
        if (nextAggregate === "waiting") environment.unreadReason = "agent_waiting";
        else if (!unreadFailure) environment.unreadReason = "agent_finished";
      }
      // The lease itself must persist (its expiry is enforced from disk), but
      // the backup rotation is skipped: only volatile activity fields changed.
      await this.saveEnvironments(environments, { backup: failedEnd || completionTransition });
      // A pure lease renewal — same aggregate, same per-source and observer
      // states, only timestamps refreshed — is not announced. Announcing it
      // made every connected client refetch every project on each renewal
      // (every ~10s per environment). The renewing renderer already applies
      // the returned record from this call's response, so it does not need
      // the broadcast; genuine state transitions still announce below.
      if (agentActivityStructureFingerprint(environment) !== structureBefore) {
        this.context.changes.announce("environment", environmentId, environment.projectId);
      }
      return environment;
    });
  }

  /** Remove expired renderer leases and publish each changed aggregate. */
  async expireFrontendAgentActivityLeases(referenceTime = Date.now()): Promise<string[]> {
    // Cheap pre-check outside the cross-process lock: with no observer leases
    // on record there is nothing that could expire, and this sweep runs every
    // 15 seconds forever. The read is stat-validated, so a lease written by
    // another process is still seen; one added between this check and the
    // next sweep is simply handled by the next sweep.
    const snapshot = await this.loadEnvironments();
    const hasObserverLeases = snapshot.some((environment) => {
      const observers = environment.frontendAgentActivityObservers;
      return isRecord(observers) && Object.keys(observers).length > 0;
    });
    if (!hasObserverLeases) return [];

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const changed: string[] = [];
      for (const environment of environments) {
        const storedObservers = environment.frontendAgentActivityObservers;
        if (!isRecord(storedObservers) || Object.keys(storedObservers).length === 0) {
          continue;
        }
        const observers = readFrontendAgentActivityObservers(environment, referenceTime);
        if (Object.keys(observers).length === Object.keys(storedObservers).length) {
          continue;
        }
        const sources = readAgentActivitySources(environment, referenceTime);
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = observers;
        environment.agentActivityState = aggregateEnvironmentAgentActivity(sources, observers);
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveEnvironments(environments, { backup: false });
      for (const environmentId of changed) {
        this.context.changes.announce(
          "environment",
          environmentId,
          environments.find((environment) => environment.id === environmentId)?.projectId,
        );
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
        const hasLegacyFrontend = Boolean(environment.agentActivitySources?.frontend);
        const hasObservers =
          isRecord(environment.frontendAgentActivityObservers) &&
          Object.keys(environment.frontendAgentActivityObservers).length > 0;
        if (!hasLegacyFrontend && !hasObservers) continue;
        const sources = readAgentActivitySources(environment, referenceTime);
        delete sources.frontend;
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = {};
        environment.agentActivityState = aggregateEnvironmentAgentActivity(sources, {});
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveEnvironments(environments, { backup: false });
      for (const environmentId of changed) {
        this.context.changes.announce(
          "environment",
          environmentId,
          environments.find((environment) => environment.id === environmentId)?.projectId,
        );
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
      environment.unreadReason = "terminal_finished";
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Persist one backend-observed session completion independently of the
   * environment-wide activity aggregate. Several native tabs can share the
   * `native-agent` source, so one tab may complete while a sibling keeps that
   * aggregate `working`.
   *
   * Backend observations are serialized but may share a millisecond with the
   * preceding working edge. Advance the durable token on a collision rather
   * than dropping a real completion as stale. Callers must invoke this exactly
   * once per observed per-session transition. The separate completion token
   * lets readers observe this edge while the aggregate remains working.
   */
  async recordEnvironmentSessionCompletion(
    environmentId: string,
    occurredAt: string,
    reason: Extract<
      EnvironmentUnreadReason,
      "agent_finished" | "agent_failed" | "agent_waiting"
    > = "agent_finished",
    completionKey?: string,
  ): Promise<Environment> {
    if (!isAgentActivityTimestamp(occurredAt)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const occurredTime = Date.parse(occurredAt);

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      // Keep request dedupe and the badge in the same durable write.
      if (completionKey) {
        if (environment.agentAttentionKeys?.includes(completionKey)) return environment;
        environment.agentAttentionKeys = [
          ...(environment.agentAttentionKeys ?? []),
          completionKey,
        ].slice(-1_000);
      }
      const previousTime = Date.parse(environment.lastActivityAt ?? "");
      const acceptedTime =
        Number.isFinite(previousTime) && previousTime >= occurredTime
          ? previousTime + 1
          : occurredTime;
      environment.lastActivityAt = new Date(acceptedTime).toISOString();
      const previousCompletionTime = Date.parse(environment.agentSessionCompletedAt ?? "");
      environment.agentSessionCompletedAt = new Date(
        Number.isFinite(previousCompletionTime)
          ? Math.max(acceptedTime, previousCompletionTime + 1)
          : acceptedTime,
      ).toISOString();
      environment.hasUnreadWork = true;
      environment.unreadReason = reason;
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Marks content-free agent attention exactly once per key.
   *
   * The dedupe keys and unread bit share the same environment write, so a
   * replayed provider snapshot cannot re-light a badge after the user clears it.
   */
  async recordEnvironmentAgentAttention(
    environmentId: string,
    attentionKeys: readonly string[],
    occurredAt: string,
  ): Promise<{ environment: Environment; recorded: boolean }> {
    if (!isAgentActivityTimestamp(occurredAt)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const normalized = Array.from(
      new Set(
        attentionKeys.filter(
          (key) => typeof key === "string" && key.length > 0 && key.length <= 2_048,
        ),
      ),
    ).slice(0, 64);
    if (normalized.length === 0) throw new Error("attentionKeys must not be empty");
    const occurredTime = Date.parse(occurredAt);

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const known = new Set(
        (Array.isArray(environment.agentAttentionKeys) ? environment.agentAttentionKeys : [])
          .filter(
            (key): key is string =>
              typeof key === "string" && key.length > 0 && key.length <= 2_048,
          )
          .slice(-1_000),
      );
      const unseen = normalized.filter((key) => !known.has(key));
      if (unseen.length === 0) return { environment, recorded: false };

      environment.agentAttentionKeys = [...known, ...unseen].slice(-1_000);
      const previousTime = Date.parse(environment.lastActivityAt ?? "");
      const acceptedTime =
        Number.isFinite(previousTime) && previousTime >= occurredTime
          ? previousTime + 1
          : occurredTime;
      environment.lastActivityAt = new Date(acceptedTime).toISOString();
      environment.hasUnreadWork = true;
      environment.unreadReason = "agent_question";
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return { environment, recorded: true };
    });
  }

  async setEnvironmentUnread(
    environmentId: string,
    unread: boolean,
    expectedLastActivityAt?: string | null,
  ): Promise<Environment> {
    if (
      expectedLastActivityAt !== undefined &&
      expectedLastActivityAt !== null &&
      typeof expectedLastActivityAt !== "string"
    ) {
      throw new Error("expectedLastActivityAt must be a string or null");
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      if (
        !unread &&
        expectedLastActivityAt !== undefined &&
        (environment.lastActivityAt ?? null) !== expectedLastActivityAt
      ) {
        return environment;
      }
      if (environment.hasUnreadWork === unread) return environment;

      environment.hasUnreadWork = unread;
      if (unread) environment.unreadReason = "marked_unread";
      else delete environment.unreadReason;
      await this.saveEnvironments(environments);
      this.context.changes.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async reorderEnvironments(projectId: string, environmentIds: string[]): Promise<Environment[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const provided = new Set(environmentIds);
      for (const [index, id] of environmentIds.entries()) {
        const environment = environments.find(
          (candidate) => candidate.id === id && candidate.projectId === projectId,
        );
        if (environment) environment.order = index;
      }

      let order = environmentIds.length;
      for (const environment of environments) {
        if (environment.projectId === projectId && !provided.has(environment.id))
          environment.order = order++;
      }

      await this.saveEnvironments(environments);
      const reordered = environments
        .filter((environment) => environment.projectId === projectId)
        .sort((a, b) => a.order - b.order);
      for (const environment of reordered) {
        this.context.changes.announce("environment", environment.id, environment.projectId);
      }
      return reordered;
    });
  }

  async setAllEnvironmentStatusesForContainer(
    containerId: string,
    status: EnvironmentStatus,
  ): Promise<void> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      let changed = false;
      for (const environment of environments) {
        if (environment.containerId === containerId) {
          environment.status = status;
          changed = true;
        }
      }
      if (changed) await this.saveEnvironments(environments);
    });
  }
}

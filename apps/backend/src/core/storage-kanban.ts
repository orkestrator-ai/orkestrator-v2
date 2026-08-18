import * as shared from "./storage-shared.js";
import {
  FeaturePlanningFenceError,
  fs,
  isCanonicalUuid,
  isFeaturePlanningRecord,
  isOneOf,
  isTerminalFeaturePlanningPhase,
  nowIso,
  randomUUID,
  resizeKanbanImage,
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

import { StorageDrafts } from "./storage-drafts.ts";

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
  ResourceChangeListener,
];

export class StorageKanban extends StorageDrafts {
  async getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    return tasks.filter((task) => task.projectId === projectId);
  }

  async getKanbanTask(taskId: string): Promise<KanbanTask | null> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    return tasks.find((task) => task.id === taskId) ?? null;
  }

  /**
   * Serializes the complete Kanban read-modify-write transaction both within
   * this service instance and across backend processes sharing the data
   * directory. Background PR reconciliation and foreground edits otherwise
   * risk saving independent stale snapshots over each other.
   */
  protected enqueueKanbanMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(this.kanbanFile(), "Kanban storage");
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.kanbanMutation.then(run, run);
    this.kanbanMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected async removeKanbanImageFilesBestEffort(imageIds: string[]): Promise<void> {
    await Promise.all(
      imageIds.map(async (imageId) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await fs.rm(this.kanbanImageFile(imageId), { force: true });
            return;
          } catch {
            if (attempt === 1) {
              // The authoritative metadata no longer references this image.
              // Keep the committed mutation successful; after the bounded
              // retries the remaining orphan is safe to remove later.
              console.warn("[Storage] Failed to clean up an orphaned Kanban image");
            }
          }
        }
      }),
    );
  }

  async addKanbanTask(
    projectId: string,
    title: string,
    description: string,
    initial: {
      acceptanceCriteria?: string;
      status?: KanbanStatus;
    } = {},
  ): Promise<KanbanTask> {
    const status = initial.status ?? "backlog";
    if (!isOneOf(status, ["backlog", "in-progress", "review", "done"])) {
      throw new Error("Kanban task status is invalid");
    }
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task: KanbanTask = {
        id: randomUUID(),
        projectId,
        title,
        description,
        acceptanceCriteria: initial.acceptanceCriteria ?? "",
        status,
        comments: [],
        images: [],
        createdAt: nowIso(),
        order:
          Math.max(
            -1,
            ...tasks
              .filter(
                (candidate) => candidate.projectId === projectId && candidate.status === status,
              )
              .map((candidate) => candidate.order),
          ) + 1,
        prMergeCommented: false,
      };
      tasks.push(task);
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", projectId);
      return task;
    });
  }

  async updateKanbanTask(
    taskId: string,
    updates: Partial<KanbanTask>,
    expectedProjectId?: string,
  ): Promise<KanbanTask> {
    if (
      updates.status !== undefined &&
      !isOneOf(updates.status, ["backlog", "in-progress", "review", "done"])
    ) {
      throw new Error("Kanban task status is invalid");
    }
    if (updates.prState !== undefined && !isOneOf(updates.prState, ["open", "merged", "closed"])) {
      throw new Error("Kanban task pull request state is invalid");
    }
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }

      const oldStatus = task.status;
      Object.assign(task, updates);
      if (updates.status && updates.status !== oldStatus) {
        task.order =
          Math.max(
            -1,
            ...tasks
              .filter(
                (candidate) =>
                  candidate.projectId === task.projectId &&
                  candidate.status === updates.status &&
                  candidate.id !== taskId,
              )
              .map((candidate) => candidate.order),
          ) + 1;
      }
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async deleteKanbanTask(taskId: string): Promise<void> {
    await this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      await this.saveJson(
        this.kanbanFile(),
        tasks.filter((candidate) => candidate.id !== taskId),
      );
      this.announce("kanban", task.projectId);
      await this.removeKanbanImageFilesBestEffort(task.images.map((image) => image.id));
    });
  }

  async addKanbanComment(
    taskId: string,
    text: string,
    expectedProjectId?: string,
  ): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }
      task.comments.push({ id: randomUUID(), text, createdAt: nowIso() });
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      task.comments = task.comments.filter((comment) => comment.id !== commentId);
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);

      const rawBytes = Buffer.from(data, "base64");
      const webpBytes = await resizeKanbanImage(rawBytes);
      await fs.mkdir(this.kanbanImagesDir(), { recursive: true });
      const image: KanbanImage = { id: randomUUID(), filename, createdAt: nowIso() };
      await fs.writeFile(this.kanbanImageFile(image.id), webpBytes);
      task.images.push(image);
      try {
        await this.saveJson(this.kanbanFile(), tasks);
      } catch (error) {
        await fs.rm(this.kanbanImageFile(image.id), { force: true });
        throw error;
      }
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      if (!isCanonicalUuid(imageId)) {
        throw new Error("Kanban image ID is invalid");
      }
      if (!task.images.some((image) => image.id === imageId)) {
        throw new Error(`Kanban image not found on task: ${imageId}`);
      }
      task.images = task.images.filter((image) => image.id !== imageId);
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      await this.removeKanbanImageFilesBestEffort([imageId]);
      return task;
    });
  }

  async getKanbanImageData(imageId: string): Promise<string> {
    if (!isCanonicalUuid(imageId)) {
      throw new Error("Kanban image ID is invalid");
    }
    return (await fs.readFile(this.kanbanImageFile(imageId))).toString("base64");
  }

  async getProjectNotes(projectId: string): Promise<ProjectNotes> {
    const notes = await this.loadJson<ProjectNotes[]>(this.projectNotesFile(), () => []);
    return (
      notes.find((note) => note.projectId === projectId) ?? {
        projectId,
        content: "",
        updatedAt: nowIso(),
      }
    );
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
    return plans.filter((plan) => plan.projectId === projectId).sort((a, b) => a.order - b.order);
  }

  // Serializes the entire load -> mutate -> save cycle for feature plans so that
  // concurrent flows (e.g. a feature-chat poll and a story refinement happening at
  // the same time) cannot clobber each other via stale read-modify-write races.
  // The mutator runs against the freshly loaded array; if it throws, nothing is
  // saved and the next queued mutation still proceeds.
  protected mutateFeaturePlans<T>(
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
    this.featurePlanMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async createFeaturePlan(projectId: string): Promise<FeaturePlan> {
    return this.mutateFeaturePlans(
      (plans) => {
        const now = nowIso();
        const plan: FeaturePlan = {
          id: randomUUID(),
          projectId,
          title: "new feature",
          status: "collecting",
          summary: "",
          messages: [
            {
              id: randomUUID(),
              role: "assistant",
              content: "Tell me about the new feature",
              createdAt: now,
            },
          ],
          stories: [],
          createdAt: now,
          updatedAt: now,
          order:
            Math.max(
              -1,
              ...plans
                .filter((candidate) => candidate.projectId === projectId)
                .map((candidate) => candidate.order),
            ) + 1,
        };
        plans.push(plan);
        return plan;
      },
      (plan) => plan.projectId,
    );
  }

  async updateFeaturePlan(featureId: string, updates: Partial<FeaturePlan>): Promise<FeaturePlan> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

        const originalId = plan.id;
        const originalProjectId = plan.projectId;
        const originalCreatedAt = plan.createdAt;
        const originalOrder = plan.order;
        const originalPlanning = plan.planning;
        Object.assign(plan, updates);
        plan.id = originalId;
        plan.projectId = originalProjectId;
        plan.createdAt = originalCreatedAt;
        plan.order = originalOrder;
        if (originalPlanning === undefined) {
          delete plan.planning;
        } else {
          plan.planning = originalPlanning;
        }
        plan.updatedAt = nowIso();
        return plan;
      },
      (plan) => plan.projectId,
    );
  }

  async claimFeaturePlanBuild(
    featureId: string,
    taskId: string,
  ): Promise<{ claimed: boolean; feature: FeaturePlan }> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

        if (plan.status === "building" && plan.buildTaskId === taskId) {
          return { claimed: true, feature: plan };
        }
        if (
          plan.status === "building" ||
          Boolean(plan.buildTaskId) ||
          Boolean(plan.buildPipelineId)
        ) {
          return { claimed: false, feature: plan };
        }

        plan.status = "building";
        plan.buildTaskId = taskId;
        plan.updatedAt = nowIso();
        return { claimed: true, feature: plan };
      },
      (result) => result.feature.projectId,
    );
  }

  async appendFeaturePlanMessage(
    featureId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

        plan.messages.push({
          id: randomUUID(),
          role,
          content,
          createdAt: nowIso(),
          ...(modelId ? { modelId } : {}),
          ...(stateApplication ? { stateApplication } : {}),
        });
        plan.updatedAt = nowIso();
        return plan;
      },
      (plan) => plan.projectId,
    );
  }

  async appendFeatureStoryMessage(
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
        const story = plan.stories.find((candidate) => candidate.id === storyId);
        if (!story) throw new Error(`Feature story not found: ${storyId}`);

        story.messages.push({
          id: randomUUID(),
          role,
          content,
          createdAt: nowIso(),
          ...(modelId ? { modelId } : {}),
          ...(stateApplication ? { stateApplication } : {}),
        });
        story.updatedAt = nowIso();
        plan.updatedAt = nowIso();
        return plan;
      },
      (plan) => plan.projectId,
    );
  }

  /** Every plan across every project, for backend sweeps that are not project-scoped. */
  async listAllFeaturePlans(): Promise<FeaturePlan[]> {
    return await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
  }

  async getFeaturePlan(featureId: string): Promise<FeaturePlan | null> {
    const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
    return plans.find((candidate) => candidate.id === featureId) ?? null;
  }

  /**
   * Every plan carrying a planning record the backend still has to advance.
   *
   * Records that fail validation are ignored rather than repaired here: the
   * service quarantines them, because a record this cannot read is one no
   * amount of ticking will move.
   */
  async listActiveFeaturePlanning(): Promise<FeaturePlanningRecord[]> {
    const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
    const active: FeaturePlanningRecord[] = [];
    for (const plan of plans) {
      const record = plan.planning;
      if (!isFeaturePlanningRecord(record)) continue;
      if (isTerminalFeaturePlanningPhase(record.phase)) continue;
      active.push(record);
    }
    return active;
  }

  /**
   * Attaches a planning record, refusing when one is already in flight.
   *
   * This is the interlock that stops a second window — or a reload that resets
   * a renderer latch — from dispatching a second turn into the same session.
   */
  async startFeaturePlanning(
    record: FeaturePlanningRecord,
  ): Promise<{ started: boolean; feature: FeaturePlan }> {
    if (!isFeaturePlanningRecord(record)) {
      throw new Error("Feature planning record is invalid");
    }
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === record.featureId);
        if (!plan) throw new Error(`Feature plan not found: ${record.featureId}`);
        const existing = plan.planning;
        if (isFeaturePlanningRecord(existing) && !isTerminalFeaturePlanningPhase(existing.phase)) {
          return { started: false, feature: plan };
        }
        plan.planning = { ...record, projectId: plan.projectId };
        plan.updatedAt = nowIso();
        return { started: true, feature: plan };
      },
      (result) => result.feature.projectId,
    );
  }

  /**
   * Runs `mutator` against the plan and its planning record in one serialized
   * write, then bumps the record's revision.
   *
   * The `operationId` is a fence: a mutation for an exchange that has already
   * been replaced must not land, or a superseded turn's reply would overwrite
   * the current one.
   */
  async mutateFeaturePlanning<T>(
    featureId: string,
    operationId: string,
    mutator: (plan: FeaturePlan, record: FeaturePlanningRecord) => T,
  ): Promise<{ result: T; feature: FeaturePlan }> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
        const record = plan.planning;
        if (!isFeaturePlanningRecord(record) || record.operationId !== operationId) {
          throw new FeaturePlanningFenceError(featureId, operationId);
        }
        const result = mutator(plan, record);
        // Re-read: the mutator may have replaced the record wholesale.
        const updated = plan.planning;
        if (isFeaturePlanningRecord(updated) && updated.operationId === operationId) {
          updated.backendRevision += 1;
          updated.updatedAt = nowIso();
        }
        plan.updatedAt = nowIso();
        return { result, feature: plan };
      },
      (outcome) => outcome.feature.projectId,
    );
  }

  /**
   * Detaches a finished exchange. A mismatched fence is a no-op, not an error:
   * the exchange it would have cleared has already been replaced.
   */
  async clearFeaturePlanning(featureId: string, operationId: string): Promise<FeaturePlan> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
        if (plan.planning?.operationId !== operationId) return plan;
        delete plan.planning;
        plan.updatedAt = nowIso();
        return plan;
      },
      (plan) => plan.projectId,
    );
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
    await this.writeAtomic(
      this.linearAuthFile(),
      `${JSON.stringify(auth, null, 2)}\n`,
      false,
      0o600,
    );
    return auth;
  }

  async clearLinearAuth(): Promise<void> {
    await fs.rm(this.linearAuthFile(), { force: true });
  }

  async getLinearCompletionComment(pipelineId: string): Promise<LinearCompletionComment | null> {
    const comments = await this.loadJson<LinearCompletionComment[]>(
      this.linearCompletionCommentsFile(),
      () => [],
    );
    return comments.find((comment) => comment.pipelineId === pipelineId) ?? null;
  }

  async saveLinearCompletionComment(
    record: Omit<LinearCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<LinearCompletionComment> {
    const comments = await this.loadJson<LinearCompletionComment[]>(
      this.linearCompletionCommentsFile(),
      () => [],
    );
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

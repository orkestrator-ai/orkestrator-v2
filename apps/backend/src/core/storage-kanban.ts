import * as shared from "./storage-shared.js";
import { createHash } from "node:crypto";
import {
  applyTicketContentUpdate,
  hasTicketContentUpdate,
  normalizeTicketContent,
  type AcceptanceCriterionCheck,
  type TicketContentUpdate,
  type TicketKind,
  type TicketSectionsPatch,
} from "@orkestrator/protocol/ticket-sections";
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

import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";

/**
 * A stored row as current content. Legacy rows get their kind and sections
 * derived on read; nothing is written back until the ticket is next changed,
 * so this is the migration and it never loses or rewrites text. Results a
 * hand-ticked legacy box records are dated with the ticket's creation, so
 * repeated reads return the same row.
 */
export function normalizeKanbanTask(task: KanbanTask): KanbanTask {
  const content = normalizeTicketContent(task, { now: task.createdAt });
  return { ...task, ...content };
}

/** Content fields a create or update may carry; see `applyTicketContentUpdate`. */
export interface KanbanTaskContentInput {
  kind?: TicketKind;
  markdown?: string;
  sections?: TicketSectionsPatch;
}

/** A Verify result for one criterion, matched to the ticket by id and text. */
export interface KanbanCriterionCheckInput {
  id: string;
  text: string;
  check: AcceptanceCriterionCheck;
}

function stableKanbanId(namespace: string, requestId: string): string {
  const hex = createHash("sha256").update(namespace).update("\0").update(requestId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

export class KanbanRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  async getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    // Indexed by project: reads one board without parsing every project's.
    const tasks = this.context.loadStoreRowsByOwner<KanbanTask>(this.files.kanbanFile(), projectId);
    return tasks.filter((task) => task.projectId === projectId).map(normalizeKanbanTask);
  }

  async getKanbanTask(taskId: string): Promise<KanbanTask | null> {
    const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
    const task = tasks.find((candidate) => candidate.id === taskId);
    return task ? normalizeKanbanTask(task) : null;
  }

  /**
   * Serializes the complete Kanban read-modify-write transaction both within
   * this service instance and across backend processes sharing the data
   * directory. Background PR reconciliation and foreground edits otherwise
   * risk saving independent stale snapshots over each other.
   */
  private enqueueKanbanMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.kanbanFile(), "Kanban storage", operation);
  }

  private async removeKanbanImageFilesBestEffort(imageIds: string[]): Promise<void> {
    await Promise.all(
      imageIds.map(async (imageId) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await fs.rm(this.files.kanbanImageFile(imageId), { force: true });
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
    description: string | undefined,
    initial: {
      acceptanceCriteria?: string;
      status?: KanbanStatus;
      requestId?: string;
      featureBuildRequestHash?: string;
    } & KanbanTaskContentInput = {},
  ): Promise<KanbanTask> {
    const status = initial.status ?? "backlog";
    if (!isOneOf(status, ["backlog", "in-progress", "review", "done"])) {
      throw new Error("Kanban task status is invalid");
    }
    const createdAt = nowIso();
    const content = applyTicketContentUpdate(
      null,
      {
        ...(description !== undefined ? { description } : {}),
        ...(initial.acceptanceCriteria !== undefined
          ? { acceptanceCriteria: initial.acceptanceCriteria }
          : {}),
        ...(initial.kind !== undefined ? { kind: initial.kind } : {}),
        ...(initial.markdown !== undefined ? { markdown: initial.markdown } : {}),
        ...(initial.sections !== undefined ? { sections: initial.sections } : {}),
      },
      { now: createdAt },
    );
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const id = initial.requestId
        ? stableKanbanId(`ticket:${projectId}`, initial.requestId)
        : randomUUID();
      const existing = tasks.find((candidate) => candidate.id === id);
      if (existing) {
        if (
          existing.projectId !== projectId ||
          existing.title !== title ||
          existing.description !== content.description ||
          existing.acceptanceCriteria !== content.acceptanceCriteria ||
          normalizeKanbanTask(existing).kind !== content.kind ||
          existing.status !== status ||
          existing.featureBuildRequestHash !== initial.featureBuildRequestHash
        ) {
          throw new Error("Kanban ticket requestId was already used with different arguments");
        }
        return normalizeKanbanTask(existing);
      }
      const task: KanbanTask = {
        id,
        projectId,
        title,
        ...content,
        status,
        comments: [],
        images: [],
        createdAt,
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
        ...(initial.featureBuildRequestHash
          ? { featureBuildRequestHash: initial.featureBuildRequestHash }
          : {}),
      };
      tasks.push(task);
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      this.context.changes.announce("kanban", projectId);
      return task;
    });
  }

  /**
   * The ticket a previous call with this `requestId` created, if any.
   *
   * {@link addKanbanTask} is idempotent, but only while the ticket still looks
   * exactly as it was created: it rejects a replay whose arguments disagree
   * with the stored row. A ticket that started a build has usually moved on by
   * the time a caller retries — a different status, a linked environment — so a
   * retry has to be able to *find* it rather than re-create it.
   */
  async findKanbanTaskByRequestId(
    projectId: string,
    requestId: string,
  ): Promise<KanbanTask | null> {
    const id = stableKanbanId(`ticket:${projectId}`, requestId);
    const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
    const task = tasks.find(
      (candidate) => candidate.id === id && candidate.projectId === projectId,
    );
    return task ? normalizeKanbanTask(task) : null;
  }

  /**
   * Content fields (`description`, `acceptanceCriteria`, `kind`, `markdown`,
   * `sections`) go through `applyTicketContentUpdate`, so criteria results
   * survive edits that leave a criterion's text alone. Stored `sections` and
   * `sectionsBasis` cannot be written directly.
   */
  async updateKanbanTask(
    taskId: string,
    updates: Partial<Omit<KanbanTask, "sections" | "sectionsBasis">> & KanbanTaskContentInput,
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
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }

      const oldStatus = task.status;
      const { kind, markdown, sections, description, acceptanceCriteria, ...plain } = updates;
      const contentUpdate: TicketContentUpdate = {
        ...(kind !== undefined ? { kind } : {}),
        ...(markdown !== undefined ? { markdown } : {}),
        ...(sections !== undefined ? { sections } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
      };
      Object.assign(task, plain);
      if (hasTicketContentUpdate(contentUpdate)) {
        Object.assign(task, applyTicketContentUpdate(task, contentUpdate));
      }
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
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
  }

  /**
   * Records Verify's result for each criterion still on the ticket with the
   * same id and text. A criterion edited since the pipeline started is left
   * alone: the result was for text the ticket no longer has. Returns the
   * ticket, or null when it no longer exists.
   */
  async recordKanbanCriteriaChecks(
    taskId: string,
    checks: readonly KanbanCriterionCheckInput[],
  ): Promise<KanbanTask | null> {
    if (checks.length === 0) return null;
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const index = tasks.findIndex((candidate) => candidate.id === taskId);
      if (index < 0) return null;
      const task = normalizeKanbanTask(tasks[index]!);
      const criteria = task.sections?.acceptanceCriteria ?? [];
      let changed = false;
      const next = criteria.map((criterion) => {
        const result = checks.find(
          (candidate) => candidate.id === criterion.id && candidate.text === criterion.text,
        );
        if (!result) return criterion;
        changed = true;
        return { ...criterion, check: result.check };
      });
      if (!changed) return task;
      // Results live only in sections, never in the text mirrors, so the
      // basis stays valid and no other field changes.
      tasks[index] = { ...task, sections: { ...task.sections, acceptanceCriteria: next } };
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      this.context.changes.announce("kanban", task.projectId);
      return tasks[index]!;
    });
  }

  async deleteKanbanTask(taskId: string): Promise<void> {
    await this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      await this.context.saveJson(
        this.files.kanbanFile(),
        tasks.filter((candidate) => candidate.id !== taskId),
      );
      this.context.changes.announce("kanban", task.projectId);
      await this.removeKanbanImageFilesBestEffort(task.images.map((image) => image.id));
    });
  }

  async addKanbanComment(
    taskId: string,
    text: string,
    expectedProjectId?: string,
    requestId?: string,
  ): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }
      const id = requestId ? stableKanbanId(`comment:${taskId}`, requestId) : randomUUID();
      const existing = task.comments.find((comment) => comment.id === id);
      if (existing) {
        if (existing.text !== text) {
          throw new Error("Kanban comment requestId was already used with different text");
        }
        return normalizeKanbanTask(task);
      }
      task.comments.push({ id, text, createdAt: nowIso() });
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
  }

  async deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      task.comments = task.comments.filter((comment) => comment.id !== commentId);
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
  }

  async addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
    return (await this.persistKanbanImage(taskId, filename, data)).task;
  }

  /**
   * Add an already-normalized WebP image exactly once for a durable request.
   *
   * Feature-build creation normalizes every image before it creates a ticket,
   * then uses this path so a retry can finish a partial write without adding a
   * second copy of images that were already persisted.
   */
  async addNormalizedKanbanImageForRequest(
    taskId: string,
    filename: string,
    data: string,
    requestId: string,
  ): Promise<{ task: KanbanTask; image: KanbanImage }> {
    return this.persistKanbanImage(taskId, filename, data, requestId, true);
  }

  private async persistKanbanImage(
    taskId: string,
    filename: string,
    data: string,
    requestId?: string,
    normalized = false,
  ): Promise<{ task: KanbanTask; image: KanbanImage }> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);

      const imageId = requestId ? stableKanbanId(`image:${taskId}`, requestId) : randomUUID();
      const existing = task.images.find((image) => image.id === imageId);
      if (existing) {
        if (existing.filename !== filename) {
          throw new Error("Kanban image requestId was already used with a different filename");
        }
        return { task: normalizeKanbanTask(task), image: existing };
      }
      const rawBytes = Buffer.from(data, "base64");
      const webpBytes = normalized ? rawBytes : await resizeKanbanImage(rawBytes);
      await fs.mkdir(this.files.kanbanImagesDir(), { recursive: true });
      const image: KanbanImage = { id: imageId, filename, createdAt: nowIso() };
      await fs.writeFile(this.files.kanbanImageFile(image.id), webpBytes);
      task.images.push(image);
      try {
        await this.context.saveJson(this.files.kanbanFile(), tasks);
      } catch (error) {
        await fs.rm(this.files.kanbanImageFile(image.id), { force: true });
        throw error;
      }
      this.context.changes.announce("kanban", task.projectId);
      return { task: normalizeKanbanTask(task), image };
    });
  }

  async deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      if (!isCanonicalUuid(imageId)) {
        throw new Error("Kanban image ID is invalid");
      }
      if (!task.images.some((image) => image.id === imageId)) {
        throw new Error(`Kanban image not found on task: ${imageId}`);
      }
      task.images = task.images.filter((image) => image.id !== imageId);
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      this.context.changes.announce("kanban", task.projectId);
      await this.removeKanbanImageFilesBestEffort([imageId]);
      return normalizeKanbanTask(task);
    });
  }

  async getKanbanImageData(imageId: string): Promise<string> {
    if (!isCanonicalUuid(imageId)) {
      throw new Error("Kanban image ID is invalid");
    }
    // A blob file, not a store: a file read, so storage budgets count stores only.
    const image = await fs.readFile(this.files.kanbanImageFile(imageId));
    recurringWorkMetrics.work("file-read");
    recurringWorkMetrics.bytes(image.length);
    return image.toString("base64");
  }

  async getProjectNotes(projectId: string): Promise<ProjectNotes> {
    const notes = await this.context.loadJson<ProjectNotes[]>(
      this.files.projectNotesFile(),
      () => [],
    );
    return (
      notes.find((note) => note.projectId === projectId) ?? {
        projectId,
        content: "",
        updatedAt: nowIso(),
      }
    );
  }

  async saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
    const note = this.context.updateStore(
      this.files.projectNotesFile(),
      (): ProjectNotes[] => [],
      (notes) => {
        let existing = notes.find((candidate) => candidate.projectId === projectId);
        if (!existing) {
          existing = { projectId, content, updatedAt: nowIso() };
          notes.push(existing);
        } else {
          existing.content = content;
          existing.updatedAt = nowIso();
        }
        return existing;
      },
    );
    this.context.changes.announce("project-notes", projectId);
    return note;
  }

  async getFeaturePlans(projectId: string): Promise<FeaturePlan[]> {
    const plans = await this.context.loadJson<FeaturePlan[]>(
      this.files.featurePlansFile(),
      () => [],
    );
    return plans.filter((plan) => plan.projectId === projectId).sort((a, b) => a.order - b.order);
  }

  // The entire load -> mutate -> save cycle for feature plans is one SQLite
  // transaction, so concurrent flows (e.g. a feature-chat poll and a story
  // refinement happening at the same time, possibly in two backends) cannot
  // clobber each other via stale read-modify-write races. The mutator runs
  // against the freshly loaded array; if it throws, nothing is saved.
  private async mutateFeaturePlans<T>(
    mutator: (plans: FeaturePlan[]) => T,
    affectedProjectId: (result: T) => string,
  ): Promise<T> {
    const result = this.context.updateStore(
      this.files.featurePlansFile(),
      (): FeaturePlan[] => [],
      mutator,
    );
    this.context.changes.announce("feature-plan", affectedProjectId(result));
    return result;
  }

  async createFeaturePlan(projectId: string, id: string = randomUUID()): Promise<FeaturePlan> {
    return this.mutateFeaturePlans(
      (plans) => {
        const existing = plans.find((plan) => plan.id === id);
        if (existing) {
          if (existing.projectId !== projectId)
            throw new Error("Feature plan belongs to another project");
          return existing;
        }
        const now = nowIso();
        const plan: FeaturePlan = {
          id,
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
    return await this.context.loadJson<FeaturePlan[]>(this.files.featurePlansFile(), () => []);
  }

  /**
   * One plan by ID, read as its own row. The planning supervisor calls this
   * on every pass, so it must cost one plan however many the store retains.
   */
  async getFeaturePlan(featureId: string): Promise<FeaturePlan | null> {
    const stored = this.context.loadStoreRow(this.files.featurePlansFile(), featureId);
    return typeof stored === "object" && stored !== null && (stored as FeaturePlan).id === featureId
      ? (stored as FeaturePlan)
      : null;
  }

  /**
   * Every plan carrying a planning record the backend still has to advance.
   *
   * Records that fail validation are ignored rather than repaired here: the
   * service quarantines them, because a record this cannot read is one no
   * amount of ticking will move.
   */
  async listActiveFeaturePlanning(): Promise<FeaturePlanningRecord[]> {
    const plans = await this.context.loadJson<FeaturePlan[]>(
      this.files.featurePlansFile(),
      () => [],
    );
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
        const messages =
          record.kind === "story"
            ? plan.stories.find((story) => story.id === record.storyId)!.messages
            : plan.messages;
        if (
          existing?.operationId === record.operationId ||
          messages.some((message) => message.id === record.operationId)
        )
          return { started: false, feature: plan };
        if (isFeaturePlanningRecord(existing) && !isTerminalFeaturePlanningPhase(existing.phase)) {
          return { started: false, feature: plan };
        }
        // Publish the operation and its user message atomically. A legacy
        // adoption already has a message and must retain that identity.
        const userMessageId = record.userMessageId ?? record.operationId;
        if (!messages.some((message) => message.id === userMessageId))
          messages.push({
            id: userMessageId,
            role: "user",
            content: record.userMessage,
            createdAt: record.startedAt,
          });
        plan.planning = { ...record, projectId: plan.projectId, userMessageId };
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
    const auth = await this.context.loadJson<LinearAuth | null>(
      this.files.linearAuthFile(),
      () => null,
    );
    return auth?.apiKey ? auth : null;
  }

  async saveLinearAuth(apiKey: string, viewer?: LinearAuth["viewer"]): Promise<LinearAuth> {
    const auth: LinearAuth = {
      apiKey,
      connectedAt: nowIso(),
      viewer,
    };
    await this.enqueueLinearAuthMutation(() =>
      this.context.saveSensitiveJson(this.files.linearAuthFile(), auth),
    );
    return auth;
  }

  async clearLinearAuth(): Promise<void> {
    await this.enqueueLinearAuthMutation(() =>
      this.context.deleteStore(this.files.linearAuthFile()),
    );
  }

  // Saves and clears take the store's lease, like every other whole-value
  // write (storage-writer-guards.test.ts).
  private enqueueLinearAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.linearAuthFile(), "Linear auth storage", operation);
  }

  async getLinearCompletionComment(pipelineId: string): Promise<LinearCompletionComment | null> {
    const comments = await this.context.loadJson<LinearCompletionComment[]>(
      this.files.linearCompletionCommentsFile(),
      () => [],
    );
    return comments.find((comment) => comment.pipelineId === pipelineId) ?? null;
  }

  async saveLinearCompletionComment(
    record: Omit<LinearCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<LinearCompletionComment> {
    const nextRecord: LinearCompletionComment = {
      ...record,
      updatedAt: record.updatedAt ?? nowIso(),
    };
    this.context.updateStore(
      this.files.linearCompletionCommentsFile(),
      (): LinearCompletionComment[] => [],
      (comments) => {
        const index = comments.findIndex((comment) => comment.pipelineId === record.pipelineId);
        if (index >= 0) comments[index] = nextRecord;
        else comments.push(nextRecord);
      },
    );
    return nextRecord;
  }

  async getGitHubCompletionComment(pipelineId: string): Promise<GitHubCompletionComment | null> {
    const comments = await this.context.loadJson<GitHubCompletionComment[]>(
      this.files.githubCompletionCommentsFile(),
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
    const release = await this.context.acquireLease(
      this.files.githubCompletionCommentLockTarget(pipelineId),
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
    const nextRecord: GitHubCompletionComment = {
      ...record,
      updatedAt: record.updatedAt ?? nowIso(),
    };
    this.context.updateStore(
      this.files.githubCompletionCommentsFile(),
      (): GitHubCompletionComment[] => [],
      (comments) => {
        const index = comments.findIndex((comment) => comment.pipelineId === record.pipelineId);
        if (index >= 0) comments[index] = nextRecord;
        else comments.push(nextRecord);
      },
    );
    return nextRecord;
  }
}

/**
 * Kanban tasks, feature plans, project notes, the Linear sign-in and PR completion comments: what callers reach as `storage.kanban`.
 *
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to, like a public method of `StorageService`. Add a
 * method here only when code outside the storage files calls it.
 */
export type KanbanStorage = Pick<
  KanbanRepository,
  | "getKanbanTasks"
  | "getKanbanTask"
  | "addKanbanTask"
  | "findKanbanTaskByRequestId"
  | "updateKanbanTask"
  | "recordKanbanCriteriaChecks"
  | "deleteKanbanTask"
  | "addKanbanComment"
  | "deleteKanbanComment"
  | "addKanbanImage"
  | "addNormalizedKanbanImageForRequest"
  | "deleteKanbanImage"
  | "getKanbanImageData"
  | "getProjectNotes"
  | "saveProjectNotes"
  | "getFeaturePlans"
  | "createFeaturePlan"
  | "updateFeaturePlan"
  | "claimFeaturePlanBuild"
  | "appendFeaturePlanMessage"
  | "appendFeatureStoryMessage"
  | "listAllFeaturePlans"
  | "getFeaturePlan"
  | "listActiveFeaturePlanning"
  | "startFeaturePlanning"
  | "mutateFeaturePlanning"
  | "clearFeaturePlanning"
  | "getLinearAuth"
  | "saveLinearAuth"
  | "clearLinearAuth"
  | "getLinearCompletionComment"
  | "saveLinearCompletionComment"
  | "getGitHubCompletionComment"
  | "withGitHubCompletionCommentLock"
  | "saveGitHubCompletionComment"
>;

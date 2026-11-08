import * as shared from "./storage-shared.js";
import { createHash } from "node:crypto";
import { Data } from "effect";
import {
  applyTicketContentUpdate,
  effectiveDeliveryPolicy,
  hasTicketContentUpdate,
  normalizeTicketContent,
  type AcceptanceCriterionCheck,
  type DeliveryPolicy,
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
import { createLogger } from "@orkestrator/protocol/logger";
import {
  canonicalTicketLabels,
  normalizeTicketLabelName,
  normalizeTicketLabels,
  summarizeTicketLabels,
  ticketLabelKey,
  TICKET_LABEL_LIMITS,
  type TicketLabelSummary,
} from "@orkestrator/protocol/ticket-labels";
import {
  isTicketTombstone,
  parseTicketSyncItem,
  ticketSyncConflictComment,
  TICKET_SYNC_LIMITS,
  type TicketSyncConflict,
  type TicketSyncField,
  type TicketSyncItem,
  type TicketSyncOutboxItem,
  type TicketWorkLocation,
} from "@orkestrator/protocol/ticket-sync";
import {
  acceptsFieldChange,
  assignTicketContent,
  attributeFields,
  storedTicketContent,
  emptyKanbanSyncStore,
  parseKanbanSyncStore,
  pendingTicketFields,
  recordConflict,
  replicaLinkKey,
  stampTicketChange,
  ticketContentValue,
  ticketSnapshot,
  ticketTombstone,
  type KanbanSyncStore,
} from "./storage-kanban-sync.js";

import {
  kanbanTaskAwaitsMergeClosure,
  pendingMergeClosures,
  type KanbanMergeClosure,
} from "./kanban-merge-closure.js";

const log = createLogger("storage");
type FeaturePlanningRecord = shared.FeaturePlanningRecord;
type KanbanImage = shared.KanbanImage;
type KanbanStatus = shared.KanbanStatus;
type KanbanTask = shared.KanbanTask;
type ProjectNotes = shared.ProjectNotes;
type FeaturePlanMessage = shared.FeaturePlanMessage;
type FeaturePlan = shared.FeaturePlan;
type LinearAuth = shared.LinearAuth;
type LinearCompletionComment = shared.LinearCompletionComment;
type GitHubCompletionComment = shared.GitHubCompletionComment;

import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import {
  KanbanLabelCatalogueStore,
  type KanbanLabelCreateResult,
  type KanbanLabelInput,
} from "./storage-kanban-labels.js";

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

/**
 * `labels` as a ticket stores them, spelled as the project already spells
 * them (its catalogue, then its other tickets). Empty is stored as absent.
 */
function boardLabels(
  labels: unknown,
  catalogue: ReadonlyArray<{ name: string }>,
  tasks: readonly KanbanTask[],
  projectId: string,
): string[] {
  const known = [
    ...catalogue.map((label) => label.name),
    ...tasks.filter((task) => task.projectId === projectId).flatMap((task) => task.labels ?? []),
  ];
  return canonicalTicketLabels(normalizeTicketLabels(labels), known);
}

function sameLabels(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * A Kanban `requestId` was reused with different arguments: the earlier
 * request's record exists and differs. Code `kanban-request-id-conflict`
 * (`contract/ipc-error.ts`); callers read it with `errorCode()`, and the
 * message keeps its words for older readers.
 */
export class KanbanRequestIdConflictError extends Data.TaggedError("KanbanRequestIdConflictError")<{
  readonly message: string;
  readonly record: "ticket" | "comment" | "image";
}> {
  readonly code = "kanban-request-id-conflict" as const;
}

function stableKanbanId(namespace: string, requestId: string): string {
  const hex = createHash("sha256").update(namespace).update("\0").update(requestId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type KanbanDeliveryPolicyListener = (
  taskId: string,
  projectId: string,
  policy: DeliveryPolicy | undefined,
) => void;

export class KanbanRepository {
  private deliveryPolicyListener?: KanbanDeliveryPolicyListener;
  private readonly labelCatalogue: KanbanLabelCatalogueStore;

  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {
    this.labelCatalogue = new KanbanLabelCatalogueStore(context, files);
  }

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

  /** The sync store, minted (not yet saved) when there is none. */
  private async loadSyncStore(): Promise<{ store: KanbanSyncStore; fresh: boolean }> {
    const stored = parseKanbanSyncStore(
      await this.context.loadJson<unknown>(this.files.kanbanSyncFile(), () => null),
    );
    return stored
      ? { store: stored, fresh: false }
      : { store: emptyKanbanSyncStore(), fresh: true };
  }

  /**
   * Saves the board with each change stamped for sync (`storage-kanban-sync.ts`),
   * in one commit with the sync store. Call inside the Kanban lease. Each
   * change names a ticket's row before (null when created) and the row being
   * saved (null when deleted). A leaf's outbox that is full refuses the write.
   */
  private async commitKanban(
    tasks: KanbanTask[],
    changes: ReadonlyArray<{ before: KanbanTask | null; stored: KanbanTask | null }>,
    loaded?: { store: KanbanSyncStore; fresh: boolean },
  ): Promise<void> {
    const { store, fresh } = loaded ?? (await this.loadSyncStore());
    const sequence = store.nextSeq;
    const now = nowIso();
    let queued = false;
    for (const change of changes) {
      const controllers = stampTicketChange(store, {
        before: change.before,
        after: change.stored ? normalizeKanbanTask(change.stored) : null,
        stored: change.stored,
        now,
      });
      // Reject values that peers cannot read before either store is committed.
      if (change.stored) parseTicketSyncItem(ticketSnapshot(normalizeKanbanTask(change.stored)));
      if (controllers.length) queued = true;
    }
    const syncChanged = fresh || queued || store.nextSeq !== sequence || loaded !== undefined;
    await this.context.atomically(async () => {
      await this.context.saveJson(this.files.kanbanFile(), tasks);
      if (syncChanged) await this.context.saveJson(this.files.kanbanSyncFile(), store);
    });
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
              log.warn("kanban.image-cleanup-failed");
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
      labels?: readonly string[];
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
    if (initial.labels !== undefined) normalizeTicketLabels(initial.labels);
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const labels =
        initial.labels === undefined
          ? []
          : boardLabels(initial.labels, this.labelCatalogue.list(projectId), tasks, projectId);
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
          existing.featureBuildRequestHash !== initial.featureBuildRequestHash ||
          (initial.labels !== undefined && !sameLabels(existing.labels, labels))
        ) {
          throw new KanbanRequestIdConflictError({
            message: "Kanban ticket requestId was already used with different arguments",
            record: "ticket",
          });
        }
        return normalizeKanbanTask(existing);
      }
      const task: KanbanTask = {
        id,
        projectId,
        title,
        ...content,
        ...(labels.length ? { labels } : {}),
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
      await this.commitKanban(tasks, [{ before: null, stored: task }]);
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
  /**
   * Called after a ticket's delivery policy changes, by any writer (the
   * dropdown, a text edit, an agent tool, the public API). It must not wait on
   * anything that takes the Kanban queue: the queue is held while it is called.
   */
  onDeliveryPolicyChange(listener: KanbanDeliveryPolicyListener): void {
    this.deliveryPolicyListener = listener;
  }

  async updateKanbanTask(
    taskId: string,
    updates: Partial<Omit<KanbanTask, "sections" | "sectionsBasis" | "sync">> &
      KanbanTaskContentInput,
    expectedProjectId?: string,
    options: { notifyDeliveryPolicyChange?: boolean; preserveDoneStatus?: boolean } = {},
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

      // Terminal writers may have read before the monitor closed this ticket.
      // Check under the same lease as the write; user edits remain unconditional.
      if (options.preserveDoneStatus && task.status === "done") {
        const { status: _status, ...remaining } = updates;
        updates = remaining;
      }
      const before = normalizeKanbanTask(structuredClone(task));
      const oldStatus = task.status;
      const oldDeliveryPolicy = before.sections?.delivery?.policy;
      const { kind, markdown, sections, description, acceptanceCriteria, labels, ...rest } =
        updates;
      // Sync bookkeeping is the stamp's alone, whatever a caller sends.
      const { sync: _sync, ...plain } = rest as typeof rest & { sync?: unknown };
      if (labels !== undefined) {
        const next = boardLabels(
          labels,
          this.labelCatalogue.list(task.projectId),
          tasks,
          task.projectId,
        );
        if (next.length) task.labels = next;
        else delete task.labels;
      }
      const contentUpdate: TicketContentUpdate = {
        ...(kind !== undefined ? { kind } : {}),
        ...(markdown !== undefined ? { markdown } : {}),
        ...(sections !== undefined ? { sections } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
      };
      Object.assign(task, plain);
      if (hasTicketContentUpdate(contentUpdate)) {
        // Normalized as a read would, so a legacy hand tick an edit keeps
        // stays dated at the ticket's creation rather than at this save.
        Object.assign(task, applyTicketContentUpdate(normalizeKanbanTask(task), contentUpdate));
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
      await this.commitKanban(tasks, [{ before, stored: task }]);
      this.context.changes.announce("kanban", task.projectId);
      const updated = normalizeKanbanTask(task);
      const deliveryPolicy = updated.sections?.delivery?.policy;
      if (deliveryPolicy !== oldDeliveryPolicy && options.notifyDeliveryPolicyChange !== false) {
        this.deliveryPolicyListener?.(updated.id, updated.projectId, deliveryPolicy);
      }
      return updated;
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
      await this.commitKanban(tasks, [{ before: task, stored: tasks[index]! }]);
      this.context.changes.announce("kanban", task.projectId);
      return tasks[index]!;
    });
  }

  /**
   * Moves tickets whose linked pull request merged to done, once per pull
   * request (`kanban-merge-closure.ts`). With `closures`, those tickets for
   * those URLs; without, every board's recorded merges not yet applied.
   * A missing ticket or one already marked for that URL is skipped. Already
   * done tickets are marked without reordering. Returns only the ids moved.
   */
  async closeKanbanTasksForMergedPullRequests(
    closures?: readonly KanbanMergeClosure[],
  ): Promise<string[]> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const due = closures ?? pendingMergeClosures(tasks.map(normalizeKanbanTask));
      const changes: Array<{ before: KanbanTask; stored: KanbanTask }> = [];
      const moved: string[] = [];
      for (const { taskId, prUrl } of due) {
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task || !kanbanTaskAwaitsMergeClosure(task, prUrl)) continue;
        const before = normalizeKanbanTask(structuredClone(task));
        if (task.status !== "done") {
          moved.push(task.id);
          task.order =
            Math.max(
              -1,
              ...tasks
                .filter(
                  (candidate) =>
                    candidate.projectId === task.projectId &&
                    candidate.status === "done" &&
                    candidate.id !== taskId,
                )
                .map((candidate) => candidate.order),
            ) + 1;
          task.status = "done";
        }
        task.prMergeDoneUrl = prUrl;
        changes.push({ before, stored: task });
      }
      if (changes.length === 0) return [];
      await this.commitKanban(tasks, changes);
      for (const projectId of new Set(changes.map(({ stored }) => stored.projectId))) {
        this.context.changes.announce("kanban", projectId);
      }
      return moved;
    });
  }

  /**
   * Adds one label to a ticket (`present`), or removes it, matching names
   * ignoring case. A name the project already uses keeps its spelling.
   * Adding a label the ticket has, or removing one it lacks, changes nothing.
   */
  async setKanbanTaskLabel(
    taskId: string,
    name: string,
    present: boolean,
    expectedProjectId?: string,
  ): Promise<KanbanTask> {
    const label = normalizeTicketLabelName(name);
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }
      const current = task.labels ?? [];
      const key = ticketLabelKey(label);
      const has = current.some((candidate) => ticketLabelKey(candidate) === key);
      if (has === present) return normalizeKanbanTask(task);
      if (present && current.length >= TICKET_LABEL_LIMITS.maxPerTicket) {
        throw new Error(`A ticket can have at most ${TICKET_LABEL_LIMITS.maxPerTicket} labels`);
      }
      const before = normalizeKanbanTask(structuredClone(task));
      const next = present
        ? boardLabels(
            [...current, label],
            this.labelCatalogue.list(task.projectId),
            tasks,
            task.projectId,
          )
        : current.filter((candidate) => ticketLabelKey(candidate) !== key);
      if (next.length) task.labels = next;
      else delete task.labels;
      await this.commitKanban(tasks, [{ before, stored: task }]);
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
  }

  /**
   * The labels a project offers: its catalogue, then every other name its
   * tickets carry, each with how many tickets carry it.
   */
  async getKanbanLabels(projectId: string): Promise<TicketLabelSummary[]> {
    return summarizeTicketLabels(
      this.labelCatalogue.list(projectId),
      await this.getKanbanTasks(projectId),
    );
  }

  /** Adds a label to the project's catalogue; see `KanbanLabelCatalogueStore.create`. */
  async createKanbanLabel(
    projectId: string,
    input: KanbanLabelInput,
  ): Promise<KanbanLabelCreateResult> {
    // A name a ticket already carries keeps that spelling in the catalogue.
    const used = (await this.getKanbanTasks(projectId)).flatMap((task) => task.labels ?? []);
    const [name] = canonicalTicketLabels([input.name], used);
    return this.labelCatalogue.create(projectId, { ...input, name: name! });
  }

  // A deletion retains only the last publication restriction, not ticket content.
  // Save it before removing the row so Verify can read it without the pipeline lock.
  private deletedDeliveryFile(taskId: string): string {
    const key = createHash("sha256").update(taskId).digest("hex");
    return `${this.files.kanbanFile()}.delivery/${key}.json`;
  }

  async getDeletedKanbanDeliveryPolicy(
    taskId: string,
    projectId: string,
  ): Promise<DeliveryPolicy | undefined> {
    const saved = await this.context.loadJson<{ projectId: string; policy: DeliveryPolicy } | null>(
      this.deletedDeliveryFile(taskId),
      () => null,
    );
    return saved?.projectId === projectId ? saved.policy : undefined;
  }

  async deleteKanbanTask(taskId: string): Promise<void> {
    await this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      await this.context.saveJson(this.deletedDeliveryFile(taskId), {
        projectId: task.projectId,
        policy: effectiveDeliveryPolicy(normalizeKanbanTask(task).sections?.delivery?.policy),
      });
      await this.commitKanban(
        tasks.filter((candidate) => candidate.id !== taskId),
        [{ before: normalizeKanbanTask(task), stored: null }],
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
          throw new KanbanRequestIdConflictError({
            message: "Kanban comment requestId was already used with different text",
            record: "comment",
          });
        }
        return normalizeKanbanTask(task);
      }
      const before = normalizeKanbanTask(structuredClone(task));
      task.comments.push({ id, text, createdAt: nowIso() });
      await this.commitKanban(tasks, [{ before, stored: task }]);
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
  }

  async deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      const before = normalizeKanbanTask(structuredClone(task));
      task.comments = task.comments.filter((comment) => comment.id !== commentId);
      await this.commitKanban(tasks, [{ before, stored: task }]);
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
          throw new KanbanRequestIdConflictError({
            message: "Kanban image requestId was already used with a different filename",
            record: "image",
          });
        }
        return { task: normalizeKanbanTask(task), image: existing };
      }
      const rawBytes = Buffer.from(data, "base64");
      const webpBytes = normalized ? rawBytes : await resizeKanbanImage(rawBytes);
      await fs.mkdir(this.files.kanbanImagesDir(), { recursive: true });
      const image: KanbanImage = { id: imageId, filename, createdAt: nowIso() };
      await fs.writeFile(this.files.kanbanImageFile(image.id), webpBytes);
      const before = normalizeKanbanTask(structuredClone(task));
      task.images.push(image);
      try {
        await this.commitKanban(tasks, [{ before, stored: task }]);
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
      const before = normalizeKanbanTask(structuredClone(task));
      task.images = task.images.filter((image) => image.id !== imageId);
      await this.commitKanban(tasks, [{ before, stored: task }]);
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

  /*
   * Sync across machines (docs/architecture/tickets.md, "Sync across machines").
   * The pure rules are in `storage-kanban-sync.ts`; these hold the lease.
   */

  /**
   * Command node: one project's changes after `cursor`, in change order. A
   * cursor from another epoch, or older than a pruned tombstone, gets a full
   * resync (`reset`, with the ids that exist). Rows written before sync existed
   * are stamped on the first read, so every ticket has a place in the order.
   */
  async ticketSyncChangesSince(
    projectId: string,
    cursor: number,
    epoch: string | undefined,
    limit: number = TICKET_SYNC_LIMITS.maxBatchItems,
  ): Promise<{
    epoch: string;
    items: TicketSyncItem[];
    cursor: number;
    more: boolean;
    reset: boolean;
    liveIds?: string[];
  }> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const loaded = await this.loadSyncStore();
      const { store } = loaded;
      const own = tasks.filter((task) => task.projectId === projectId && !task.sync?.replica);
      const unstamped = own.filter((task) => !task.sync);
      for (const task of unstamped) {
        const seq = store.nextSeq;
        store.nextSeq += 1;
        task.sync = { seq, revs: { title: seq, content: seq, status: seq } };
      }
      if (unstamped.length || loaded.fresh) {
        await this.context.atomically(async () => {
          if (unstamped.length) await this.context.saveJson(this.files.kanbanFile(), tasks);
          await this.context.saveJson(this.files.kanbanSyncFile(), store);
        });
      }
      const reset = epoch !== store.epoch || cursor < (store.prunedThrough[projectId] ?? 0);
      const from = reset ? 0 : cursor;
      const items: TicketSyncItem[] = [
        ...own
          .filter((task) => (task.sync?.seq ?? 0) > from)
          .map((task) => ticketSnapshot(normalizeKanbanTask(task))),
        ...(reset
          ? []
          : Object.entries(store.tombstones)
              .filter(([, tombstone]) => tombstone.projectId === projectId && tombstone.seq > from)
              .map(([id, tombstone]) => ticketTombstone(id, tombstone))),
      ].sort((left, right) => left.seq - right.seq);
      const page = items.slice(0, Math.max(1, limit));
      return {
        epoch: store.epoch,
        items: page,
        cursor: page.at(-1)?.seq ?? from,
        more: items.length > page.length,
        reset,
        ...(reset ? { liveIds: own.map((task) => task.id) } : {}),
      };
    });
  }

  /**
   * Leaf: applies a command node's snapshots and tombstones to this node's
   * copy of the project. A field with a change still queued here keeps the
   * local value until the command node has decided it; a ticket deleted here
   * is not brought back. Returns the cursor to resume from.
   */
  async applyTicketSync(input: {
    controllerId: string;
    projectId: string;
    sourceProjectId: string;
    epoch: string;
    items: readonly TicketSyncItem[];
    cursor: number;
    reset?: boolean;
    liveIds?: readonly string[];
  }): Promise<{ cursor: number; applied: number }> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const { store } = await this.loadSyncStore();
      const key = replicaLinkKey(input.controllerId, input.projectId);
      const other = Object.values(store.replicas).find(
        (link) =>
          link.controllerId === input.controllerId &&
          link.sourceProjectId === input.sourceProjectId &&
          link.projectId !== input.projectId,
      );
      if (other) {
        throw new Error(
          "That command node's tickets for this repository already sync into another project here.",
        );
      }
      const now = nowIso();
      const removedImages: string[] = [];
      let applied = 0;
      let next = tasks;
      const ofThisController = (task: KanbanTask) =>
        task.projectId === input.projectId &&
        task.sync?.replica?.controllerId === input.controllerId;
      if (input.reset && input.liveIds) {
        const live = new Set(input.liveIds);
        next = next.filter((task) => {
          const gone =
            ofThisController(task) && !task.sync?.replica?.pendingCreate && !live.has(task.id);
          if (gone) removedImages.push(...task.images.map((image) => image.id));
          return !gone;
        });
        if (next.length !== tasks.length) applied += tasks.length - next.length;
      }
      const orderIn = (status: KanbanStatus, except?: string) =>
        Math.max(
          -1,
          ...next
            .filter(
              (candidate) =>
                candidate.projectId === input.projectId &&
                candidate.status === status &&
                candidate.id !== except,
            )
            .map((candidate) => candidate.order),
        ) + 1;
      for (const item of input.items) {
        const index = next.findIndex((task) => task.id === item.id);
        const row = index >= 0 ? next[index]! : null;
        // An id that is another project's here, or another command node's copy.
        if (row && row.projectId !== input.projectId)
          throw new Error("Ticket sync id belongs to another project.");
        if (row?.sync?.replica && row.sync.replica.controllerId !== input.controllerId)
          throw new Error("Ticket sync id belongs to another controller.");
        if (isTicketTombstone(item)) {
          if (row) {
            removedImages.push(...row.images.map((image) => image.id));
            next = next.filter((task) => task.id !== item.id);
            applied += 1;
          }
          const seq = store.nextSeq;
          store.nextSeq += 1;
          store.tombstones[item.id] = { projectId: input.projectId, seq, deletedAt: now };
          continue;
        }
        const pending = pendingTicketFields(store, input.controllerId, item.id);
        if (store.tombstones[item.id] || pending.deleted) continue;
        const replica = {
          controllerId: input.controllerId,
          sourceProjectId: input.sourceProjectId,
          seq: item.seq,
          revs: item.revs,
        };
        const content = {
          description: item.description,
          acceptanceCriteria: item.acceptanceCriteria,
          ...(item.kind !== undefined ? { kind: item.kind } : {}),
          ...(item.sections !== undefined ? { sections: item.sections } : {}),
          ...(item.sectionsBasis !== undefined ? { sectionsBasis: item.sectionsBasis } : {}),
          ...(item.labels !== undefined ? { labels: item.labels } : {}),
        };
        if (!row) {
          next = [
            ...next,
            {
              id: item.id,
              projectId: input.projectId,
              title: item.title,
              ...storedTicketContent(content),
              status: item.status,
              ...(item.prMergeDoneUrl ? { prMergeDoneUrl: item.prMergeDoneUrl } : {}),
              comments: item.comments,
              images: [],
              createdAt: item.createdAt,
              order: orderIn(item.status),
              prMergeCommented: false,
              sync: {
                seq: 0,
                revs: {},
                replica,
                ...(item.work ? { work: item.work } : {}),
              },
            },
          ];
          applied += 1;
          continue;
        }
        const updated: KanbanTask = { ...row };
        if (!pending.fields.has("title")) updated.title = item.title;
        if (!pending.fields.has("content")) {
          assignTicketContent(updated, content);
        }
        if (!pending.fields.has("status")) {
          if (updated.status !== item.status) {
            updated.status = item.status;
            updated.order = orderIn(item.status, row.id);
          }
          // Older peers omit the marker; they must not erase one already known.
          if (item.prMergeDoneUrl) updated.prMergeDoneUrl = item.prMergeDoneUrl;
        }
        const authority = new Set(item.comments.map((comment) => comment.id));
        updated.comments = [
          ...item.comments.filter((comment) => !pending.removedComments.has(comment.id)),
          ...row.comments.filter(
            (comment) => pending.addedComments.has(comment.id) && !authority.has(comment.id),
          ),
        ];
        const { work: _work, ...meta } = row.sync ?? { seq: 0, revs: {} };
        updated.sync = { ...meta, replica, ...(item.work ? { work: item.work } : {}) };
        next = next.map((task) => (task.id === row.id ? updated : task));
        applied += 1;
      }
      const link = store.replicas[key];
      store.replicas[key] = {
        controllerId: input.controllerId,
        projectId: input.projectId,
        sourceProjectId: input.sourceProjectId,
        sourceEpoch: input.epoch,
        cursor:
          input.reset || !link || link.sourceEpoch !== input.epoch
            ? input.cursor
            : Math.max(link.cursor, input.cursor),
        appliedAt: now,
      };
      await this.context.atomically(async () => {
        if (applied) await this.context.saveJson(this.files.kanbanFile(), next);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      if (applied) this.context.changes.announce("kanban", input.projectId);
      await this.removeKanbanImageFilesBestEffort(removedImages);
      return { cursor: store.replicas[key]!.cursor, applied };
    });
  }

  /** Leaf: where a command node's sync of this project stands, in that command node's epoch. */
  async getTicketSyncCursor(
    controllerId: string,
    projectId: string,
  ): Promise<{ cursor: number; epoch?: string; pending: number }> {
    const { store } = await this.loadSyncStore();
    const link = store.replicas[replicaLinkKey(controllerId, projectId)];
    return {
      cursor: link?.cursor ?? 0,
      ...(link ? { epoch: link.sourceEpoch } : {}),
      pending: store.outbox[controllerId]?.items.length ?? 0,
    };
  }

  /** Leaf: queued changes for a command node after `after`, oldest first. */
  async collectTicketSyncOutbox(
    controllerId: string,
    after: number,
    limit: number = TICKET_SYNC_LIMITS.maxCollectItems,
  ): Promise<{ epoch: string | null; items: TicketSyncOutboxItem[]; more: boolean }> {
    const { store } = await this.loadSyncStore();
    const outbox = store.outbox[controllerId];
    if (!outbox) return { epoch: null, items: [], more: false };
    const waiting = outbox.items.filter((item) => item.seq > after);
    return {
      epoch: outbox.epoch,
      items: waiting.slice(0, limit),
      more: waiting.length > limit,
    };
  }

  /** Leaf: the command node applied everything up to `upTo` in this epoch. */
  async ackTicketSyncOutbox(
    controllerId: string,
    epoch: string,
    upTo: number,
  ): Promise<{ remaining: number }> {
    return this.enqueueKanbanMutation(async () => {
      const { store } = await this.loadSyncStore();
      const outbox = store.outbox[controllerId];
      if (!outbox || outbox.epoch !== epoch) return { remaining: outbox?.items.length ?? 0 };
      const remaining = outbox.items.filter((item) => item.seq > upTo);
      if (remaining.length !== outbox.items.length) {
        outbox.items = remaining;
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      }
      return { remaining: remaining.length };
    });
  }

  /** Leaf: the command nodes with changes waiting for them. */
  async ticketSyncOutboxControllers(): Promise<string[]> {
    const { store } = await this.loadSyncStore();
    return Object.entries(store.outbox)
      .filter(([, outbox]) => outbox.items.length > 0)
      .map(([controllerId]) => controllerId);
  }

  /**
   * Leaf: a command node detached. Its copies become this node's own tickets,
   * keeping what they say now, and nothing more is queued for it.
   */
  async forgetTicketSyncController(controllerId: string): Promise<void> {
    await this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const { store, fresh } = await this.loadSyncStore();
      if (fresh) return;
      let changed = false;
      for (const task of tasks) {
        if (task.sync?.replica?.controllerId !== controllerId) continue;
        const { replica: _replica, work: _work, ...meta } = task.sync;
        task.sync = meta;
        changed = true;
      }
      const links = Object.keys(store.replicas).filter(
        (key) => store.replicas[key]!.controllerId === controllerId,
      );
      if (!changed && !links.length && !store.outbox[controllerId]) return;
      for (const key of links) delete store.replicas[key];
      delete store.outbox[controllerId];
      await this.context.atomically(async () => {
        if (changed) await this.context.saveJson(this.files.kanbanFile(), tasks);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      if (changed) {
        for (const projectId of new Set(tasks.map((task) => task.projectId))) {
          this.context.changes.announce("kanban", projectId);
        }
      }
    });
  }

  /**
   * Command node: applies a leaf's queued changes in order, each once (its
   * outbox epoch and seq), under the rules of `storage-kanban-sync.ts`. A
   * change that loses is recorded as a conflict and, when the ticket still
   * exists, as a comment on it.
   */
  async applyTicketSyncOps(input: {
    nodeId: string;
    nodeName?: string;
    epoch: string;
    items: readonly TicketSyncOutboxItem[];
  }): Promise<{ appliedSeq: number; applied: number; conflicts: TicketSyncConflict[] }> {
    return this.enqueueKanbanMutation(async () => {
      let tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const loaded = await this.loadSyncStore();
      const { store } = loaded;
      const existing = store.peers[input.nodeId];
      const peer =
        existing && existing.outboxEpoch === input.epoch
          ? { ...existing }
          : { outboxEpoch: input.epoch, appliedSeq: 0, projects: existing?.projects ?? {} };
      const now = nowIso();
      const changes = new Map<string, { before: KanbanTask | null; stored: KanbanTask | null }>();
      const attributed = new Map<string, Set<TicketSyncField>>();
      const workChanged = new Set<string>();
      const conflicts: TicketSyncConflict[] = [];
      const removedImages: string[] = [];
      let applied = 0;
      const track = (row: KanbanTask) => {
        if (!changes.has(row.id)) {
          changes.set(row.id, { before: normalizeKanbanTask(structuredClone(row)), stored: row });
        }
      };
      const attribute = (id: string, field: TicketSyncField) => {
        const fields = attributed.get(id) ?? new Set<TicketSyncField>();
        fields.add(field);
        attributed.set(id, fields);
      };
      const orderIn = (projectId: string, status: KanbanStatus, except?: string) =>
        Math.max(
          -1,
          ...tasks
            .filter(
              (candidate) =>
                candidate.projectId === projectId &&
                candidate.status === status &&
                candidate.id !== except,
            )
            .map((candidate) => candidate.order),
        ) + 1;
      const conflict = (
        item: TicketSyncOutboxItem,
        field: TicketSyncConflict["field"],
        reason: TicketSyncConflict["reason"],
        value: unknown,
        row?: KanbanTask,
      ) => {
        const recorded = recordConflict(store, {
          at: now,
          ticketId: item.ticketId,
          projectId: item.sourceProjectId,
          fromNodeId: input.nodeId,
          ...(input.nodeName ? { fromNodeName: input.nodeName } : {}),
          field,
          reason,
          value,
        });
        conflicts.push(recorded);
        if (row) {
          track(row);
          row.comments = [
            ...row.comments,
            { id: randomUUID(), text: ticketSyncConflictComment(recorded), createdAt: now },
          ];
        }
      };
      const items = [...input.items].sort((left, right) => left.seq - right.seq);
      for (const item of items) {
        if (item.seq <= peer.appliedSeq) continue;
        peer.appliedSeq = item.seq;
        applied += 1;
        const op = item.op;
        const row =
          tasks.find(
            (task) =>
              task.id === item.ticketId &&
              task.projectId === item.sourceProjectId &&
              !task.sync?.replica,
          ) ?? null;
        const deleted = Boolean(store.tombstones[item.ticketId]);
        if (op.kind === "create") {
          if (row) continue;
          if (deleted || tasks.some((task) => task.id === item.ticketId)) {
            conflict(item, "ticket", "ticket-deleted", op.ticket.title);
            continue;
          }
          const created: KanbanTask = {
            id: item.ticketId,
            projectId: item.sourceProjectId,
            title: op.ticket.title,
            ...storedTicketContent(ticketContentValue({ ...op.ticket } as KanbanTask)),
            status: op.ticket.status,
            ...(op.ticket.prMergeDoneUrl ? { prMergeDoneUrl: op.ticket.prMergeDoneUrl } : {}),
            comments: op.ticket.comments,
            images: [],
            createdAt: op.ticket.createdAt,
            order: orderIn(item.sourceProjectId, op.ticket.status),
            prMergeCommented: false,
          };
          tasks = [...tasks, created];
          changes.set(created.id, { before: null, stored: created });
          for (const field of ["title", "content", "status"] as const) attribute(created.id, field);
          continue;
        }
        if (!row) {
          if (deleted && op.kind !== "delete") conflict(item, "ticket", "ticket-deleted", op);
          continue;
        }
        switch (op.kind) {
          case "set-title":
          case "set-content":
          case "set-status": {
            const field: TicketSyncField =
              op.kind === "set-title" ? "title" : op.kind === "set-content" ? "content" : "status";
            const current =
              field === "title"
                ? row.title
                : field === "status"
                  ? row.status
                  : ticketContentValue(normalizeKanbanTask(row));
            const incoming = op.value;
            // A leaf that predates labels sends none; its change leaves them alone.
            if (op.kind === "set-content" && op.value.labels === undefined) {
              delete (current as { labels?: string[] }).labels;
            }
            const mergeChanged =
              op.kind === "set-status" &&
              op.prMergeDoneUrl !== undefined &&
              row.prMergeDoneUrl !== op.prMergeDoneUrl;
            if (JSON.stringify(current) === JSON.stringify(incoming) && !mergeChanged) break;
            if (!acceptsFieldChange(row.sync, field, op.baseRev, input.nodeId)) {
              conflict(
                item,
                field,
                "stale-revision",
                op.kind === "set-content" ? op.value.description : op.value,
                row,
              );
              break;
            }
            track(row);
            if (op.kind === "set-title") row.title = op.value;
            if (op.kind === "set-status") {
              if (row.status !== op.value) row.order = orderIn(row.projectId, op.value, row.id);
              row.status = op.value;
              if (op.prMergeDoneUrl) row.prMergeDoneUrl = op.prMergeDoneUrl;
            }
            if (op.kind === "set-content") {
              assignTicketContent(row, op.value);
            }
            attribute(row.id, field);
            break;
          }
          case "checks": {
            const normalized = normalizeKanbanTask(row);
            let changed = false;
            const criteria = (normalized.sections?.acceptanceCriteria ?? []).map((criterion) => {
              const result = op.checks.find(
                (check) => check.id === criterion.id && check.text === criterion.text,
              );
              if (!result) return criterion;
              changed = true;
              return { ...criterion, check: result.check };
            });
            if (!changed) break;
            track(row);
            assignTicketContent(row, ticketContentValue(normalized));
            row.sections = { ...normalized.sections, acceptanceCriteria: criteria };
            break;
          }
          case "add-comment":
            if (row.comments.some((comment) => comment.id === op.comment.id)) break;
            track(row);
            row.comments = [...row.comments, op.comment];
            break;
          case "delete-comment":
            if (!row.comments.some((comment) => comment.id === op.commentId)) break;
            track(row);
            row.comments = row.comments.filter((comment) => comment.id !== op.commentId);
            break;
          case "work": {
            track(row);
            const meta = row.sync ?? { seq: 0, revs: {} };
            const hasWork = Object.keys(op.work).length > 0;
            if (hasWork) {
              row.sync = {
                ...meta,
                work: {
                  nodeId: input.nodeId,
                  ...(input.nodeName ? { nodeName: input.nodeName } : {}),
                  ...op.work,
                  updatedAt: now,
                },
              };
            } else if (meta.work?.nodeId === input.nodeId) {
              const { work: _work, ...rest } = meta;
              row.sync = rest;
            }
            workChanged.add(row.id);
            break;
          }
          case "delete": {
            const before = changes.get(row.id)?.before ?? normalizeKanbanTask(structuredClone(row));
            await this.context.saveJson(this.deletedDeliveryFile(row.id), {
              projectId: row.projectId,
              policy: effectiveDeliveryPolicy(normalizeKanbanTask(row).sections?.delivery?.policy),
            });
            tasks = tasks.filter((task) => task !== row);
            changes.set(row.id, { before, stored: null });
            removedImages.push(...row.images.map((image) => image.id));
            break;
          }
        }
      }
      store.peers[input.nodeId] = peer;
      const stamp = nowIso();
      for (const change of changes.values()) {
        const seqBefore = change.stored?.sync?.seq;
        stampTicketChange(store, {
          before: change.before,
          after: change.stored ? normalizeKanbanTask(change.stored) : null,
          stored: change.stored,
          now: stamp,
        });
        if (!change.stored) continue;
        attributeFields(change.stored, [...(attributed.get(change.stored.id) ?? [])], input.nodeId);
        // Work on another machine is shown everywhere, so it is a synced change here.
        if (workChanged.has(change.stored.id) && change.stored.sync?.seq === seqBefore) {
          change.stored.sync = {
            ...(change.stored.sync ?? { revs: {} }),
            seq: store.nextSeq,
          } as KanbanTask["sync"];
          store.nextSeq += 1;
        }
      }
      await this.context.atomically(async () => {
        if (changes.size) await this.context.saveJson(this.files.kanbanFile(), tasks);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      for (const projectId of new Set(items.map((item) => item.sourceProjectId))) {
        if (changes.size) this.context.changes.announce("kanban", projectId);
      }
      await this.removeKanbanImageFilesBestEffort(removedImages);
      return { appliedSeq: peer.appliedSeq, applied, conflicts };
    });
  }

  /** Command node: what a leaf confirmed for one of this node's projects. */
  async recordTicketSyncPeer(
    nodeId: string,
    projectId: string,
    leafProjectId: string,
    cursor: number,
  ): Promise<void> {
    await this.enqueueKanbanMutation(async () => {
      const { store } = await this.loadSyncStore();
      const peer = store.peers[nodeId] ?? { appliedSeq: 0, projects: {} };
      const previous = peer.projects[projectId];
      if (previous && previous.cursor === cursor && previous.leafProjectId === leafProjectId) {
        // Only the time moved; keep writes to real progress.
        previous.syncedAt = nowIso();
      } else {
        peer.projects = {
          ...peer.projects,
          [projectId]: { leafProjectId, cursor, syncedAt: nowIso() },
        };
      }
      store.peers[nodeId] = peer;
      await this.context.saveJson(this.files.kanbanSyncFile(), store);
    });
  }

  /** Command node: the inputs of one project's sync status. */
  async getTicketSyncOverview(projectId: string): Promise<{
    latestSeq: number;
    peers: Array<{ nodeId: string; leafProjectId: string; cursor: number; syncedAt?: string }>;
    conflicts: TicketSyncConflict[];
    knownNodes: string[];
  }> {
    const tasks = await this.getKanbanTasks(projectId);
    const { store } = await this.loadSyncStore();
    const latestSeq = Math.max(
      0,
      ...tasks.filter((task) => !task.sync?.replica).map((task) => task.sync?.seq ?? 0),
      ...Object.values(store.tombstones)
        .filter((tombstone) => tombstone.projectId === projectId)
        .map((tombstone) => tombstone.seq),
    );
    return {
      latestSeq,
      peers: Object.entries(store.peers).flatMap(([nodeId, peer]) => {
        const project = peer.projects[projectId];
        return project ? [{ nodeId, ...project }] : [];
      }),
      conflicts: store.conflicts.filter((conflict) => conflict.projectId === projectId),
      knownNodes: Object.keys(store.peers),
    };
  }

  /**
   * Command node: a ticket's work started on another machine. The leaf will
   * report its own progress; this shows where it runs at once.
   */
  async recordTicketRemoteWork(taskId: string, work: TicketWorkLocation): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.context.loadJson<KanbanTask[]>(this.files.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId && !candidate.sync?.replica);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      const { store } = await this.loadSyncStore();
      const seq = store.nextSeq;
      store.nextSeq += 1;
      task.sync = { ...(task.sync ?? { revs: {} }), seq, work } as KanbanTask["sync"];
      await this.context.atomically(async () => {
        await this.context.saveJson(this.files.kanbanFile(), tasks);
        await this.context.saveJson(this.files.kanbanSyncFile(), store);
      });
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
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

  /**
   * Undo a build claim whose pipeline never started.
   *
   * Only the claim this launch made is released, and only while no pipeline
   * has been linked to it: once the supervisor recorded a pipeline the plan
   * follows that pipeline, failed or not, and a launcher's rollback must not
   * overwrite the link.
   */
  async releaseFeaturePlanBuildClaim(
    featureId: string,
    taskId: string,
    restoreStatus: FeaturePlan["status"],
  ): Promise<{ released: boolean; feature: FeaturePlan }> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
        if (plan.buildTaskId !== taskId || plan.buildPipelineId) {
          return { released: false, feature: plan };
        }
        plan.status = restoreStatus === "building" ? "stories" : restoreStatus;
        delete plan.buildTaskId;
        plan.updatedAt = nowIso();
        return { released: true, feature: plan };
      },
      (result) => result.feature.projectId,
    );
  }

  /**
   * Record the pipeline a claimed build started, unless the plan has since
   * moved to a different build.
   */
  async linkFeaturePlanBuild(
    featureId: string,
    taskId: string,
    link: { buildPipelineId: string; environmentId?: string },
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans(
      (plans) => {
        const plan = plans.find((candidate) => candidate.id === featureId);
        if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
        if (plan.buildTaskId !== taskId) return plan;
        if (plan.buildPipelineId && plan.buildPipelineId !== link.buildPipelineId) return plan;
        plan.status = "building";
        plan.buildPipelineId = link.buildPipelineId;
        if (link.environmentId) plan.codexEnvironmentId = link.environmentId;
        plan.updatedAt = nowIso();
        return plan;
      },
      (plan) => plan.projectId,
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
  | "closeKanbanTasksForMergedPullRequests"
  | "setKanbanTaskLabel"
  | "getKanbanLabels"
  | "createKanbanLabel"
  | "deleteKanbanTask"
  | "getDeletedKanbanDeliveryPolicy"
  | "onDeliveryPolicyChange"
  | "addKanbanComment"
  | "deleteKanbanComment"
  | "addKanbanImage"
  | "addNormalizedKanbanImageForRequest"
  | "deleteKanbanImage"
  | "getKanbanImageData"
  | "ticketSyncChangesSince"
  | "applyTicketSync"
  | "getTicketSyncCursor"
  | "collectTicketSyncOutbox"
  | "ackTicketSyncOutbox"
  | "ticketSyncOutboxControllers"
  | "forgetTicketSyncController"
  | "applyTicketSyncOps"
  | "recordTicketSyncPeer"
  | "getTicketSyncOverview"
  | "recordTicketRemoteWork"
  | "getProjectNotes"
  | "saveProjectNotes"
  | "getFeaturePlans"
  | "createFeaturePlan"
  | "updateFeaturePlan"
  | "claimFeaturePlanBuild"
  | "releaseFeaturePlanBuildClaim"
  | "linkFeaturePlanBuild"
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

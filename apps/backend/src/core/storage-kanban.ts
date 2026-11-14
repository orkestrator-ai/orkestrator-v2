import { TICKET_SYNC_LIMITS, parseTicketSyncImageRef } from "@orkestrator/protocol/ticket-sync";
import * as shared from "./storage-shared.js";
import { createHash } from "node:crypto";
import { Data } from "effect";
import {
  applyTicketContentUpdate,
  effectiveDeliveryPolicy,
  hasTicketContentUpdate,
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
import {
  canonicalTicketLabels,
  normalizeTicketLabelName,
  normalizeTicketLabels,
  summarizeTicketLabels,
  ticketLabelKey,
  TICKET_LABEL_LIMITS,
  type TicketLabelSummary,
} from "@orkestrator/protocol/ticket-labels";
import { KanbanBoardStore, normalizeKanbanTask } from "./storage-kanban-board.js";

export { normalizeKanbanTask } from "./storage-kanban-board.js";

import {
  kanbanTaskAwaitsMergeClosure,
  clearKanbanLifecycleOwnership,
  kanbanTaskReturnsForClosedPullRequest,
  pendingMergeClosures,
  type KanbanMergeClosure,
} from "./kanban-merge-closure.js";

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
    private readonly board: KanbanBoardStore,
  ) {
    this.labelCatalogue = new KanbanLabelCatalogueStore(context, files);
  }

  async getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    return this.board.projectTasks(projectId);
  }

  async getKanbanTask(taskId: string): Promise<KanbanTask | null> {
    const tasks = await this.board.loadTasks();
    const task = tasks.find((candidate) => candidate.id === taskId);
    return task ? normalizeKanbanTask(task) : null;
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
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
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
        updatedAt: createdAt,
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
      await this.board.commit(tasks, [{ before: null, stored: task }]);
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
    const tasks = await this.board.loadTasks();
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
    options: {
      notifyDeliveryPolicyChange?: boolean;
      /**
       * A build lifecycle write (`build-pipeline-kanban-lifecycle.ts`): it
       * never moves a done ticket, and a status it writes is recorded as the
       * ticket's `lifecycleStatus`. `preserveDoneStatus` is its older name.
       */
      lifecycle?: boolean;
      preserveDoneStatus?: boolean;
    } = {},
  ): Promise<KanbanTask> {
    const lifecycle = options.lifecycle === true || options.preserveDoneStatus === true;
    if (
      updates.status !== undefined &&
      !isOneOf(updates.status, ["backlog", "in-progress", "review", "done"])
    ) {
      throw new Error("Kanban task status is invalid");
    }
    if (updates.prState !== undefined && !isOneOf(updates.prState, ["open", "merged", "closed"])) {
      throw new Error("Kanban task pull request state is invalid");
    }
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }

      // Terminal writers may have read before the monitor closed this ticket.
      // Check under the same lease as the write; user edits remain unconditional.
      if (lifecycle && task.status === "done") {
        const { status: _status, ...remaining } = updates;
        updates = remaining;
      }
      // The markers are the lifecycle's and the closure's alone, whatever a
      // caller sends.
      const {
        lifecycleStatus: _marker,
        lifecyclePrUrl: _owner,
        lifecycleEcho: _echo,
        prClosedReturnUrl: _closed,
        ...withoutMarker
      } = updates as typeof updates & {
        lifecycleStatus?: unknown;
        lifecyclePrUrl?: unknown;
        lifecycleEcho?: unknown;
        prClosedReturnUrl?: unknown;
      };
      updates = withoutMarker;
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
      if (lifecycle && updates.status) {
        task.lifecycleStatus = updates.status;
        // The build that raises a pull request owns the column with it; a
        // build starting owns it with none yet, so an older build's pull
        // request closing leaves the ticket alone.
        if (updates.prUrl) task.lifecyclePrUrl = updates.prUrl;
        else if (updates.status === "in-progress") delete task.lifecyclePrUrl;
        // A command node's ticket: the move comes back from the command node
        // with a new status revision, which is not a hand move there.
        if (updates.status !== oldStatus && task.sync?.replica) task.lifecycleEcho = true;
      } else if (updates.status !== undefined && updates.status !== oldStatus) {
        clearKanbanLifecycleOwnership(task);
      }
      await this.board.commit(tasks, [{ before, stored: task }]);
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
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
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
      await this.board.commit(tasks, [{ before: task, stored: tasks[index]! }]);
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
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
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
          task.lifecycleStatus = "done";
          if (task.sync?.replica) task.lifecycleEcho = true;
        }
        task.prMergeDoneUrl = prUrl;
        changes.push({ before, stored: task });
      }
      if (changes.length === 0) return [];
      await this.board.commit(tasks, changes);
      for (const projectId of new Set(changes.map(({ stored }) => stored.projectId))) {
        this.context.changes.announce("kanban", projectId);
      }
      return moved;
    });
  }

  /**
   * A ticket whose build's pull request closed without merging goes back to
   * the backlog (`kanbanTaskReturnsForClosedPullRequest`), unless the user
   * moved it by hand since the build last moved it, a newer build owns it, it
   * is done, or that pull request merged once already. Each closed pull
   * request is decided once (`prClosedReturnUrl`), so a replay, from the
   * monitor or the build, never moves it again. Returns whether it moved.
   */
  async returnKanbanTaskForClosedPullRequest(taskId: string, prUrl: string): Promise<boolean> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.prClosedReturnUrl === prUrl) return false;
      const before = normalizeKanbanTask(structuredClone(task));
      const returns = kanbanTaskReturnsForClosedPullRequest(task, prUrl);
      task.prClosedReturnUrl = prUrl;
      if (!returns) {
        await this.board.commit(tasks, [{ before, stored: task }]);
        return false;
      }
      task.order =
        Math.max(
          -1,
          ...tasks
            .filter(
              (candidate) =>
                candidate.projectId === task.projectId &&
                candidate.status === "backlog" &&
                candidate.id !== taskId,
            )
            .map((candidate) => candidate.order),
        ) + 1;
      task.status = "backlog";
      task.lifecycleStatus = "backlog";
      if (task.sync?.replica) task.lifecycleEcho = true;
      await this.board.commit(tasks, [{ before, stored: task }]);
      this.context.changes.announce("kanban", task.projectId);
      return true;
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
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
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
      await this.board.commit(tasks, [{ before, stored: task }]);
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

  async getDeletedKanbanDeliveryPolicy(
    taskId: string,
    projectId: string,
  ): Promise<DeliveryPolicy | undefined> {
    const saved = await this.context.loadJson<{ projectId: string; policy: DeliveryPolicy } | null>(
      this.board.deletedDeliveryFile(taskId),
      () => null,
    );
    return saved?.projectId === projectId ? saved.policy : undefined;
  }

  async deleteKanbanTask(taskId: string): Promise<void> {
    await this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      await this.context.saveJson(this.board.deletedDeliveryFile(taskId), {
        projectId: task.projectId,
        policy: effectiveDeliveryPolicy(normalizeKanbanTask(task).sections?.delivery?.policy),
      });
      await this.board.commit(
        tasks.filter((candidate) => candidate.id !== taskId),
        [{ before: normalizeKanbanTask(task), stored: null }],
      );
      this.context.changes.announce("kanban", task.projectId);
      await this.board.removeImageFilesBestEffort(task.images.map((image) => image.id));
    });
  }

  async addKanbanComment(
    taskId: string,
    text: string,
    expectedProjectId?: string,
    requestId?: string,
  ): Promise<KanbanTask> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
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
      await this.board.commit(tasks, [{ before, stored: task }]);
      this.context.changes.announce("kanban", task.projectId);
      return normalizeKanbanTask(task);
    });
  }

  async deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      const before = normalizeKanbanTask(structuredClone(task));
      task.comments = task.comments.filter((comment) => comment.id !== commentId);
      await this.board.commit(tasks, [{ before, stored: task }]);
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
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
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
      if (task.images.length >= TICKET_SYNC_LIMITS.maxImageRefs) {
        throw new Error("This ticket has reached the image limit.");
      }
      parseTicketSyncImageRef({ id: imageId, filename, createdAt: nowIso() });
      const rawBytes = Buffer.from(data, "base64");
      const webpBytes = normalized ? rawBytes : await resizeKanbanImage(rawBytes);
      await fs.mkdir(this.files.kanbanImagesDir(), { recursive: true });
      const image: KanbanImage = { id: imageId, filename, createdAt: nowIso() };
      await fs.writeFile(this.files.kanbanImageFile(image.id), webpBytes);
      const before = normalizeKanbanTask(structuredClone(task));
      task.images.push(image);
      try {
        await this.board.commit(tasks, [{ before, stored: task }]);
      } catch (error) {
        await fs.rm(this.files.kanbanImageFile(image.id), { force: true });
        throw error;
      }
      this.context.changes.announce("kanban", task.projectId);
      return { task: normalizeKanbanTask(task), image };
    });
  }

  async deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    return this.board.enqueue(async () => {
      const tasks = await this.board.loadTasks();
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
      await this.board.commit(tasks, [{ before, stored: task }]);
      this.context.changes.announce("kanban", task.projectId);
      await this.board.removeImageFilesBestEffort([imageId]);
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

  /** `connectedAt` is kept when given: refreshing who the key signs in as is not a new connection. */
  async saveLinearAuth(
    apiKey: string,
    viewer?: LinearAuth["viewer"],
    connectedAt?: string,
  ): Promise<LinearAuth> {
    const auth: LinearAuth = {
      apiKey,
      connectedAt: connectedAt ?? nowIso(),
      viewer,
    };
    await this.enqueueLinearAuthMutation(() =>
      this.context.saveSensitiveJson(this.files.linearAuthFile(), auth),
    );
    return auth;
  }

  /**
   * Clears the connection. With `shouldClear`, only when it accepts the
   * connection current at that moment: the check and the delete share the
   * store's lease, so a connection saved after the caller last read one is
   * judged on its own. Returns whether a connection was cleared.
   */
  async clearLinearAuth(shouldClear?: (auth: LinearAuth) => boolean): Promise<boolean> {
    return this.enqueueLinearAuthMutation(async () => {
      if (shouldClear) {
        const current = await this.getLinearAuth();
        if (!current || !shouldClear(current)) return false;
      }
      await this.context.deleteStore(this.files.linearAuthFile());
      return true;
    });
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
  | "returnKanbanTaskForClosedPullRequest"
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

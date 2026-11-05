/**
 * Worker outcomes: a coordinator hears when a worker it owns is merged,
 * closed or deleted, whoever did it.
 *
 * A `pull-request` follow (`coordinator-pr-status.ts`) exists only for a PR
 * the coordinator raised, resolved or got from its review's auto-PR. A
 * pipeline environment's PR, a PR the user raised on a coordinator's worker,
 * and a deletion had no notice at all, so a coordinator could keep planning
 * around work that had already landed or gone. This watch closes that gap
 * with one awareness notice per worker: it says what happened and that
 * nothing needs doing unless it affects follow-up work.
 *
 * Ownership is the coordinator's own durable record of the worker: the
 * earliest `environment` (a launch or a delegation) or `build-pipeline`
 * association naming it, per coordinator and node. The watch lives on that
 * association (`workerOutcome`), so it adds no records. It ends at the first
 * merge, close or deletion. A merge or close a live PR follow will report (or
 * already did) ends it silently, so the coordinator hears each outcome once.
 * First observations of recent associations report terminal outcomes too;
 * only day-old, unobserved associations are backfilled silently.
 */
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type {
  CoordinatorWorkerOutcome,
  CoordinatorWorkflowAssociation,
  CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type { CoordinatorStatusWakeMode } from "@orkestrator/protocol/agent-mail";
import { prKeyTag, WORKER_OUTCOME_AWARENESS } from "./coordinator-pr-status.js";
import type { CoordinatorRemoteAccess } from "./coordinator-remote.js";
import type { CoordinatorStatus, CoordinatorStatusResource } from "./coordinator-status-wakes.js";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";

type PrState = NonNullable<CoordinatorWorkerOutcome["prState"]>;

/** What the watch read of its worker. */
export interface WorkerOutcomeReading {
  /** The worker's record is gone (deleted). */
  gone: boolean;
  /** Its deletion has started; a merge is reported with it, anything else waits for it to finish. */
  deleting: boolean;
  prUrl: string | null;
  prState: PrState | null;
  name?: string;
}

export interface WorkerOutcomeNotice {
  resource: CoordinatorStatusResource;
  status: CoordinatorStatus;
}

export interface CoordinatorWorkerOutcomeHost {
  storage: StorageService;
  now(): number;
  remote(): CoordinatorRemoteAccess | null;
  statusOnNode(status: CoordinatorStatus, nodeId: string, nodeName: string): CoordinatorStatus;
  deliver(
    workspaces: CoordinatorWorkspace[],
    association: CoordinatorWorkflowAssociation,
    resource: CoordinatorStatusResource,
    status: CoordinatorStatus,
  ): Promise<boolean>;
}

type Mutation = {
  associationId: string;
  mutate: (association: CoordinatorWorkflowAssociation) => boolean;
};

const log = createLogger("coordinator");
const BACKFILL_LIMIT_MS = 24 * 60 * 60 * 1_000;

const PR_STATES: ReadonlySet<unknown> = new Set(["open", "closed", "merged"]);

function prStateOf(value: unknown): PrState | null {
  return PR_STATES.has(value) ? (value as PrState) : null;
}

function bounded(value: string, limit = 400): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function watchKey(environmentId: string, nodeId: string | undefined): string {
  return `${nodeId ?? ""}\0${environmentId}`;
}

/** The worker an owning association names, when known. */
function workerOf(association: CoordinatorWorkflowAssociation): string | undefined {
  if (association.kind === "environment") return association.resourceId;
  if (association.kind === "build-pipeline") return association.workerOutcome?.environmentId;
  return undefined;
}

function canOwn(association: CoordinatorWorkflowAssociation): boolean {
  return (
    (association.kind === "environment" || association.kind === "build-pipeline") &&
    !association.pending &&
    !association.nodeRelease
  );
}

/**
 * The association that holds each worker's watch, per coordinator, worker and
 * node: the one already watching, else the earliest. Keyed by `watchKey`.
 */
export function workerOutcomeOwners(
  workflows: readonly CoordinatorWorkflowAssociation[],
): Map<string, CoordinatorWorkflowAssociation[]> {
  const groups = new Map<string, CoordinatorWorkflowAssociation>();
  for (const association of workflows) {
    const environmentId = canOwn(association) ? workerOf(association) : undefined;
    if (!environmentId) continue;
    const group = [
      association.coordinatorId,
      association.projectId,
      watchKey(environmentId, association.nodeId),
    ].join("\0");
    const current = groups.get(group);
    const watching = (item: CoordinatorWorkflowAssociation) =>
      Boolean(item.workerOutcome?.observedAt || item.workerOutcome?.ended);
    if (
      !current ||
      (watching(association) && !watching(current)) ||
      (watching(association) === watching(current) &&
        (association.createdAt < current.createdAt ||
          (association.createdAt === current.createdAt && association.id < current.id)))
    )
      groups.set(group, association);
  }
  const byWorker = new Map<string, CoordinatorWorkflowAssociation[]>();
  for (const owner of groups.values()) {
    const key = watchKey(workerOf(owner)!, owner.nodeId);
    byWorker.set(key, [...(byWorker.get(key) ?? []), owner]);
  }
  return byWorker;
}

/**
 * The one notice a worker's outcome is worth, or null while there is none:
 * its PR merged or closed (with the deletion, when it is going too), or the
 * environment deleted with its PR still open or without one. A deletion
 * still in progress waits until the record is gone, unless the PR already
 * merged or closed.
 */
export function workerOutcomeNotice(
  environmentId: string,
  reading: WorkerOutcomeReading,
): { key: string; notice: WorkerOutcomeNotice } | null {
  const label = reading.name ?? environmentId;
  const deleted = reading.gone || reading.deleting;
  const url = reading.prUrl ? [`Pull request: ${bounded(reading.prUrl)}`] : [];
  const read = reading.gone
    ? ["list_workflows {}"]
    : [`get_environment { "environmentId": "${environmentId}" }`];
  if (reading.prUrl && (reading.prState === "merged" || reading.prState === "closed")) {
    const merged = reading.prState === "merged";
    const key = `${reading.prState}:${prKeyTag(reading.prUrl)}`;
    return {
      key,
      notice: {
        resource: { kind: "pull-request", id: environmentId, environmentId, label },
        status: {
          key,
          state: merged ? "pr-merged" : "pr-closed",
          tone: merged ? "success" : "info",
          terminal: true,
          headline: `${merged ? "was merged" : "was closed without merging"}${
            deleted ? " and its environment deleted" : ""
          }`,
          details: [
            ...url,
            ...(deleted ? ["The worker environment is gone; do not send it more work."] : []),
            WORKER_OUTCOME_AWARENESS,
          ],
          tools: read,
          mode: "settled",
        },
      },
    };
  }
  if (!reading.gone) return null;
  return {
    key: "deleted",
    notice: {
      resource: { kind: "environment", id: environmentId, environmentId, label },
      status: {
        key: "deleted",
        state: "deleted",
        tone: "info",
        terminal: true,
        headline: "was deleted",
        details: [
          reading.prUrl
            ? `Its pull request was ${reading.prState ?? "in an unknown state"} when it was deleted: ${bounded(reading.prUrl)}`
            : "It had no pull request when it was deleted.",
          "The worker environment is gone; do not send it more work.",
          WORKER_OUTCOME_AWARENESS,
        ],
        tools: read,
        mode: "settled",
      },
    },
  };
}

/** A live PR follow will report this merge or close, or one already did. */
function followCovers(
  workflows: readonly CoordinatorWorkflowAssociation[],
  owner: CoordinatorWorkflowAssociation,
  environmentId: string,
  key: string,
  prUrl: string,
): boolean {
  return workflows.some(
    (item) =>
      item.kind === "pull-request" &&
      item.coordinatorId === owner.coordinatorId &&
      item.projectId === owner.projectId &&
      item.resourceId === environmentId &&
      item.nodeId === owner.nodeId &&
      !item.pending &&
      (item.statusNotice?.key === key ||
        (!item.terminalNotifiedAt &&
          (!item.pullRequest?.prUrl || item.pullRequest.prUrl === prUrl))),
  );
}

/** Watches coordinator-owned workers' outcomes; see the module comment. */
export class CoordinatorWorkerOutcomes {
  /** Workers with a live watch (`watchKey`); null until the first sweep, when every change counts. */
  private watched: Set<string> | null = null;

  constructor(private readonly host: CoordinatorWorkerOutcomeHost) {}

  /** Whether a change to this worker could end a watch. */
  watches(environmentId: string, nodeId?: string): boolean {
    return !this.watched || this.watched.has(watchKey(environmentId, nodeId));
  }

  /** Every watch from one read of the store (the sweep); learns pipelines' workers first. */
  async reconcile(
    workspaces: CoordinatorWorkspace[],
    workflows: CoordinatorWorkflowAssociation[],
    mode: CoordinatorStatusWakeMode,
  ): Promise<void> {
    const resolved = await this.resolvePipelineWorkers(workflows);
    const owners = workerOutcomeOwners(resolved);
    this.watched = new Set(
      [...owners.entries()]
        .filter(([, group]) => group.some((owner) => !owner.workerOutcome?.ended))
        .map(([key]) => key),
    );
    const mutations: Mutation[] = [];
    for (const group of owners.values()) {
      for (const owner of group)
        await this.observeSafely(workspaces, resolved, owner, mode, mutations);
    }
    await this.host.storage.coordinators.updateCoordinatorWorkflowAssociations(mutations);
  }

  /** The watches on one worker, after a change to it. */
  async observeWorker(
    workspaces: CoordinatorWorkspace[],
    workflows: CoordinatorWorkflowAssociation[],
    environmentId: string,
    nodeId: string | undefined,
    mode: CoordinatorStatusWakeMode,
  ): Promise<void> {
    const group = workerOutcomeOwners(workflows).get(watchKey(environmentId, nodeId)) ?? [];
    const mutations: Mutation[] = [];
    for (const owner of group)
      await this.observeSafely(workspaces, workflows, owner, mode, mutations);
    await this.host.storage.coordinators.updateCoordinatorWorkflowAssociations(mutations);
  }

  /**
   * Just before a worker's record is deleted here: keep its last reading on
   * its watches, so the deletion (and a merge Merge and Cleanup recorded a
   * moment before) is reported once the record is gone. True when a watch
   * took it.
   */
  async captureDeleted(environment: Environment): Promise<boolean> {
    const state = await this.host.storage.coordinators.getCoordinatorReconciliationState();
    const resolved = await this.resolvePipelineWorkers(state.workflows);
    const group = workerOutcomeOwners(resolved).get(watchKey(environment.id, undefined));
    const live = (group ?? []).filter((owner) => !owner.workerOutcome?.ended);
    if (live.length === 0) return false;
    const deletedAt = new Date(this.host.now()).toISOString();
    const prUrl = environment.prUrl || undefined;
    const prState = prStateOf(environment.prState) ?? undefined;
    await this.host.storage.coordinators.updateCoordinatorWorkflowAssociations(
      live.map((owner) => ({
        associationId: owner.id,
        mutate: (current) => {
          if (current.workerOutcome?.ended || current.workerOutcome?.deletedAt) return false;
          current.workerOutcome = {
            ...current.workerOutcome,
            ...(current.kind === "build-pipeline" ? { environmentId: environment.id } : {}),
            prUrl,
            prState,
            name: environment.name,
            deletedAt,
          };
          return true;
        },
      })),
    );
    this.watched?.add(watchKey(environment.id, undefined));
    return true;
  }

  /**
   * Learn the worker of each coordinator build pipeline that has none yet,
   * in one write. A pipeline whose record is gone has nothing to watch; one
   * that has not named its worker yet is asked again on the next sweep.
   */
  private async resolvePipelineWorkers(
    workflows: CoordinatorWorkflowAssociation[],
  ): Promise<CoordinatorWorkflowAssociation[]> {
    const learned = new Map<string, CoordinatorWorkerOutcome>();
    for (const association of workflows) {
      if (
        association.kind !== "build-pipeline" ||
        association.pending ||
        association.workerOutcome?.environmentId ||
        association.workerOutcome?.ended
      )
        continue;
      const remote = association.nodeId ? this.host.remote() : null;
      if (association.nodeId && !remote) continue;
      const read = remote
        ? await remote
            .workflow(association.nodeId!, "build-pipeline", association.resourceId)
            .catch(() => "unavailable" as const)
        : await this.host.storage
            .getBuildPipeline(association.resourceId)
            .catch(() => "unavailable" as const);
      if (read === "unavailable") continue;
      const snapshot = read?.snapshot as { environmentId?: unknown } | undefined;
      const environmentId =
        typeof snapshot?.environmentId === "string" && snapshot.environmentId
          ? snapshot.environmentId
          : undefined;
      // A pipeline still creating its worker names it on a later sweep.
      if (read && !environmentId) continue;
      const at = new Date(this.host.now()).toISOString();
      learned.set(
        association.id,
        environmentId
          ? { ...association.workerOutcome, environmentId }
          : { ...association.workerOutcome, ended: { key: "untracked", at, notified: false } },
      );
    }
    if (learned.size === 0) return workflows;
    await this.host.storage.coordinators.updateCoordinatorWorkflowAssociations(
      [...learned].map(([associationId, outcome]) => ({
        associationId,
        mutate: (current) => {
          if (current.workerOutcome?.environmentId || current.workerOutcome?.ended) return false;
          current.workerOutcome = { ...current.workerOutcome, ...outcome };
          return true;
        },
      })),
    );
    return workflows.map((association) => {
      const outcome = learned.get(association.id);
      return outcome ? { ...association, workerOutcome: outcome } : association;
    });
  }

  /** The worker as its node sees it now, or null when it cannot be read this time. */
  private async read(
    owner: CoordinatorWorkflowAssociation,
    environmentId: string,
  ): Promise<WorkerOutcomeReading | null> {
    const watch = owner.workerOutcome ?? {};
    const last = {
      prUrl: watch.prUrl ?? null,
      prState: watch.prState ?? null,
      ...(watch.name ? { name: watch.name } : {}),
    };
    if (owner.nodeId) {
      const remote = this.host.remote();
      if (!remote?.pullRequestReading) return null;
      const read = await remote
        .pullRequestReading(owner.nodeId, environmentId)
        .catch(() => "unavailable" as const);
      // An unreachable node is no news; the sweep asks again.
      if (read === "unavailable") return null;
      if (!read) return { gone: true, deleting: true, ...last };
      return {
        gone: false,
        deleting: read.deleting === true,
        prUrl: read.reading.prUrl,
        prState: read.reading.prState,
        ...(read.name ? { name: read.name } : {}),
      };
    }
    const environment = await this.host.storage.getEnvironment(environmentId);
    if (!environment) return { gone: true, deleting: true, ...last };
    return {
      gone: false,
      deleting: Boolean(
        environment.deletionRequestedAt || environment.lifecycleOperation === "deleting",
      ),
      prUrl: environment.prUrl || null,
      prState: prStateOf(environment.prState),
      name: environment.name,
    };
  }

  private async observeSafely(
    workspaces: CoordinatorWorkspace[],
    workflows: readonly CoordinatorWorkflowAssociation[],
    owner: CoordinatorWorkflowAssociation,
    mode: CoordinatorStatusWakeMode,
    mutations: Mutation[],
  ): Promise<void> {
    try {
      await this.observe(workspaces, workflows, owner, mode, mutations);
    } catch (error) {
      log.warn("wake.worker-outcomes-failed", { error: formatLogError(error) });
    }
  }

  private async observe(
    workspaces: CoordinatorWorkspace[],
    workflows: readonly CoordinatorWorkflowAssociation[],
    owner: CoordinatorWorkflowAssociation,
    mode: CoordinatorStatusWakeMode,
    mutations: Mutation[],
  ): Promise<void> {
    const environmentId = workerOf(owner);
    let watch = owner.workerOutcome ?? {};
    if (!environmentId || watch.ended) return;
    let reading = await this.read(owner, environmentId);
    if (!reading) return;
    // A deletion can capture the final PR while the environment read is in flight.
    // Its complete snapshot takes precedence over that older read.
    const current = (
      await this.host.storage.coordinators.getCoordinatorReconciliationState()
    ).workflows.find((item) => item.id === owner.id);
    if (!current || current.workerOutcome?.ended) return;
    watch = current.workerOutcome ?? watch;
    if (watch.deletedAt) {
      const latest = await this.read(current, environmentId);
      if (!latest) return;
      reading = {
        ...latest,
        deleting: true,
        prUrl: watch.prUrl ?? null,
        prState: watch.prState ?? null,
        name: watch.name,
      };
    }
    const at = new Date(this.host.now()).toISOString();
    const end = (key: string, notified: boolean) => ({ key, at, notified });
    const seen: CoordinatorWorkerOutcome = {
      ...watch,
      observedAt: watch.observedAt ?? at,
      ...(reading.prUrl ? { prUrl: reading.prUrl } : {}),
      ...(reading.prState ? { prState: reading.prState } : {}),
      ...(reading.name ? { name: reading.name } : {}),
    };
    const outcome = workerOutcomeNotice(environmentId, reading);
    let ended: CoordinatorWorkerOutcome["ended"];
    if (
      outcome &&
      !watch.observedAt &&
      !watch.deletedAt &&
      this.host.now() - Date.parse(owner.createdAt) > BACKFILL_LIMIT_MS
    ) {
      // Only old associations are silent backfill; recent work can finish before a sweep.
      ended = end(outcome.key, false);
    } else if (outcome) {
      const covered =
        outcome.key !== "deleted" &&
        reading.prUrl !== null &&
        followCovers(workflows, owner, environmentId, outcome.key, reading.prUrl);
      if (covered || mode === "off") {
        ended = end(outcome.key, false);
      } else {
        const remote = owner.nodeId ? this.host.remote() : null;
        const nodeName =
          remote && owner.nodeId
            ? await remote.nodeName(owner.nodeId).catch(() => owner.nodeId!)
            : null;
        const { resource, status } = outcome.notice;
        const delivered = await this.host.deliver(
          workspaces,
          owner,
          nodeName ? { ...resource, label: `${resource.label} on ${nodeName}` } : resource,
          nodeName ? this.host.statusOnNode(status, owner.nodeId!, nodeName) : status,
        );
        // No main coordinator to tell yet: keep the reading, and the sweep tries again.
        if (delivered) ended = end(outcome.key, true);
      }
    }
    const next: CoordinatorWorkerOutcome = { ...seen, ...(ended ? { ended } : {}) };
    if (JSON.stringify(next) === JSON.stringify(watch)) return;
    mutations.push({
      associationId: owner.id,
      mutate: (current) => {
        if (current.workerOutcome?.ended) return false;
        // A newer capture owns the whole snapshot, not just its timestamp.
        if (current.workerOutcome?.deletedAt !== watch.deletedAt) return false;
        current.workerOutcome = next;
        return true;
      },
    });
  }
}

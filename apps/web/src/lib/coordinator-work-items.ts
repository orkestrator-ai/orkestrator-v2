/**
 * The Coordinator Work panel's rows: everything one coordinator started, what
 * stage each piece is at, and what needs the user.
 *
 * A pure projection. The coordinator snapshot's workflow associations say what
 * the coordinator started (every conversation, every node); the renderer's
 * existing backend mirrors (environments, build pipelines, Multi Reviews,
 * graph runs, the PR monitor, the project's tickets) and the command node's
 * summaries of other machines say where each piece is now. Nothing here is
 * persisted, and nothing reads the coordinator's conversation, so the rows
 * move while the coordinator is idle.
 */
import {
  acceptanceCriteriaTally,
  type AcceptanceCriterion,
} from "@orkestrator/protocol/ticket-sections";
import { pipelineCriteriaView } from "@orkestrator/protocol/build-pipeline-criteria";
import {
  isActiveBuildPhase,
  isCancelledBuildPipeline,
  type BuildPhase,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import {
  coordinatorDelegationBucket,
  pullRequestStateFromNotice,
  type CoordinatorDelegation,
  type CoordinatorWorkBucket,
  type CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";
import { coordinatorTabLaunchRequest } from "@orkestrator/protocol/coordinator-launch-overrides";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { MultiReviewPhase, MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { NodeEnvironmentSummary, NodeSummary } from "@orkestrator/protocol/node-summaries";
import type { PrCheckSummary, PrState } from "@orkestrator/protocol/pr-monitor";

/** Finished work stays listed this long after it finishes (or while its PR is open). */
export const FINISHED_WORK_RETENTION_MS = 24 * 60 * 60 * 1000;

export type CoordinatorWorkKind = "worker" | "build" | "review" | "graph-run" | "pull-request";
export type { CoordinatorWorkBucket };
/** Display order: what waits on the user, then running work, then finished work. */
export const COORDINATOR_WORK_BUCKETS: readonly CoordinatorWorkBucket[] = [
  "needs-you",
  "running",
  "finished",
];

export type LocalWorkTarget = Exclude<
  CoordinatorWorkTarget,
  { type: "remote" } | { type: "pull-request" }
>;

/** Where a row's Open button goes. */
export type CoordinatorWorkTarget =
  /** A worker environment on this machine, at the delegated tab when known. */
  | { type: "worker-tab"; projectId: string; environmentId: string; tabId?: string }
  /** A build pipeline's tab; the environment may not exist yet. */
  | { type: "build"; projectId: string; pipelineId: string; environmentId?: string }
  | { type: "review"; projectId: string; environmentId: string; workflowId: string }
  | { type: "graph-run"; projectId: string; environmentId: string; runId: string; title?: string }
  | { type: "pull-request"; url: string }
  /** Work on another node: its environment, through that node's workspace. */
  | {
      type: "remote";
      nodeId: string;
      projectId: string;
      environmentId: string;
      title: string;
      workTarget?: LocalWorkTarget;
    };

export interface CoordinatorWorkItem {
  /** Stable row key. */
  key: string;
  /** The records behind this row, which "Clear finished" marks. */
  associationIds: string[];
  kind: CoordinatorWorkKind;
  bucket: CoordinatorWorkBucket;
  name: string;
  /** The machine's name, for work on another node. */
  machine?: string;
  /** The current stage in words; never only a colour. */
  stage: string;
  /** Builds: acceptance criteria passed out of the total. */
  criteria?: { passed: number; total: number };
  /** One line on what was asked (worker rows); absent on records older than the field. */
  summary?: string;
  /** What it runs on, where the record or the pipeline knows. */
  agent?: AgentPlatform;
  model?: string;
  /** The coordinator overrode the saved default for this launch. */
  overridden?: boolean;
  /** How long it has run, or how long ago it finished, in words. */
  age?: string;
  /** The running turns Stop would end (worker rows); absent when there is nothing to stop. */
  stop?: CoordinatorWorkStop;
  /** Null when there is nothing to go to (deleted, or not readable from here). */
  target: CoordinatorWorkTarget | null;
  /** Why Open is unavailable, when `target` is null. */
  unavailableReason?: string;
  /** Running delegations this row's associations hold (worker rows). */
  openDelegations: number;
  /** When the work reached a terminal state (ms), for expiry and ordering. */
  finishedAt?: number;
  /** Its pull request is open, which keeps finished work listed. */
  prOpen: boolean;
  /** Ordering within a bucket: newest first. */
  sortAt: number;
}

/** The worker tabs a row's Stop action covers, on this machine or `nodeId`. */
export interface CoordinatorWorkStop {
  environmentId: string;
  tabIds: string[];
  nodeId?: string;
}

/** The smallest slice of a renderer environment record the projection reads. */
export interface WorkEnvironment {
  id: string;
  projectId: string;
  name: string;
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts?: boolean | null;
  agentActivityState?: "idle" | "working" | "waiting";
}

export interface WorkPrReading {
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  checkSummary: PrCheckSummary | null;
}

export interface WorkTicket {
  id: string;
  sections?: { acceptanceCriteria?: AcceptanceCriterion[] };
}

export interface CoordinatorWorkSources {
  coordinatorId: string;
  workflows: readonly CoordinatorWorkflowAssociation[];
  environments: ReadonlyMap<string, WorkEnvironment>;
  pipelines: ReadonlyMap<string, BuildPipeline>;
  reviews: ReadonlyMap<string, MultiReviewWorkflow>;
  graphRuns: ReadonlyMap<string, GraphRun>;
  /** The PR monitor's last reading, by environment. */
  prReadings: ReadonlyMap<string, WorkPrReading>;
  /** The coordinator project's tickets, when loaded. */
  tickets: ReadonlyMap<string, WorkTicket>;
  nodes: readonly Pick<NodeSummary, "nodeId" | "view" | "environments">[];
  /** Builds and Multi Reviews on other nodes, keyed by {@link remoteWorkKey}. */
  remotePipelines: ReadonlyMap<string, BuildPipeline>;
  remoteReviews: ReadonlyMap<string, MultiReviewWorkflow>;
  /** Graph runs on other nodes, keyed by {@link remoteWorkKey}. */
  remoteGraphRuns: ReadonlyMap<string, GraphRun>;
  /**
   * Environments with a question, approval or input waiting on the user: by id
   * on this machine, by {@link remoteWorkKey} on another node.
   */
  promptEnvironmentIds: ReadonlySet<string>;
  /**
   * Successful reads that confirmed a resource no longer exists:
   * `<kind>:<id>` locally, `graph-run:<remoteWorkKey>` on another node.
   */
  missingResources?: ReadonlySet<string>;
  now: number;
}

export function remoteWorkKey(nodeId: string, resourceId: string): string {
  return `${nodeId}\u0000${resourceId}`;
}

const KNOWN_KINDS = new Set<CoordinatorWorkflowAssociation["kind"]>([
  "environment",
  "build-pipeline",
  "multi-review",
  "graph-run",
  "pull-request",
]);

/** The associations the Work panel lists: this coordinator's, materialized, of a kind it shows. */
export function coordinatorWorkAssociations(
  workflows: readonly CoordinatorWorkflowAssociation[],
  coordinatorId: string,
): CoordinatorWorkflowAssociation[] {
  // An older or newer backend may write kinds this client does not know; skip them.
  return workflows.filter(
    (association) =>
      association.coordinatorId === coordinatorId &&
      !association.pending &&
      KNOWN_KINDS.has(association.kind),
  );
}

const BUILD_PHASE_WORDS: Record<BuildPhase, string> = {
  "creating-environment": "Setup",
  "starting-environment": "Setup",
  "waiting-for-setup": "Setup",
  building: "Build",
  reviewing: "Review",
  addressing: "Address Findings",
  verifying: "Verify",
  fixing: "Rework",
  "creating-pr": "Create PR",
  "resolving-conflicts": "Resolve conflicts",
  paused: "Paused",
  complete: "Complete",
  failed: "Failed",
};

const REVIEW_PHASE_WORDS: Record<MultiReviewPhase, string> = {
  preparing: "preparing",
  reviewing: "reviewing",
  consolidating: "consolidating findings",
  ready: "findings ready",
  fixing: "fixing",
  interactive: "handed to chat",
  paused: "paused",
  completed: "complete",
  cancelling: "cancelling",
  cancelled: "cancelled",
  failed: "failed",
};

const MAX_ERROR_WORDS = 80;

function failedStage(error: string | undefined): string {
  const text = error?.trim().replace(/\s+/g, " ");
  if (!text) return "Failed";
  return `Failed: ${text.length > MAX_ERROR_WORDS ? `${text.slice(0, MAX_ERROR_WORDS - 1)}…` : text}`;
}

function time(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function latest(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

interface NodeLookup {
  machine: string;
  environment?: NodeEnvironmentSummary;
}

function nodeLookup(
  sources: CoordinatorWorkSources,
  nodeId: string,
  environmentId?: string,
): NodeLookup {
  const node = sources.nodes.find((item) => item.nodeId === nodeId);
  return {
    machine: node?.view.displayName ?? nodeId,
    environment: environmentId
      ? node?.environments.find((item) => item.ref.environmentId === environmentId)
      : undefined,
  };
}

function remoteTarget(
  nodeId: string,
  environment: { projectId: string; environmentId: string } | undefined,
  title: string,
  workTarget?: LocalWorkTarget,
): CoordinatorWorkTarget | null {
  return environment
    ? {
        type: "remote",
        nodeId,
        projectId: environment.projectId,
        environmentId: environment.environmentId,
        title,
        ...(workTarget
          ? {
              workTarget: {
                ...workTarget,
                projectId: environment.projectId,
                environmentId: environment.environmentId,
              },
            }
          : {}),
      }
    : null;
}

function prReadingFor(
  sources: CoordinatorWorkSources,
  environmentId: string | undefined,
): WorkPrReading | undefined {
  if (!environmentId) return undefined;
  const monitor = sources.prReadings.get(environmentId);
  if (monitor?.prState) return monitor;
  const environment = sources.environments.get(environmentId);
  if (environment?.prState) {
    return {
      prUrl: environment.prUrl,
      prState: environment.prState,
      hasMergeConflicts: environment.hasMergeConflicts ?? null,
      checkSummary: monitor?.prUrl === environment.prUrl ? (monitor?.checkSummary ?? null) : null,
    };
  }
  return monitor;
}

/** "PR open · checks pending", "PR merged", … */
export function pullRequestStage(reading: {
  prState: PrState | null;
  hasMergeConflicts?: boolean | null;
  checkSummary?: PrCheckSummary | null;
}): string {
  if (reading.prState === "merged") return "PR merged";
  if (reading.prState === "closed") return "PR closed";
  if (reading.prState !== "open") return "PR not opened yet";
  if (reading.hasMergeConflicts) return "PR open · merge conflicts";
  const checks = reading.checkSummary;
  if (!checks || checks.total === 0) return "PR open";
  if (checks.pending > 0) return "PR open · checks pending";
  const failing = checks.total - checks.passed;
  if (failing > 0) return `PR open · ${plural(failing, "check")} failing`;
  return "PR open · checks passed";
}

function outcomePrOpen(association: CoordinatorWorkflowAssociation): boolean {
  const outcome = association.workerOutcome;
  return outcome?.prState === "open" && !outcome.ended;
}

/** Criteria passed out of the total, from the linked ticket when it holds them, else the pipeline. */
export function buildCriteria(
  pipeline: BuildPipeline,
  tickets: ReadonlyMap<string, WorkTicket>,
): { passed: number; total: number } | undefined {
  const taskId = pipeline.source?.type === "kanban" ? pipeline.source.taskId : undefined;
  const ticketCriteria = taskId ? tickets.get(taskId)?.sections?.acceptanceCriteria : undefined;
  const criteria = ticketCriteria?.length
    ? ticketCriteria
    : pipeline.taskSnapshot
      ? pipelineCriteriaView(pipeline).criteria
      : [];
  if (criteria.length === 0) return undefined;
  return { passed: acceptanceCriteriaTally(criteria).passed, total: criteria.length };
}

function workerItem(
  associations: CoordinatorWorkflowAssociation[],
  sources: CoordinatorWorkSources,
): CoordinatorWorkItem {
  const live = associations.filter((association) => !association.nodeRelease);
  if (live.length && live.length !== associations.length) return workerItem(live, sources);
  const first = associations[0]!;
  const environmentId = first.resourceId;
  const delegations = associations
    .map((association) => association.delegation)
    .filter((delegation) => delegation !== undefined)
    .sort((a, b) => (time(a.requestedAt) ?? 0) - (time(b.requestedAt) ?? 0));
  const running = delegations.filter(
    (delegation) => coordinatorDelegationBucket(delegation) !== "finished",
  );
  const latestDelegation = delegations.at(-1);
  const outcome = associations.find((association) => association.workerOutcome)?.workerOutcome;
  // Its machine was forgotten or handed over: nothing about it can be read from here.
  const release = associations.find((association) => association.nodeRelease)?.nodeRelease;
  const createdAt = Math.min(
    ...associations.map((association) => time(association.createdAt) ?? 0),
  );
  const remote = first.nodeId ? nodeLookup(sources, first.nodeId, environmentId) : undefined;
  const local = first.nodeId ? undefined : sources.environments.get(environmentId);
  const name =
    local?.name ?? remote?.environment?.name ?? outcome?.name ?? `Worker ${environmentId}`;
  const activity = local?.agentActivityState ?? remote?.environment?.activity;
  const deleted =
    Boolean(outcome?.deletedAt || outcome?.ended?.key === "deleted") ||
    (!first.nodeId && !local && Boolean(outcome?.ended)) ||
    Boolean(remote?.environment?.deleting);
  const needsYou =
    !deleted &&
    (running.some((delegation) => coordinatorDelegationBucket(delegation) === "needs-you") ||
      sources.promptEnvironmentIds.has(
        first.nodeId ? remoteWorkKey(first.nodeId, environmentId) : environmentId,
      ) ||
      activity === "waiting");

  let bucket: CoordinatorWorkBucket;
  let stage: string;
  if (deleted) {
    bucket = "finished";
    stage = "Environment deleted";
  } else if (release) {
    bucket = "finished";
    stage =
      release.reason === "handed-over" ? "Worker · handed over" : "Worker · machine forgotten";
  } else if (needsYou) {
    bucket = "needs-you";
    stage = "Worker · waiting for you";
  } else if (running.length > 0) {
    bucket = "running";
    stage = running.some((delegation) => delegation.stopRequestedAt)
      ? "Worker · stopping"
      : activity === "working"
        ? "Worker · working"
        : "Worker · running";
  } else if (activity === "working") {
    bucket = "running";
    stage = "Worker · working";
  } else {
    bucket = "finished";
    stage =
      latestDelegation?.state === "failed"
        ? "Worker · failed"
        : latestDelegation?.state === "stopped"
          ? "Worker · stopped"
          : latestDelegation
            ? "Worker · finished"
            : "Worker · idle";
  }
  const pr = first.nodeId
    ? remote?.environment?.prState
      ? {
          prState: remote.environment.prState,
          hasMergeConflicts: remote.environment.prHasMergeConflicts ?? null,
          checkSummary: remote.environment.prCheckSummary ?? null,
        }
      : undefined
    : prReadingFor(sources, environmentId);
  if (!deleted && pr?.prState) stage += ` · ${pullRequestStage(pr)}`;
  const prOpen = pr?.prState === "open" || associations.some(outcomePrOpen);
  const finishedAt =
    bucket === "finished"
      ? (latest(
          ...delegations.map((delegation) => time(delegation.completedAt)),
          time(release?.at),
          time(outcome?.ended?.at),
          time(outcome?.deletedAt),
        ) ?? createdAt)
      : undefined;

  let target: CoordinatorWorkTarget | null = null;
  let unavailableReason: string | undefined;
  if (deleted) unavailableReason = "The environment was deleted.";
  else if (release) unavailableReason = "Its machine is no longer controlled here.";
  else if (first.nodeId) {
    target = remoteTarget(
      first.nodeId,
      remote?.environment ? { projectId: remote.environment.projectId, environmentId } : undefined,
      name,
      {
        type: "worker-tab",
        projectId: remote?.environment?.projectId ?? first.projectId,
        environmentId,
        tabId: latestDelegation?.workerTabId,
      },
    );
    if (!target) unavailableReason = `${remote?.machine ?? first.nodeId} has not listed it yet.`;
  } else if (local) {
    target = {
      type: "worker-tab",
      projectId: local.projectId,
      environmentId,
      ...(latestDelegation ? { tabId: latestDelegation.workerTabId } : {}),
    };
  } else unavailableReason = "The environment is not loaded.";

  const summary = latestDelegation?.request?.summary;
  const selection = selectionOf(delegations);
  // A tab already told to stop has nothing more to ask of it.
  const stoppable =
    deleted || release
      ? []
      : Array.from(
          new Set(
            running
              .filter((delegation) => !delegation.stopRequestedAt)
              .map((delegation) => delegation.workerTabId),
          ),
        );
  return {
    key: `worker:${first.nodeId ?? ""}:${environmentId}`,
    associationIds: associations.map((association) => association.id),
    kind: "worker",
    bucket,
    name,
    ...(remote ? { machine: remote.machine } : {}),
    stage,
    ...(summary ? { summary } : {}),
    ...(selection?.agent ? { agent: selection.agent } : {}),
    ...(selection?.model ? { model: selection.model } : {}),
    ...(launchOverridden(delegations) ? { overridden: true } : {}),
    ...(stoppable.length > 0
      ? {
          stop: {
            environmentId,
            tabIds: stoppable,
            ...(first.nodeId ? { nodeId: first.nodeId } : {}),
          },
        }
      : {}),
    target,
    ...(unavailableReason ? { unavailableReason } : {}),
    openDelegations: running.length,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    prOpen,
    sortAt: finishedAt ?? latest(...delegations.map((d) => time(d.requestedAt))) ?? createdAt,
  };
}

/** The latest tab's launch, by the same rule its marker on the tab uses. */
function launchOverridden(delegations: readonly CoordinatorDelegation[]): boolean {
  const latestTab = delegations.at(-1)?.workerTabId;
  return (
    coordinatorTabLaunchRequest(delegations.filter((item) => item.workerTabId === latestTab))
      ?.source === "requested"
  );
}

/** Never carry a selection across tabs, agents, or an explicit model reset. */
function selectionOf(delegations: readonly CoordinatorDelegation[]) {
  const latestTab = delegations.at(-1)?.workerTabId;
  const newest = delegations.toReversed().filter((item) => item.workerTabId === latestTab);
  const selected = newest.find((item) => item.request?.agent || item.request?.model !== undefined);
  if (!selected?.request) return undefined;
  if (selected.request.model !== undefined) return selected.request;
  const previous = newest.find(
    (item) =>
      item.workerTabId === selected.workerTabId &&
      item.request?.agent === selected.request?.agent &&
      item.request?.model !== undefined,
  );
  return previous?.request ? { ...previous.request, ...selected.request } : selected.request;
}

function missingItem(
  base: Pick<CoordinatorWorkItem, "key" | "associationIds" | "kind" | "name" | "openDelegations">,
  createdAt: number,
): CoordinatorWorkItem {
  return {
    ...base,
    bucket: "finished",
    stage: "Work no longer available",
    target: null,
    unavailableReason: "The underlying record no longer exists.",
    finishedAt: createdAt,
    sortAt: createdAt,
    prOpen: false,
  };
}

function environmentPrOpen(
  sources: CoordinatorWorkSources,
  association: CoordinatorWorkflowAssociation,
  environmentId?: string,
): boolean {
  const prState = association.nodeId
    ? nodeLookup(sources, association.nodeId, environmentId).environment?.prState
    : prReadingFor(sources, environmentId)?.prState;
  return prState === "open" || outcomePrOpen(association);
}

function releasedItem(
  association: CoordinatorWorkflowAssociation,
  sources: CoordinatorWorkSources,
  kind: CoordinatorWorkKind,
): CoordinatorWorkItem {
  const finishedAt = time(association.nodeRelease!.at) ?? time(association.createdAt) ?? 0;
  return {
    key: `${kind}:${association.nodeId ?? ""}:${association.resourceId}`,
    associationIds: [association.id],
    kind,
    bucket: "finished",
    name: `${kind === "build" ? "Build" : kind === "review" ? "Review" : "Graph run"} ${association.resourceId}`,
    machine: association.nodeId ? nodeLookup(sources, association.nodeId).machine : undefined,
    stage:
      association.nodeRelease!.reason === "handed-over"
        ? "Machine handed over"
        : "Machine forgotten",
    target: null,
    unavailableReason: "Its machine is no longer controlled here.",
    openDelegations: 0,
    finishedAt,
    prOpen: false,
    sortAt: finishedAt,
  };
}

function buildItem(
  association: CoordinatorWorkflowAssociation,
  sources: CoordinatorWorkSources,
): CoordinatorWorkItem {
  if (association.nodeRelease) return releasedItem(association, sources, "build");
  const nodeId = association.nodeId;
  const pipeline = nodeId
    ? sources.remotePipelines.get(remoteWorkKey(nodeId, association.resourceId))
    : sources.pipelines.get(association.resourceId);
  const remote = nodeId ? nodeLookup(sources, nodeId, pipeline?.environmentId) : undefined;
  const createdAt = time(association.createdAt) ?? 0;
  const name = pipeline?.taskTitle || association.workerOutcome?.name || "Build";
  const base = {
    key: `build:${nodeId ?? ""}:${association.resourceId}`,
    associationIds: [association.id],
    kind: "build" as const,
    name,
    ...(remote ? { machine: remote.machine } : {}),
    openDelegations: 0,
  };
  if (!pipeline) {
    if (
      sources.missingResources?.has(
        `build-pipeline:${nodeId ? remoteWorkKey(nodeId, association.resourceId) : association.resourceId}`,
      )
    )
      return missingItem(base, createdAt);
    const target: CoordinatorWorkTarget | null = nodeId
      ? null
      : { type: "build", projectId: association.projectId, pipelineId: association.resourceId };
    return {
      ...base,
      bucket: "running",
      stage: nodeId ? "Build · stage not readable from here" : "Build · loading",
      target,
      ...(target ? {} : { unavailableReason: `${remote?.machine ?? nodeId} is not answering.` }),
      prOpen: outcomePrOpen(association),
      sortAt: createdAt,
    };
  }
  const environmentId = pipeline.environmentId || undefined;
  const pr = nodeId
    ? remote?.environment?.prState
      ? {
          prState: remote.environment.prState,
          hasMergeConflicts: remote.environment.prHasMergeConflicts ?? null,
          checkSummary: remote.environment.prCheckSummary ?? null,
        }
      : undefined
    : prReadingFor(sources, environmentId);
  const prOpen = pr?.prState === "open" || outcomePrOpen(association);
  const cancelled = isCancelledBuildPipeline(pipeline);
  const promptWaiting = nodeId
    ? remote?.environment?.activity === "waiting"
    : environmentId !== undefined && sources.promptEnvironmentIds.has(environmentId);

  let bucket: CoordinatorWorkBucket;
  let stage: string;
  if (pipeline.phase === "paused") {
    bucket = "needs-you";
    stage = pipeline.pausedFromPhase
      ? `Build paused · ${BUILD_PHASE_WORDS[pipeline.pausedFromPhase]}`
      : "Build paused";
  } else if (pipeline.phase === "failed") {
    bucket = cancelled ? "finished" : "needs-you";
    stage = cancelled ? "Build cancelled" : failedStage(pipeline.error);
  } else if (pipeline.phase === "complete") {
    bucket = "finished";
    stage = "Build complete";
  } else {
    bucket = promptWaiting ? "needs-you" : "running";
    stage = `Build · ${BUILD_PHASE_WORDS[pipeline.phase]}`;
    if (promptWaiting) stage += " · waiting for you";
    else if (pipeline.stallWarning) stage += " · stalled";
  }
  if (pr?.prState && (bucket === "finished" || pipeline.phase === "resolving-conflicts")) {
    stage += ` · ${pullRequestStage(pr)}`;
  }
  const terminal = !isActiveBuildPhase(pipeline.phase) && pipeline.phase !== "paused";
  const finishedAt = terminal
    ? (latest(
        time(pipeline.cancelledAt),
        ...pipeline.sessions.map((session) => time(session.completedAt)),
        time(pipeline.delivery?.decidedAt),
      ) ?? createdAt)
    : undefined;
  const criteria = buildCriteria(pipeline, nodeId ? new Map() : sources.tickets);
  const target: CoordinatorWorkTarget | null = nodeId
    ? remoteTarget(
        nodeId,
        environmentId ? { projectId: pipeline.projectId, environmentId } : undefined,
        name,
        { type: "build", projectId: pipeline.projectId, pipelineId: pipeline.id, environmentId },
      )
    : {
        type: "build",
        projectId: pipeline.projectId,
        pipelineId: pipeline.id,
        ...(environmentId ? { environmentId } : {}),
      };
  return {
    ...base,
    bucket,
    stage,
    ...(criteria ? { criteria } : {}),
    ...(isAgentPlatform(pipeline.agentType) ? { agent: pipeline.agentType } : {}),
    target,
    ...(target ? {} : { unavailableReason: "Its environment is still being created." }),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    prOpen,
    sortAt: finishedAt ?? createdAt,
  };
}

const REVIEW_FINISHED = new Set<MultiReviewPhase>(["interactive", "completed", "cancelled"]);

function reviewItem(
  association: CoordinatorWorkflowAssociation,
  sources: CoordinatorWorkSources,
): CoordinatorWorkItem {
  if (association.nodeRelease) return releasedItem(association, sources, "review");
  const nodeId = association.nodeId;
  const workflow = nodeId
    ? sources.remoteReviews.get(remoteWorkKey(nodeId, association.resourceId))
    : sources.reviews.get(association.resourceId);
  const remote = nodeId ? nodeLookup(sources, nodeId, workflow?.environmentId) : undefined;
  const createdAt = time(association.createdAt) ?? 0;
  const reviewedName = workflow
    ? nodeId
      ? remote?.environment?.name
      : sources.environments.get(workflow.environmentId)?.name
    : undefined;
  const name = reviewedName ? `Multi Review of ${reviewedName}` : "Multi Review";
  const base = {
    key: `review:${nodeId ?? ""}:${association.resourceId}`,
    associationIds: [association.id],
    kind: "review" as const,
    name,
    ...(remote ? { machine: remote.machine } : {}),
    openDelegations: 0,
    prOpen: false,
  };
  if (!workflow) {
    if (
      sources.missingResources?.has(
        `multi-review:${nodeId ? remoteWorkKey(nodeId, association.resourceId) : association.resourceId}`,
      )
    )
      return missingItem(base, createdAt);
    return {
      ...base,
      bucket: "running",
      stage: nodeId ? "Review · stage not readable from here" : "Review · loading",
      target: null,
      unavailableReason: nodeId
        ? `${remote?.machine ?? nodeId} is not answering.`
        : "The review is not loaded yet.",
      sortAt: createdAt,
    };
  }
  let bucket: CoordinatorWorkBucket;
  let stage: string;
  if (workflow.phase === "failed") {
    bucket = "needs-you";
    stage = failedStage(workflow.error);
  } else if (workflow.phase === "paused") {
    bucket = "needs-you";
    stage = "Review paused";
  } else if (workflow.phase === "ready") {
    const findings = Boolean(
      workflow.consolidatedReport?.issues.length ||
      workflow.consolidatedReport?.testCoverageGaps?.length,
    );
    const delivery = workflow.autoPrLaunch?.state;
    bucket =
      findings || delivery === "failed"
        ? "needs-you"
        : delivery === "pending"
          ? "running"
          : "finished";
    stage = findings
      ? "Review ready · findings need your decision"
      : delivery === "pending"
        ? "Review complete · opening PR"
        : delivery === "failed"
          ? "Review complete · PR launch failed"
          : "Review complete";
  } else if (REVIEW_FINISHED.has(workflow.phase)) {
    bucket = "finished";
    stage = `Review ${REVIEW_PHASE_WORDS[workflow.phase]}`;
  } else {
    const waiting = nodeId
      ? remote?.environment?.activity === "waiting"
      : sources.promptEnvironmentIds.has(workflow.environmentId);
    bucket = waiting ? "needs-you" : "running";
    stage =
      workflow.phase === "reviewing"
        ? `Review · ${plural(workflow.reviewers.length, "reviewer")}`
        : `Review · ${REVIEW_PHASE_WORDS[workflow.phase]}`;
    if (waiting) stage += " · waiting for you";
  }
  const terminal =
    REVIEW_FINISHED.has(workflow.phase) ||
    workflow.phase === "failed" ||
    (workflow.phase === "ready" && bucket === "finished");
  const finishedAt = terminal ? (time(workflow.updatedAt) ?? createdAt) : undefined;
  const target: CoordinatorWorkTarget | null = nodeId
    ? remoteTarget(
        nodeId,
        {
          projectId: remote?.environment?.projectId ?? workflow.projectId,
          environmentId: workflow.environmentId,
        },
        name,
        {
          type: "review",
          projectId: workflow.projectId,
          environmentId: workflow.environmentId,
          workflowId: workflow.id,
        },
      )
    : {
        type: "review",
        projectId: workflow.projectId,
        environmentId: workflow.environmentId,
        workflowId: workflow.id,
      };
  return {
    ...base,
    prOpen: environmentPrOpen(sources, association, workflow.environmentId),
    bucket,
    stage,
    target,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    sortAt: finishedAt ?? createdAt,
  };
}

function graphRunItem(
  association: CoordinatorWorkflowAssociation,
  sources: CoordinatorWorkSources,
): CoordinatorWorkItem {
  if (association.nodeRelease) return releasedItem(association, sources, "graph-run");
  const nodeId = association.nodeId;
  const createdAt = time(association.createdAt) ?? 0;
  const run = nodeId
    ? sources.remoteGraphRuns.get(remoteWorkKey(nodeId, association.resourceId))
    : sources.graphRuns.get(association.resourceId);
  const remote = nodeId ? nodeLookup(sources, nodeId, run?.environmentId ?? undefined) : undefined;
  const base = {
    key: `graph-run:${nodeId ?? ""}:${association.resourceId}`,
    associationIds: [association.id],
    kind: "graph-run" as const,
    ...(remote ? { machine: remote.machine } : {}),
    openDelegations: 0,
    prOpen: false,
  };
  if (!run) {
    const missingKey = nodeId
      ? `graph-run:${remoteWorkKey(nodeId, association.resourceId)}`
      : `graph-run:${association.resourceId}`;
    if (sources.missingResources?.has(missingKey))
      return missingItem({ ...base, name: "Graph run" }, createdAt);
    return {
      ...base,
      name: "Graph run",
      bucket: "running",
      stage: "Graph run · loading",
      target: null,
      unavailableReason: nodeId
        ? `Reading the run from ${remote?.machine ?? nodeId}.`
        : "The run is not loaded yet.",
      sortAt: createdAt,
    };
  }
  const name = run.plan?.template?.name || "Graph run";
  let bucket: CoordinatorWorkBucket;
  let stage: string;
  switch (run.status) {
    case "waiting":
      bucket = "needs-you";
      stage = "Graph run · waiting for you";
      break;
    case "paused":
      bucket = "needs-you";
      stage = "Graph run paused";
      break;
    case "failed":
      bucket = "needs-you";
      stage = failedStage(run.error);
      break;
    case "complete":
      bucket = "finished";
      stage = "Graph run complete";
      break;
    case "cancelled":
      bucket = "finished";
      stage = "Graph run cancelled";
      break;
    case "cancelling":
      bucket = "running";
      stage = "Graph run · cancelling";
      break;
    case "provisioning":
      bucket = "running";
      stage = "Graph run · preparing";
      break;
    default:
      bucket = "running";
      stage = "Graph run · running";
  }
  const terminal =
    run.status === "complete" || run.status === "cancelled" || run.status === "failed";
  const finishedAt = terminal
    ? (time(run.finishedAt) ?? time(run.updatedAt) ?? createdAt)
    : undefined;
  const target: CoordinatorWorkTarget | null = !run.environmentId
    ? null
    : nodeId
      ? remoteTarget(
          nodeId,
          {
            projectId: remote?.environment?.projectId ?? run.projectId,
            environmentId: run.environmentId,
          },
          name,
          {
            type: "graph-run",
            projectId: run.projectId,
            environmentId: run.environmentId,
            runId: run.id,
            title: name,
          },
        )
      : {
          type: "graph-run",
          projectId: run.projectId,
          environmentId: run.environmentId,
          runId: run.id,
          title: name,
        };
  return {
    ...base,
    prOpen: environmentPrOpen(sources, association, run.environmentId ?? undefined),
    name,
    bucket,
    stage,
    target,
    ...(target ? {} : { unavailableReason: "Its environment is still being created." }),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    sortAt: finishedAt ?? createdAt,
  };
}

function prNumber(url: string | null | undefined): string | undefined {
  return url?.match(/\/pull\/(\d+)/)?.[1];
}

function pullRequestItem(
  associations: CoordinatorWorkflowAssociation[],
  sources: CoordinatorWorkSources,
): CoordinatorWorkItem {
  const first = associations[0]!;
  const nodeId = first.nodeId;
  const environmentId = first.resourceId;
  const follow =
    associations.map((association) => association.pullRequest).find((item) => item?.prUrl) ??
    first.pullRequest;
  const final = associations
    .map((a) => a.pullRequest?.final)
    .filter((item) => item !== undefined)
    .sort((a, b) => (time(b.at) ?? 0) - (time(a.at) ?? 0))[0];
  const remote = nodeId ? nodeLookup(sources, nodeId, environmentId) : undefined;
  const local = nodeId ? undefined : sources.environments.get(environmentId);
  const currentReading = nodeId
    ? remote?.environment?.prState
      ? {
          prUrl: null,
          prState: remote.environment.prState,
          hasMergeConflicts: remote.environment.prHasMergeConflicts ?? null,
          checkSummary: remote.environment.prCheckSummary ?? null,
        }
      : undefined
    : prReadingFor(sources, environmentId);
  const url = follow?.prUrl ?? final?.prUrl ?? currentReading?.prUrl ?? local?.prUrl ?? null;
  const reading = currentReading?.prUrl === url ? currentReading : undefined;
  // A new follow supersedes the previous episode, including when it has
  // not observed a state yet. Later notices and deletion readings then win
  // by observation time, independently of association store order.
  const evidence = associations.flatMap((association) => {
    const notice = pullRequestStateFromNotice(association.statusNotice?.key);
    const captured = association.pullRequest?.final;
    return [
      { at: time(association.createdAt) ?? 0, state: null, priority: 0 },
      ...(notice
        ? [{ at: time(association.statusNotice?.notifiedAt) ?? 0, state: notice, priority: 1 }]
        : []),
      ...(captured?.prUrl === url && captured.prState !== null
        ? [{ at: time(captured.at) ?? 0, state: captured.prState, priority: 2 }]
        : []),
    ];
  });
  const recorded = evidence.sort((a, b) => b.at - a.at || b.priority - a.priority)[0]?.state;
  const followEnded = associations.every((association) => association.terminalNotifiedAt);
  // Nothing watches an ended follow, so its last "open" may be long out of date.
  const prState =
    reading?.prState ?? (followEnded && recorded === "open" ? null : recorded) ?? null;
  const noLongerFollowed = followEnded && !prState;
  const environmentName =
    local?.name ?? remote?.environment?.name ?? final?.name ?? first.workerOutcome?.name;
  const number = prNumber(url);
  const name = `${number ? `PR #${number}` : "Pull request"}${environmentName ? ` · ${environmentName}` : ""}`;
  const createdAt = Math.min(
    ...associations.map((association) => time(association.createdAt) ?? 0),
  );
  const stage = pullRequestStage({
    prState,
    hasMergeConflicts: reading?.hasMergeConflicts ?? null,
    checkSummary: reading?.checkSummary ?? null,
  });
  const finished = prState === "merged" || prState === "closed" || noLongerFollowed;
  // Deletion observes the outcome; it does not finish an already-ended
  // follow again. Only use that observation time when no end was recorded.
  const finishedAt = finished
    ? (latest(
        ...associations.map((association) =>
          pullRequestStateFromNotice(association.statusNotice?.key)
            ? time(association.statusNotice?.notifiedAt)
            : undefined,
        ),
        ...associations.map((association) => time(association.terminalNotifiedAt)),
      ) ??
      time(final?.at) ??
      createdAt)
    : undefined;
  return {
    key: `pull-request:${nodeId ?? ""}:${environmentId}:${url ?? first.id}`,
    associationIds: associations.map((association) => association.id),
    kind: "pull-request",
    bucket: finished ? "finished" : "running",
    name,
    ...(remote ? { machine: remote.machine } : {}),
    stage: noLongerFollowed
      ? "PR · no longer followed"
      : url && !prState
        ? "PR · status unavailable"
        : url || prState
          ? stage
          : "PR · being opened",
    target: url ? { type: "pull-request", url } : null,
    ...(url
      ? {}
      : {
          unavailableReason: noLongerFollowed
            ? "No pull request was recorded."
            : "The pull request has not been opened yet.",
        }),
    openDelegations: 0,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    prOpen: prState === "open",
    sortAt: finishedAt ?? createdAt,
  };
}

/** "just now", "12m", "3h", "2d"; finished work reads "12m ago". */
export function workAge(sortAt: number, finished: boolean, now: number): string | undefined {
  if (sortAt <= 0) return undefined;
  const minutes = Math.floor(Math.max(0, now - sortAt) / 60_000);
  if (minutes < 1) return finished ? "just now" : "under 1m";
  const span =
    minutes < 60
      ? `${minutes}m`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / (24 * 60))}d`;
  return finished ? `${span} ago` : span;
}

/**
 * What the coordinator's next wake waits for, for a conversation whose Work
 * panel is folded away: one worker by name, several by count. Null when no
 * delegation is open, so an idle coordinator with nothing out says nothing.
 */
export function nextWakeLine(items: readonly CoordinatorWorkItem[]): string | null {
  const waitingOn = items.filter((item) => item.kind === "worker" && item.openDelegations > 0);
  const [first, ...others] = waitingOn;
  if (!first) return null;
  if (others.length === 0) return `Next wake when ${first.name} finishes`;
  const more = others.length === 1 ? "1 other" : `${others.length} others`;
  return `Next wake when ${first.name} or ${more} finish`;
}

/**
 * The target for one worker tab named by a notice or a waiting prompt, or null
 * when this client cannot reach it: an environment it does not know (deleted, or
 * on another node with no `nodeId` to say so), one being deleted, or a node that
 * is not connected.
 */
export function workerTabTarget(
  worker: { environmentId: string; tabId?: string; nodeId?: string; title: string },
  lookup: {
    environments: readonly (Pick<WorkEnvironment, "id" | "projectId"> & {
      deletionRequestedAt?: string;
    })[];
    nodes: readonly Pick<NodeSummary, "nodeId" | "available" | "environments">[];
  },
): CoordinatorWorkTarget | null {
  const { environmentId, tabId, nodeId, title } = worker;
  if (nodeId) {
    const node = lookup.nodes.find((item) => item.nodeId === nodeId);
    const environment = node?.available
      ? node.environments.find((item) => item.ref.environmentId === environmentId)
      : undefined;
    if (!environment || environment.deleting) return null;
    return remoteTarget(nodeId, { projectId: environment.projectId, environmentId }, title, {
      type: "worker-tab",
      projectId: environment.projectId,
      environmentId,
      ...(tabId ? { tabId } : {}),
    });
  }
  const environment = lookup.environments.find((item) => item.id === environmentId);
  if (!environment || environment.deletionRequestedAt) return null;
  return {
    type: "worker-tab",
    projectId: environment.projectId,
    environmentId,
    ...(tabId ? { tabId } : {}),
  };
}

/**
 * Finished work drops off 24 hours after it finishes, or once its pull
 * request is merged or closed, whichever is later.
 */
export function isWorkItemExpired(item: CoordinatorWorkItem, now: number): boolean {
  if (item.finishedAt === undefined || item.prOpen) return false;
  return now >= item.finishedAt + FINISHED_WORK_RETENTION_MS;
}

/** Finished rows "Clear finished" takes; work with an open pull request stays listed. */
export function isClearableWorkItem(item: CoordinatorWorkItem): boolean {
  return item.bucket === "finished" && !item.prOpen;
}

/** Every row the Work panel shows, ordered: needs you, running, finished; newest first in each. */
export function deriveCoordinatorWorkItems(sources: CoordinatorWorkSources): CoordinatorWorkItem[] {
  const associations = coordinatorWorkAssociations(sources.workflows, sources.coordinatorId);
  const hidden = new Set(
    associations
      .filter((association) => association.workHiddenAt)
      .map((association) => association.id),
  );
  // One row per worker environment and per followed PR, however many
  // delegations or follow records name it.
  const grouped = new Map<string, CoordinatorWorkflowAssociation[]>();
  const items: CoordinatorWorkItem[] = [];
  for (const association of associations) {
    if (association.kind === "environment" || association.kind === "pull-request") {
      const key = `${association.kind}\u0000${association.nodeId ?? ""}\u0000${association.resourceId}\u0000${association.kind === "pull-request" ? (association.pullRequest?.prUrl ?? association.pullRequest?.final?.prUrl ?? association.id) : ""}`;
      const group = grouped.get(key);
      if (group) group.push(association);
      else grouped.set(key, [association]);
      continue;
    }
    if (association.kind === "build-pipeline") items.push(buildItem(association, sources));
    else if (association.kind === "multi-review") items.push(reviewItem(association, sources));
    else if (association.kind === "graph-run") items.push(graphRunItem(association, sources));
  }
  for (const group of grouped.values()) {
    items.push(
      group[0]!.kind === "environment"
        ? workerItem(group, sources)
        : pullRequestItem(group, sources),
    );
  }
  const order = new Map(COORDINATOR_WORK_BUCKETS.map((bucket, index) => [bucket, index]));
  // A cleared row comes back if its work resumes or a later request names it.
  const cleared = (item: CoordinatorWorkItem) =>
    isClearableWorkItem(item) && item.associationIds.every((id) => hidden.has(id));
  return items
    .filter((item) => !isWorkItemExpired(item, sources.now) && !cleared(item))
    .map((item) => {
      const age = workAge(item.sortAt, item.finishedAt !== undefined, sources.now);
      return age ? { ...item, age } : item;
    })
    .sort(
      (a, b) =>
        order.get(a.bucket)! - order.get(b.bucket)! ||
        b.sortAt - a.sortAt ||
        a.key.localeCompare(b.key),
    );
}

export interface CoordinatorWorkCounts {
  running: number;
  needsYou: number;
  finished: number;
}

export function countCoordinatorWork(items: readonly CoordinatorWorkItem[]): CoordinatorWorkCounts {
  const counts = { running: 0, needsYou: 0, finished: 0 };
  for (const item of items) {
    if (item.bucket === "needs-you") counts.needsYou += 1;
    else if (item.bucket === "running") counts.running += 1;
    else counts.finished += 1;
  }
  return counts;
}

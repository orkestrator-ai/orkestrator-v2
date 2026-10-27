/**
 * The build pipeline as a flow graph: which nodes exist, what state each is
 * in, and the columns they sit in, left to right.
 *
 * Everything here is a pure reading of the pipeline record (plus, for the PR
 * node, the environment's pull request). Nothing about a node's state comes
 * from a transcript. Repeated passes never loop back: each new session is a
 * new node to the right, so the whole history stays on the line.
 *
 * - Steps the pipeline will definitely reach (Prepare, Review, Verify, Ship,
 *   the PR) are drawn ahead as faded placeholders.
 * - Steps that only sometimes happen (Address, Fix, conflict resolution, an
 *   extra pass) are never drawn ahead; they appear once they start.
 */

import {
  REVIEW_PACKAGE_SESSION_LABEL,
  isActiveBuildPhase,
  pipelineIndependentReviewSlot,
  pipelineReviewIssueCounts,
  pipelineReviewerConfigs,
  usesReviewFanout,
  type BuildPipeline,
  type BuildPipelineAgent,
  type BuildStepConfig,
  type PipelineReviewIssueCounts,
  type PipelineSession,
  type ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewerRecord } from "@orkestrator/protocol/review-fanout";
import type { PrCheckSummary } from "@orkestrator/protocol/pr-monitor";
import {
  flowEdgeState,
  latestActivityAt,
  type FlowEdgeState,
  type FlowNodeState,
} from "@/components/flow-graph/flow-graph-model";
import { reviewerFlowState } from "@/components/review/multi-review-flow";
import { pipelineStageItems, validationOutcome } from "./pipeline-stage-groups";

export type PipelineFlowNodeKind =
  | "ticket"
  | "setup"
  | "build"
  | "fix"
  | "prepare"
  | "reviewer"
  | "review"
  | "consolidation"
  | "address"
  | "verify"
  | "ship"
  | "conflicts"
  | "pr";

/** The column a kind sits in; reviewers of one pass share a column. */
export type PipelineFlowColumnKind = Exclude<PipelineFlowNodeKind, "reviewer">;

export interface PipelineFlowNode {
  /** Stable across snapshots: a session key, or a fixed id for derived nodes. */
  id: string;
  kind: PipelineFlowNodeKind;
  title: string;
  state: FlowNodeState;
  /** A definite future step, not started yet, drawn faded. */
  placeholder: boolean;
  /** The agent session behind the node, when it has one. */
  session?: PipelineSession;
  /** The live fan-out record of a reviewer in the current pass. */
  reviewer?: ReviewerRecord;
  /** Zero-based reviewer slot ("Reviewer 1" is slot 0). */
  slot?: number;
  /** Earlier attempts of this reviewer slot in the same pass. */
  earlierAttempts?: number;
  /** The review pass the node belongs to, for opening it on its own. */
  passKey?: string;
  /** The prepare node carries the latest validation run. */
  hasValidation?: boolean;
  agent?: BuildPipelineAgent;
  model?: string;
  reasoningEffort?: string;
  startedAt?: string;
  completedAt?: string;
  tokenCount?: number;
  issueCounts?: PipelineReviewIssueCounts;
  /** Why the node failed (or what stopped it), from the record. */
  error?: string;
  /** Activity time, for the default selection. */
  activityAt?: number;
}

export interface PipelineFlowColumn {
  key: string;
  kind: PipelineFlowColumnKind;
  /** The column's heading: "Build", "Review 2", "Verify"… */
  label: string;
  nodeIds: string[];
}

export interface PipelineFlowEdge {
  id: string;
  from: string;
  to: string;
  state: FlowEdgeState;
}

export interface PipelineFlowModel {
  nodes: PipelineFlowNode[];
  columns: PipelineFlowColumn[];
  edges: PipelineFlowEdge[];
}

/** The environment's pull request, as the PR monitor last saw it. */
export interface PipelinePullRequest {
  url: string;
  state: "open" | "merged" | "closed" | null;
  checks: PrCheckSummary | null;
}

// Prefixed so no session key can collide with them.
export const PIPELINE_TICKET_NODE_ID = "flow:ticket";
export const PIPELINE_SETUP_NODE_ID = "flow:setup";
export const PIPELINE_PR_NODE_ID = "flow:pr";

const SETUP_PHASES = new Set<string>([
  "creating-environment",
  "starting-environment",
  "waiting-for-setup",
]);

const KIND_TITLES: Record<PipelineFlowNodeKind, string> = {
  ticket: "Ticket",
  setup: "Setup",
  build: "Build",
  fix: "Fix",
  prepare: "Prepare",
  reviewer: "Reviewer",
  review: "Review",
  consolidation: "Consolidation",
  address: "Address",
  verify: "Verify",
  ship: "Ship",
  conflicts: "Resolve conflicts",
  pr: "PR",
};

/** The column heading for each kind; reviewers sit under "Review". */
const COLUMN_LABELS: Record<PipelineFlowColumnKind, string> = {
  ticket: "Ticket",
  setup: "Setup",
  build: "Build",
  fix: "Fix",
  prepare: "Prepare",
  review: "Review",
  consolidation: "Consolidate",
  address: "Address",
  verify: "Verify",
  ship: "Ship",
  conflicts: "Conflicts",
  pr: "PR",
};

const CONSOLIDATION_LABEL = "Consolidation";

/** The configured harness of a step that has not run yet, where the launch chose one. */
function placeholderStep(
  pipeline: BuildPipeline,
  kind: PipelineFlowColumnKind,
): BuildStepConfig | undefined {
  switch (kind) {
    case "build":
      return pipeline.steps?.build ?? { agent: pipeline.agentType };
    case "prepare":
    case "consolidation":
      return pipeline.reviewPreparation;
    case "review":
      return pipeline.steps?.review ?? { agent: pipeline.agentType };
    case "verify":
      return pipeline.steps?.verify ?? { agent: pipeline.agentType };
    case "ship":
      return pipeline.steps?.pr ?? { agent: pipeline.agentType };
    default:
      return undefined;
  }
}

function stepFields(
  config: BuildStepConfig | null | undefined,
): Pick<PipelineFlowNode, "agent" | "model" | "reasoningEffort"> {
  return config
    ? { agent: config.agent, model: config.model, reasoningEffort: config.reasoningEffort }
    : {};
}

/** What kind of step a session ran. */
export function pipelineSessionKind(session: PipelineSession): PipelineFlowNodeKind {
  if (session.label === REVIEW_PACKAGE_SESSION_LABEL) return "prepare";
  switch (session.phase) {
    case "build":
      return "build";
    case "fix":
      return "fix";
    case "review":
      if (session.label === CONSOLIDATION_LABEL) return "consolidation";
      return pipelineIndependentReviewSlot(session.label) !== null ? "reviewer" : "review";
    case "address":
      return "address";
    case "verify":
      return "verify";
    case "pr":
      return "ship";
    default:
      return "conflicts";
  }
}

const SKIP_LABELS: Partial<Record<PipelineFlowNodeKind, string>> = {
  build: "Skip to review",
  fix: "Skip to review",
  review: "Skip review",
  reviewer: "Skip review",
  consolidation: "Skip review",
  address: "Skip to verification",
  verify: "Skip verification",
};

/**
 * What skipping a node would do, if the node is the step the pipeline is on
 * and that step can be skipped: the stage id the backend checks it against,
 * and the action's label. Review preparation and the pull request cannot be.
 */
export function pipelineSkipAction(
  pipeline: BuildPipeline,
  node: PipelineFlowNode,
): { stageId: string; label: string } | null {
  const paused = pipeline.phase === "paused";
  if (node.placeholder || (!isActiveBuildPhase(pipeline.phase) && !paused)) return null;
  const run = pipeline.validationRun;
  // While a validation run is unsealed it is the step the pipeline is on. A
  // pause cancels it, and skipping then seals what it had.
  if (run && !pipeline.reviewPackage) {
    return node.hasValidation &&
      (run.status === "planned" ||
        run.status === "running" ||
        (paused && run.status === "cancelled"))
      ? { stageId: `validation:${run.id}`, label: "Skip validation" }
      : null;
  }
  if (node.state !== "running" && node.state !== "paused") return null;
  const session = node.session;
  const label = SKIP_LABELS[node.kind];
  if (!session || session.superseded || !label) return null;
  return { stageId: session.sdkSessionId, label };
}

/** "Build", then "Build 2" for the next pass, and so on. */
function numbered(name: string, occurrence: number): string {
  return occurrence <= 1 ? name : `${name} ${occurrence}`;
}

function isCancelled(pipeline: BuildPipeline): boolean {
  return (
    pipeline.phase === "failed" &&
    !pipeline.failureContext &&
    (pipeline.error?.startsWith("Build cancelled") ?? false)
  );
}

/** The phase the pipeline stopped in, when it is paused or failed. */
function stoppedPhase(pipeline: BuildPipeline): ResumableBuildPhase | undefined {
  if (pipeline.phase === "paused") return pipeline.pausedFromPhase;
  if (pipeline.phase === "failed") return pipeline.failureContext?.phase;
  return undefined;
}

const PHASE_KIND: Partial<Record<ResumableBuildPhase, PipelineFlowNodeKind>> = {
  building: "build",
  reviewing: "review",
  addressing: "address",
  verifying: "verify",
  fixing: "fix",
  "creating-pr": "ship",
  "resolving-conflicts": "conflicts",
};

function reviewerSessionState(
  session: PipelineSession,
  pipeline: BuildPipeline,
  live: ReviewerRecord | undefined,
): FlowNodeState {
  if (session.skipped) return "cancelled";
  if (live && live.sessionKey === session.sessionKey) return reviewerFlowState(live.status);
  switch (session.reviewerOutcome) {
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      break;
  }
  if (session.status === "error") return "failed";
  if (session.status === "running") {
    if (isActiveBuildPhase(pipeline.phase)) return "running";
    return "cancelled";
  }
  return "complete";
}

/**
 * A single-session step's state. The current session carries the pipeline's
 * own pause, failure or cancellation; an idle current session in an active
 * pipeline is still that stage's work in progress (finalizing its result).
 */
function sessionState(
  session: PipelineSession,
  pipeline: BuildPipeline,
  current: boolean,
): FlowNodeState {
  if (session.superseded || session.skipped) return "cancelled";
  if (session.status === "error") return "failed";
  if (pipeline.phase === "failed" && pipeline.failureContext?.sessionId === session.sdkSessionId) {
    return "failed";
  }
  if (current) {
    if (pipeline.phase === "paused") return "paused";
    if (isCancelled(pipeline)) return "cancelled";
    if (isActiveBuildPhase(pipeline.phase)) {
      const kind = PHASE_KIND[pipeline.phase as ResumableBuildPhase];
      const sessionKind = pipelineSessionKind(session);
      if (
        session.status === "running" ||
        kind === sessionKind ||
        (sessionKind === "prepare" &&
          !session.completedAt &&
          (pipeline.phase === "building" || pipeline.phase === "fixing"))
      )
        return "running";
    }
  }
  if (session.status === "running") {
    return isActiveBuildPhase(pipeline.phase) ? "running" : "cancelled";
  }
  return "complete";
}

function sessionFields(
  session: PipelineSession,
  pipeline: BuildPipeline,
): Pick<
  PipelineFlowNode,
  "session" | "agent" | "model" | "reasoningEffort" | "startedAt" | "completedAt" | "tokenCount"
> {
  return {
    session,
    agent: session.agent ?? pipeline.agentType,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    tokenCount: session.tokenCount,
  };
}

/**
 * What a review session's report found. Older single-review records keep the
 * accepted report only on the pipeline, linked to the session that filed it.
 */
function issueCountsOf(
  session: PipelineSession | undefined,
  pipeline: BuildPipeline,
): PipelineReviewIssueCounts | undefined {
  if (!session) return undefined;
  if (session.reviewIssueCounts) return session.reviewIssueCounts;
  if (session.reviewReport) return pipelineReviewIssueCounts(session.reviewReport);
  const report = pipeline.structuredReview;
  if (!report) return undefined;
  const owner = pipeline.structuredReviewRequestId
    ? pipeline.sessions.find(
        (candidate) => candidate.structuredRequestId === pipeline.structuredReviewRequestId,
      )
    : [...pipeline.sessions].reverse().find((candidate) => candidate.phase === "review");
  return owner?.sessionKey === session.sessionKey ? pipelineReviewIssueCounts(report) : undefined;
}

interface ReviewPass {
  key: string;
  identity?: string;
  /** One-based, counting every review pass on the line. */
  number: number;
  iteration: number;
  reviewers: Map<number, PipelineFlowNode>;
  reviewersColumn: PipelineFlowColumn;
  consolidationColumn?: PipelineFlowColumn;
  closed: boolean;
}

/**
 * Projects a pipeline record onto the flow graph.
 *
 * @param pullRequest The environment's PR, shown once the pipeline has
 *   reached its Ship stage (an older PR on a reused environment is not this
 *   pipeline's).
 */
export function pipelineFlowModel(
  pipeline: BuildPipeline,
  pullRequest: PipelinePullRequest | null = null,
): PipelineFlowModel {
  const nodes = new Map<string, PipelineFlowNode>();
  const columns: PipelineFlowColumn[] = [];
  const occurrences = new Map<string, number>();
  const nextOccurrence = (kind: string) => {
    const next = (occurrences.get(kind) ?? 0) + 1;
    occurrences.set(kind, next);
    return next;
  };
  const addColumn = (kind: PipelineFlowColumnKind, key?: string): PipelineFlowColumn => {
    const occurrence = nextOccurrence(`column:${kind}`);
    const column: PipelineFlowColumn = {
      key: key ?? `${kind}-${occurrence}`,
      kind,
      label: numbered(COLUMN_LABELS[kind], occurrence),
      nodeIds: [],
    };
    columns.push(column);
    return column;
  };
  const place = (column: PipelineFlowColumn, node: PipelineFlowNode) => {
    nodes.set(node.id, node);
    column.nodeIds.push(node.id);
  };
  const active = isActiveBuildPhase(pipeline.phase);
  const complete = pipeline.phase === "complete";
  const cancelled = isCancelled(pipeline);
  const stopped = stoppedPhase(pipeline);
  const currentSession = pipeline.sessions[pipeline.currentSessionIndex];

  // Ticket: always first and always complete. It is what the pipeline was
  // started with, not a step that ran.
  place(addColumn("ticket", "ticket"), {
    id: PIPELINE_TICKET_NODE_ID,
    kind: "ticket",
    title: KIND_TITLES.ticket,
    state: "complete",
    placeholder: false,
  });

  // Setup: derived. It has no session, but it is time the reader waited.
  const inSetup =
    SETUP_PHASES.has(pipeline.phase) || (stopped !== undefined && SETUP_PHASES.has(stopped));
  const firstStart = pipeline.sessions[0]?.startedAt;
  const setupState: FlowNodeState = inSetup
    ? pipeline.phase === "paused"
      ? "paused"
      : pipeline.phase === "failed"
        ? "failed"
        : "running"
    : cancelled && pipeline.sessions.length === 0
      ? "cancelled"
      : "complete";
  place(addColumn("setup", "setup"), {
    id: PIPELINE_SETUP_NODE_ID,
    kind: "setup",
    title: KIND_TITLES.setup,
    state: setupState,
    placeholder: false,
    startedAt: pipeline.createdAt,
    ...(setupState === "complete" && firstStart ? { completedAt: firstStart } : {}),
    ...(setupState === "failed" && pipeline.error ? { error: pipeline.error } : {}),
  });

  // Current pipeline errors belong only to their recorded session, never to
  // every historical failure. Older snapshots may have no retained detail.
  function sessionError(session: PipelineSession): string | undefined {
    if (session.superseded) return undefined;
    return (
      session.error ??
      (pipeline.phase === "failed" && pipeline.failureContext?.sessionId === session.sdkSessionId
        ? pipeline.error
        : undefined)
    );
  }
  // The live fan-out belongs to the newest pass of the current iteration.
  const reviewingNow = pipeline.phase === "reviewing" || stopped === "reviewing";
  const fanout = pipeline.reviewFanout;
  const liveBySessionKey = new Map(
    (reviewingNow ? (fanout?.reviewers ?? []) : []).flatMap((reviewer) =>
      reviewer.sessionKey ? [[reviewer.sessionKey, reviewer] as const] : [],
    ),
  );
  const liveConsolidationKey = reviewingNow ? fanout?.consolidation?.sessionKey : undefined;

  const passes: ReviewPass[] = [];
  const lastPass = (): ReviewPass | null => passes.at(-1) ?? null;
  const openPass = (iteration: number, identity?: string): ReviewPass => {
    const number = passes.length + 1;
    const key = `review-pass-${number}`;
    const created: ReviewPass = {
      key,
      identity,
      number,
      iteration,
      reviewers: new Map(),
      reviewersColumn: addColumn("review", key),
      closed: false,
    };
    passes.push(created);
    return created;
  };
  /** The open pass of an iteration, or a new one. */
  const continuePass = (iteration: number, identity?: string): ReviewPass => {
    const open = lastPass();
    if (
      open &&
      !open.closed &&
      open.iteration === iteration &&
      (!identity || !open.identity || open.identity === identity)
    ) {
      open.identity ??= identity;
      return open;
    }
    return openPass(iteration, identity);
  };
  const closePass = () => {
    const open = lastPass();
    if (open) open.closed = true;
  };
  let lastPrepare: PipelineFlowNode | null = null;

  for (const item of pipelineStageItems(pipeline)) {
    if (item.kind === "validation") {
      // Validation checks the package its preparation produced, so it shows
      // on that node; a package prepared inside the build turn gets a
      // Prepare node of its own for its checks.
      const run = pipeline.validationRun!;
      const outcome = validationOutcome(run);
      const validationState: FlowNodeState =
        outcome === "running"
          ? active
            ? "running"
            : pipeline.phase === "paused"
              ? "paused"
              : "cancelled"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "failed" || outcome === "incomplete"
              ? "failed"
              : "complete";
      if (lastPrepare && columns.at(-1)?.nodeIds.includes(lastPrepare.id)) {
        lastPrepare.hasValidation = true;
        lastPrepare.state = validationState;
        lastPrepare.completedAt = run.completedAt;
        if (run.status === "failed" && run.error) lastPrepare.error = run.error;
        continue;
      }
      closePass();
      const occurrence = nextOccurrence("prepare");
      const node: PipelineFlowNode = {
        id: `validation:${run.id}`,
        kind: "prepare",
        title: numbered(KIND_TITLES.prepare, occurrence),
        state: validationState,
        placeholder: false,
        hasValidation: true,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        ...(run.status === "failed" && run.error ? { error: run.error } : {}),
      };
      place(addColumn("prepare"), node);
      lastPrepare = node;
      continue;
    }
    const { session } = item;
    const kind = pipelineSessionKind(session);
    const current = session === currentSession;

    if (kind === "reviewer") {
      const slot = pipelineIndependentReviewSlot(session.label) ?? 0;
      const live = liveBySessionKey.get(session.sessionKey);
      const legacyPrefix = `${pipeline.id}:review:${session.iteration}:`;
      const legacyIdentity =
        slot === 0 && session.sessionKey.startsWith(legacyPrefix)
          ? session.sessionKey.slice(legacyPrefix.length).split(":")[0]
          : undefined;
      const identity = session.reviewPassId ?? (live ? fanout?.reviewers[0]?.id : legacyIdentity);
      let reviewPass = continuePass(session.iteration, identity);
      let previous = reviewPass.reviewers.get(slot);
      // Legacy records predate reviewPassId. A fresh reviewer ID in a used
      // slot starts another full panel; numbered attempts keep the same slot.
      if (
        previous?.session &&
        (!session.reviewPassId || !previous.session?.reviewPassId) &&
        previous.session?.sessionKey.replace(/:attempt-\d+$/, "") !==
          session.sessionKey.replace(/:attempt-\d+$/, "")
      ) {
        reviewPass = openPass(session.iteration, identity);
        previous = undefined;
      }
      const node: PipelineFlowNode = {
        id: session.sessionKey,
        kind: "reviewer",
        title: `${KIND_TITLES.reviewer} ${slot + 1}`,
        state: reviewerSessionState(session, pipeline, live),
        placeholder: false,
        slot,
        passKey: reviewPass.key,
        ...sessionFields(session, pipeline),
        ...(live ? { reviewer: live } : {}),
        // Older sessions name no model; the live record or the panel's
        // configuration for the slot still does.
        model:
          session.model ??
          (live?.modelUnpinned ? undefined : live?.model) ??
          pipelineReviewerConfigs(pipeline)[slot]?.model,
        completedAt: session.completedAt ?? live?.completedAt,
        tokenCount: session.tokenCount ?? live?.tokenCount,
        issueCounts:
          issueCountsOf(session, pipeline) ??
          (live?.report && pipelineReviewIssueCounts(live.report)),
        error: live?.error ?? session.error,
        earlierAttempts: previous ? (previous.earlierAttempts ?? 0) + 1 : 0,
      };
      if (previous) {
        nodes.delete(previous.id);
        const index = reviewPass.reviewersColumn.nodeIds.indexOf(previous.id);
        reviewPass.reviewersColumn.nodeIds.splice(index, 1);
      }
      reviewPass.reviewers.set(slot, node);
      nodes.set(node.id, node);
      reviewPass.reviewersColumn.nodeIds.push(node.id);
      continue;
    }

    if (kind === "consolidation") {
      const liveConsolidation = session.sessionKey === liveConsolidationKey;
      const reviewPass = continuePass(
        session.iteration,
        session.reviewPassId ?? (liveConsolidation ? fanout?.reviewers[0]?.id : undefined),
      );
      // The live fan-out below owns retry actions and admission state.
      // Its compact history is used only after this pass stops being live.
      for (const reviewer of liveConsolidation && reviewingNow
        ? []
        : (session.sessionlessReviewers ?? [])) {
        if (reviewPass.reviewers.has(reviewer.slot)) continue;
        const node: PipelineFlowNode = {
          id: `reviewer:${reviewer.id}`,
          kind: "reviewer",
          title: `${KIND_TITLES.reviewer} ${reviewer.slot + 1}`,
          state: "failed",
          placeholder: false,
          passKey: reviewPass.key,
          slot: reviewer.slot,
          agent: reviewer.agent,
          model: reviewer.model,
          reasoningEffort: reviewer.reasoningEffort,
          error: reviewer.error,
        };
        reviewPass.reviewers.set(reviewer.slot, node);
        place(reviewPass.reviewersColumn, node);
      }
      let state: FlowNodeState = sessionState(session, pipeline, false);
      if (liveConsolidation) {
        state = fanout?.report
          ? "complete"
          : active
            ? "running"
            : pipeline.phase === "paused"
              ? "paused"
              : cancelled
                ? "cancelled"
                : pipeline.phase === "failed"
                  ? "failed"
                  : state;
      }
      const column = (reviewPass.consolidationColumn ??= addColumn("consolidation"));
      const previous = column.nodeIds[0];
      if (previous) nodes.delete(previous);
      column.nodeIds = [];
      place(column, {
        id: session.sessionKey,
        kind: "consolidation",
        title: numbered(KIND_TITLES.consolidation, reviewPass.number),
        state,
        placeholder: false,
        passKey: reviewPass.key,
        ...sessionFields(session, pipeline),
        issueCounts: issueCountsOf(session, pipeline),
        model: session.model ?? (liveConsolidation ? fanout?.consolidation?.model : undefined),
        reasoningEffort:
          session.reasoningEffort ??
          (liveConsolidation ? fanout?.consolidation?.reasoningEffort : undefined),
        error: sessionError(session),
      });
      continue;
    }

    closePass();
    const occurrence = nextOccurrence(kind);
    const state = sessionState(session, pipeline, current);
    const node: PipelineFlowNode = {
      id: session.sessionKey,
      kind,
      title: numbered(KIND_TITLES[kind], occurrence),
      state,
      placeholder: false,
      ...sessionFields(session, pipeline),
      ...(kind === "review" ? { issueCounts: issueCountsOf(session, pipeline) } : {}),
      error: sessionError(session),
    };
    if (kind === "review") {
      // A one-model review is a pass of its own.
      const reviewPass = openPass(session.iteration);
      node.passKey = reviewPass.key;
      place(reviewPass.reviewersColumn, node);
      reviewPass.closed = true;
      continue;
    }
    place(addColumn(kind as PipelineFlowColumnKind), node);
    if (kind === "prepare") lastPrepare = node;
  }

  // Reviewers of the live pass with no session yet: queued, starting, or
  // failed before their session was created.
  if (fanout && (reviewingNow || passes.length === 0)) {
    const livePass = continuePass(pipeline.iteration, fanout.reviewers[0]?.id);
    fanout.reviewers.forEach((reviewer, slot) => {
      const existing = livePass.reviewers.get(slot);
      if (existing?.session && existing.session.sessionKey === reviewer.sessionKey) return;
      const node: PipelineFlowNode = {
        id: `reviewer:${reviewer.id}`,
        kind: "reviewer",
        title: `${KIND_TITLES.reviewer} ${slot + 1}`,
        state: reviewerFlowState(reviewer.status),
        placeholder: false,
        slot,
        passKey: livePass.key,
        reviewer,
        agent: reviewer.agent as BuildPipelineAgent,
        model: reviewer.modelUnpinned ? undefined : reviewer.model,
        reasoningEffort: reviewer.reasoningEffort,
        startedAt: reviewer.startedAt,
        completedAt: reviewer.completedAt,
        tokenCount: reviewer.tokenCount,
        ...(reviewer.error ? { error: reviewer.error } : {}),
        earlierAttempts: existing ? (existing.earlierAttempts ?? 0) + 1 : 0,
      };
      // The live retry replaces the failed attempt it follows.
      if (existing) nodes.delete(existing.id);
      livePass.reviewers.set(slot, node);
      nodes.set(node.id, node);
    });
    livePass.reviewersColumn.nodeIds = [...livePass.reviewers.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, node]) => node.id);
  }
  // Reviewer columns read in slot order.
  for (const column of columns) {
    if (column.kind !== "review") continue;
    column.nodeIds.sort(
      (left, right) => (nodes.get(left)?.slot ?? 0) - (nodes.get(right)?.slot ?? 0),
    );
  }

  // A stop with no node to carry it: a stage that failed or paused before its
  // session existed, or a fan-out that failed without consolidating.
  const currentFailureRepresented = (phase: ResumableBuildPhase) =>
    [...nodes.values()].some(
      (node) =>
        node.state === "failed" &&
        !node.placeholder &&
        ((pipeline.failureContext?.sessionId &&
          node.session?.sdkSessionId === pipeline.failureContext.sessionId) ||
          node.kind === PHASE_KIND[phase] ||
          (phase === "reviewing" &&
            (node.kind === "reviewer" ||
              node.kind === "consolidation" ||
              node.hasValidation === true))) &&
        (!node.session || node.session.iteration === pipeline.iteration) &&
        (!pipeline.failureContext?.sessionId ||
          node.session?.sdkSessionId === pipeline.failureContext.sessionId),
    );
  if (pipeline.phase === "failed" && !cancelled && stopped && !currentFailureRepresented(stopped)) {
    carryStop(stopped, "failed");
  } else if (
    pipeline.phase === "paused" &&
    stopped &&
    ![...nodes.values()].some((node) => node.state === "paused" && !node.placeholder)
  ) {
    carryStop(stopped, "paused");
  }

  function carryStop(phase: ResumableBuildPhase, state: "failed" | "paused") {
    if (SETUP_PHASES.has(phase)) return;
    const kind = PHASE_KIND[phase];
    if (!kind) return;
    const error = state === "failed" ? pipeline.error : undefined;
    if (kind === "review" && usesReviewFanout(pipeline)) {
      const reviewPass = continuePass(pipeline.iteration);
      if (reviewPass.reviewersColumn.nodeIds.length === 0) {
        place(reviewPass.reviewersColumn, {
          id: `${reviewPass.key}:startup`,
          kind: "review",
          title: numbered(KIND_TITLES.review, reviewPass.number),
          state,
          placeholder: false,
          passKey: reviewPass.key,
          ...(error ? { error } : {}),
        });
        return;
      }
      const column = (reviewPass.consolidationColumn ??= addColumn("consolidation"));
      const existing = column.nodeIds[0] ? nodes.get(column.nodeIds[0]) : undefined;
      if (existing) {
        existing.state = state;
        if (error) existing.error = error;
        return;
      }
      place(column, {
        id: `${reviewPass.key}:consolidation`,
        kind: "consolidation",
        title: numbered(KIND_TITLES.consolidation, reviewPass.number),
        state,
        placeholder: false,
        passKey: reviewPass.key,
        ...(error ? { error } : {}),
      });
      return;
    }
    // The stage's latest node in this iteration, else a node for the stage
    // that never got a session.
    const last = [...nodes.values()].reverse().find((node) => node.kind === kind);
    if (last && (last.session?.iteration ?? pipeline.iteration) === pipeline.iteration) {
      if (last.state === "running" || last.state === "complete") last.state = state;
      if (error) last.error = error;
      return;
    }
    closePass();
    const occurrence = nextOccurrence(kind);
    const column =
      kind === "review"
        ? openPass(pipeline.iteration).reviewersColumn
        : addColumn(kind as PipelineFlowColumnKind);
    place(column, {
      id: `stopped:${phase}`,
      kind,
      title: numbered(KIND_TITLES[kind], occurrence),
      state,
      placeholder: false,
      ...(error ? { error } : {}),
    });
  }

  if (!complete && !cancelled) addPlaceholders();

  function addPlaceholders() {
    const fanoutConfigured = usesReviewFanout(pipeline);
    const separatePreparation = fanoutConfigured || Boolean(pipeline.reviewPreparation);
    const route: PipelineFlowColumnKind[] = [
      "setup",
      "build",
      ...(separatePreparation ? (["prepare"] as const) : []),
      "review",
      ...(fanoutConfigured ? (["consolidation"] as const) : []),
      "verify",
      "ship",
    ];
    const lastKind = columns.at(-1)!.kind;
    const position: number = (() => {
      switch (lastKind) {
        case "prepare":
          return route.indexOf("review") - 1;
        case "fix":
          return route.indexOf("build");
        case "address":
          return route.indexOf("verify") - 1;
        case "conflicts":
          return route.length;
        case "ticket":
          return 0;
        default:
          return route.indexOf(lastKind);
      }
    })();
    for (const kind of route.slice(position + 1)) {
      if (kind === "review") {
        const reviewPass = openPass(pipeline.iteration);
        const configs = fanoutConfigured ? pipelineReviewerConfigs(pipeline) : [null];
        configs.forEach((config, slot) => {
          place(reviewPass.reviewersColumn, {
            id: `placeholder:${reviewPass.key}:${slot}`,
            kind: config ? "reviewer" : "review",
            title: config ? `${KIND_TITLES.reviewer} ${slot + 1}` : KIND_TITLES.review,
            state: "not-started",
            placeholder: true,
            slot,
            passKey: reviewPass.key,
            ...stepFields(config ?? placeholderStep(pipeline, "review")),
          });
        });
        continue;
      }
      if (kind === "consolidation") {
        const reviewPass = lastPass();
        if (!reviewPass) continue;
        const column = (reviewPass.consolidationColumn ??= addColumn("consolidation"));
        place(column, {
          id: `placeholder:${reviewPass.key}:consolidation`,
          kind: "consolidation",
          title: numbered(KIND_TITLES.consolidation, reviewPass.number),
          state: "not-started",
          placeholder: true,
          passKey: reviewPass.key,
          ...stepFields(placeholderStep(pipeline, "consolidation")),
        });
        continue;
      }
      if (kind === "setup") continue;
      const occurrence = nextOccurrence(kind);
      place(addColumn(kind), {
        id: `placeholder:${kind}`,
        kind,
        title: numbered(KIND_TITLES[kind], occurrence),
        state: "not-started",
        placeholder: true,
        ...stepFields(placeholderStep(pipeline, kind)),
      });
    }
  }

  // The pull request: last when reached, or still ahead of an unfinished run.
  // It belongs to this pipeline only once the pipeline has reached Ship.
  const shipped = pipeline.sessions.some((session) => session.phase === "pr");
  const pr = shipped ? pullRequest : null;
  if (!cancelled || shipped)
    place(addColumn("pr", "pr"), {
      id: PIPELINE_PR_NODE_ID,
      kind: "pr",
      title: KIND_TITLES.pr,
      state: pr ? (pr.state === "closed" ? "cancelled" : "complete") : "not-started",
      placeholder: !pr && !complete && !cancelled,
    });

  // Review columns are headed by their pass, with reviewer progress.
  let reviewPassNumber = 0;
  for (const column of columns) {
    if (column.kind !== "review") continue;
    reviewPassNumber += 1;
    column.label = numbered(COLUMN_LABELS.review, reviewPassNumber);
  }

  for (const node of nodes.values()) {
    node.activityAt = latestActivityAt(node);
  }
  const ordered = columns.flatMap((column) => column.nodeIds.map((id) => nodes.get(id)!));
  return { nodes: ordered, columns, edges: pipelineFlowEdges(columns, nodes) };
}

/**
 * The straight line between neighbouring columns: one node to many fans out,
 * many to one fans in. A queued reviewer is waiting for admission, not for
 * input, so the edge into it stays pending rather than ready.
 */
function pipelineFlowEdges(
  columns: readonly PipelineFlowColumn[],
  nodes: ReadonlyMap<string, PipelineFlowNode>,
): PipelineFlowEdge[] {
  const edges: PipelineFlowEdge[] = [];
  for (let index = 1; index < columns.length; index += 1) {
    const sources = columns[index - 1]!.nodeIds;
    const targets = columns[index]!.nodeIds;
    const pairs: Array<[string, string]> =
      sources.length === 1
        ? targets.map((target) => [sources[0]!, target])
        : targets.length === 1
          ? sources.map((source) => [source, targets[0]!])
          : sources.flatMap((source) =>
              targets.map((target): [string, string] => [source, target]),
            );
    for (const [from, to] of pairs) {
      const target = nodes.get(to)!;
      edges.push({
        id: `${from}->${to}`,
        from,
        to,
        state: flowEdgeState(nodes.get(from)!.state, target.state, {
          waitingIsReady: target.kind !== "reviewer",
        }),
      });
    }
  }
  return edges;
}

/** The reviewer nodes of a pass, and its preparation and consolidation. */
export function pipelineReviewPassNodes(
  model: PipelineFlowModel,
  passKey: string,
): PipelineFlowNode[] {
  const passNodes = model.nodes.filter((node) => node.passKey === passKey);
  const first = passNodes[0];
  if (!first) return [];
  // The preparation right before the pass's reviewers is part of it.
  const columnIndex = model.columns.findIndex((column) => column.nodeIds.includes(first.id));
  const before = model.columns[columnIndex - 1];
  const prepare =
    before?.kind === "prepare" ? model.nodes.find((node) => node.id === before.nodeIds[0]) : null;
  return prepare ? [prepare, ...passNodes] : passNodes;
}

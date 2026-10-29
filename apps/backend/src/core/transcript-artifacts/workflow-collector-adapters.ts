/**
 * Per-workflow-type adapters from existing backend records to the normalized
 * WorkflowSnapshotV1 node/edge model.
 *
 * Adapters read only facts the authoritative record already holds. They never
 * copy prompts, paths, URLs, tool bodies or report text; labels are fixed
 * strings or model names, and `links.targetRef` values are opaque digests.
 * `links.targetRef` values use the scoped forms the renderer resolves:
 * `multi-review:<runId>` and `multi-review:<runId>:reviewer:<reviewerId>`; a
 * reference that would not match the opaque
 * pattern is omitted. Build pipeline nodes carry no links.
 * A status the adapter does not know maps to `unknown` with `rawStatus`.
 * `validation.state` is `accepted` only when the authoritative record states
 * acceptance, never merely because a report exists:
 * - Multi Review reviewer: its report is present AND the reviewer completed;
 *   consolidation: the consolidated report is present AND the consolidate
 *   step's runtime completed.
 * - Build pipeline review: the review session's `structuredResultStatus` is
 *   `accepted`; verification: the recorded `verificationResult` (`pass` →
 *   accepted, `fail` → rejected) on the last verify session.
 * A report whose acceptance the record does not state maps to `unknown`
 * (no finding count is claimed from an unaccepted report).
 */
import type {
  WorkflowSnapshotEdgeV1,
  WorkflowSnapshotNodeV1,
  WorkflowStatusV1,
} from "@orkestrator/protocol/workflow-snapshot";
import { parseUtcTimestamp } from "@orkestrator/protocol/workflow-snapshot";

export const WORKFLOW_SNAPSHOT_KINDS = ["multi-review", "build-pipeline"] as const;
export type WorkflowSnapshotKind = (typeof WORKFLOW_SNAPSHOT_KINDS)[number];

export interface AdaptedWorkflow {
  title: string;
  description: string;
  status: WorkflowStatusV1;
  nodes: WorkflowSnapshotNodeV1[];
  edges: WorkflowSnapshotEdgeV1[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, max);
}

/** RFC 3339 UTC with milliseconds, or undefined when the value cannot round-trip. */
export function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return parseUtcTimestamp(iso) === null ? undefined : iso;
}

function timing(
  startedAt: unknown,
  finishedAt: unknown,
): Pick<WorkflowSnapshotNodeV1, "startedAt" | "finishedAt"> {
  const start = normalizeTimestamp(startedAt);
  let finish = normalizeTimestamp(finishedAt);
  if (start && finish && Date.parse(finish) < Date.parse(start)) finish = undefined;
  return { ...(start ? { startedAt: start } : {}), ...(finish ? { finishedAt: finish } : {}) };
}

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A scoped link target, or null when it would not satisfy the opaque-reference pattern. */
export function scopedTarget(...parts: string[]): string | null {
  const target = parts.join(":");
  return OPAQUE_REF.test(target) ? target : null;
}

function node(
  target: string | null,
  input: Omit<WorkflowSnapshotNodeV1, "links" | "label"> & {
    label: string;
    transcript?: boolean;
    findings?: boolean;
  },
): WorkflowSnapshotNodeV1 {
  const { transcript, findings, ...rest } = input;
  const links: WorkflowSnapshotNodeV1["links"] = [];
  if (transcript && target)
    links.push({ relation: "transcript", targetRef: target, label: "Transcript" });
  if (findings && target)
    links.push({ relation: "findings", targetRef: target, label: "Findings" });
  return { ...rest, label: clean(rest.label, 200), links };
}

function mapped(
  value: unknown,
  table: Record<string, WorkflowStatusV1>,
): Pick<WorkflowSnapshotNodeV1, "status" | "rawStatus"> {
  if (typeof value === "string" && Object.hasOwn(table, value)) return { status: table[value]! };
  return {
    status: "unknown",
    ...(typeof value === "string" ? { rawStatus: clean(value, 100) } : { rawStatus: "missing" }),
  };
}

function overall(value: unknown, table: Record<string, WorkflowStatusV1>): WorkflowStatusV1 {
  return typeof value === "string" && Object.hasOwn(table, value) ? table[value]! : "unknown";
}

function reportCounts(report: unknown): { findingCount: number } | undefined {
  if (!isRecord(report)) return undefined;
  return {
    findingCount: asArray(report.issues).length + asArray(report.testCoverageGaps).length,
  };
}

function edge(
  from: string,
  to: string,
  relation: WorkflowSnapshotEdgeV1["relation"],
): WorkflowSnapshotEdgeV1 {
  return { id: `${from}->${to}`.slice(0, 128), from, to, relation };
}

// ---------------------------------------------------------------------------
// Multi Review

export const MULTI_REVIEW_STATUS: Record<string, WorkflowStatusV1> = {
  preparing: "running",
  reviewing: "running",
  consolidating: "running",
  fixing: "running",
  interactive: "running",
  cancelling: "running",
  ready: "blocked",
  paused: "blocked",
  completed: "succeeded",
  cancelled: "canceled",
  failed: "failed",
};

export const REVIEWER_STATUS: Record<string, WorkflowStatusV1> = {
  pending: "pending",
  running: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "canceled",
};

const SESSION_STATUS: Record<string, WorkflowStatusV1> = {
  running: "running",
  idle: "succeeded",
  failed: "failed",
  cancelled: "canceled",
};

const VALIDATION_RUN_STATUS: Record<string, WorkflowStatusV1> = {
  planned: "pending",
  running: "running",
  completed: "succeeded",
  cancelled: "canceled",
  failed: "failed",
};

function modelLabel(prefix: string, selection: unknown): string {
  if (!isRecord(selection)) return prefix;
  const model = asString(selection.model);
  return model && selection.modelUnpinned !== true ? `${prefix} (${clean(model, 80)})` : prefix;
}

/** Status of one Multi Review step from its recorded runtime and the current phase. */
function multiReviewStep(
  workflow: Json,
  step: "prepare" | "consolidate" | "fix",
  activePhase: string,
  session: unknown,
): Pick<WorkflowSnapshotNodeV1, "status" | "rawStatus" | "startedAt" | "finishedAt"> {
  const runtimes = isRecord(workflow.stepRuntimes) ? workflow.stepRuntimes : {};
  const runtime = isRecord(runtimes[step]) ? (runtimes[step] as Json) : undefined;
  const phase = workflow.phase;
  const times = timing(runtime?.startedAt, runtime?.completedAt);
  if (phase === activePhase) return { status: "running", ...times };
  if (phase === "paused" && workflow.pausedFromPhase === activePhase) {
    return { status: "blocked", rawStatus: "paused", ...times };
  }
  if (runtime?.completedAt) return { status: "succeeded", ...times };
  if (isRecord(session)) {
    const status = mapped(session.status, SESSION_STATUS);
    if (status.status === "failed" || status.status === "canceled") return { ...status, ...times };
  }
  if ((phase === "failed" || phase === "cancelled") && runtime) {
    return { status: phase === "failed" ? "failed" : "canceled", ...times };
  }
  return {
    status: runtime ? "unknown" : "pending",
    ...(runtime ? { rawStatus: "incomplete" } : {}),
    ...times,
  };
}

export function adaptMultiReview(runId: string, workflow: Json): AdaptedWorkflow {
  const workflowTarget = scopedTarget("multi-review", runId);
  const nodes: WorkflowSnapshotNodeV1[] = [];
  const edges: WorkflowSnapshotEdgeV1[] = [];
  nodes.push(
    node(workflowTarget, {
      id: "prepare",
      label: modelLabel("Review preparation", workflow.reviewModel),
      role: "agent",
      transcript: isRecord(workflow.preparationSession) || isRecord(workflow.reviewSession),
      ...multiReviewStep(
        workflow,
        "prepare",
        "preparing",
        workflow.preparationSession ?? workflow.reviewSession,
      ),
    }),
  );
  if (isRecord(workflow.validationRun)) {
    const run = workflow.validationRun;
    nodes.push(
      node(workflowTarget, {
        id: "validation",
        label: "Validation commands",
        role: "validation",
        ...mapped(run.status, VALIDATION_RUN_STATUS),
        ...timing(run.startedAt, run.completedAt),
        ...(asString(run.id) ? { attemptId: clean(String(run.id), 128) } : {}),
        validation: {
          state: "not-applicable",
          errorCount: asArray(run.results).filter(
            (result) => isRecord(result) && result.status === "failed",
          ).length,
        },
      }),
    );
    edges.push(edge("prepare", "validation", "dependency"));
  }
  asArray(workflow.reviewers).forEach((reviewer, index) => {
    if (!isRecord(reviewer)) return;
    const id = `reviewer:${clean(asString(reviewer.id) ?? String(index), 100)}`;
    const reviewerId = asString(reviewer.id);
    const reviewerTarget = reviewerId
      ? scopedTarget("multi-review", runId, "reviewer", reviewerId)
      : null;
    const report = reportCounts(reviewer.report);
    const status = mapped(reviewer.status, REVIEWER_STATUS);
    nodes.push(
      node(reviewerTarget, {
        id,
        label: modelLabel(`Reviewer ${index + 1}`, reviewer),
        role: "review",
        ...status,
        ...timing(reviewer.startedAt, reviewer.completedAt),
        ...(asString(reviewer.requestId)
          ? { attemptId: clean(String(reviewer.requestId), 128) }
          : {}),
        validation:
          report && reviewer.status === "completed"
            ? { state: "accepted", ...report }
            : status.status === "failed"
              ? { state: "rejected" }
              : report || status.status === "succeeded"
                ? { state: "unknown" }
                : { state: "pending" },
        transcript: asString(reviewer.sessionKey) !== undefined,
        findings: report !== undefined,
      }),
    );
    edges.push(edge("prepare", id, "handoff"));
    edges.push(edge(id, "consolidate", "review"));
  });
  const consolidated = reportCounts(workflow.consolidatedReport);
  const consolidateStep = multiReviewStep(workflow, "consolidate", "consolidating", undefined);
  nodes.push(
    node(workflowTarget, {
      id: "consolidate",
      label: modelLabel("Consolidation", workflow.consolidationModel ?? workflow.reviewModel),
      role: "review",
      ...consolidateStep,
      validation:
        consolidated && consolidateStep.status === "succeeded"
          ? { state: "accepted", ...consolidated }
          : consolidated
            ? { state: "unknown" }
            : { state: "pending" },
      findings: consolidated !== undefined,
    }),
  );
  const fixResult = isRecord(workflow.fixResult) ? workflow.fixResult : undefined;
  if (isRecord(workflow.fixSession) || fixResult || workflow.phase === "fixing") {
    const step = multiReviewStep(workflow, "fix", "fixing", workflow.fixSession);
    nodes.push(
      node(workflowTarget, {
        id: "fix",
        label: modelLabel("Fix", workflow.fixModel),
        role: "agent",
        ...(fixResult && step.status !== "running"
          ? {
              ...step,
              status: fixResult.complete === true ? "succeeded" : "failed",
              rawStatus: undefined,
            }
          : step),
        transcript: isRecord(workflow.fixSession),
      }),
    );
    edges.push(edge("consolidate", "fix", "handoff"));
  }
  for (const entry of nodes) if (entry.rawStatus === undefined) delete entry.rawStatus;
  return {
    title: "Multi Review",
    description: `Multi Review with ${asArray(workflow.reviewers).length} reviewer(s)`,
    status: overall(workflow.phase, MULTI_REVIEW_STATUS),
    nodes,
    edges,
  };
}

// ---------------------------------------------------------------------------
// Build pipeline

export const BUILD_PIPELINE_STATUS: Record<string, WorkflowStatusV1> = {
  "creating-environment": "running",
  "starting-environment": "running",
  "waiting-for-setup": "running",
  building: "running",
  reviewing: "running",
  addressing: "running",
  verifying: "running",
  fixing: "running",
  "creating-pr": "running",
  "resolving-conflicts": "running",
  paused: "blocked",
  complete: "succeeded",
  failed: "failed",
};

const PIPELINE_SESSION_ROLE: Record<string, WorkflowSnapshotNodeV1["role"]> = {
  build: "agent",
  fix: "agent",
  address: "agent",
  "resolve-conflicts": "agent",
  review: "review",
  verify: "validation",
  pr: "output",
};

export function adaptBuildPipeline(_runId: string, pipeline: Json): AdaptedWorkflow {
  const nodes: WorkflowSnapshotNodeV1[] = [];
  const edges: WorkflowSnapshotEdgeV1[] = [];
  const sessions = asArray(pipeline.sessions).filter(isRecord);
  const current =
    typeof pipeline.currentSessionIndex === "number" ? pipeline.currentSessionIndex : -1;
  nodes.push(node(null, { id: "task", label: "Task", role: "input", status: "succeeded" }));
  let lastVerify = -1;
  let lastReview = -1;
  sessions.forEach((session, index) => {
    if (session.phase === "verify") lastVerify = index;
    if (session.phase === "review") lastReview = index;
  });
  let previous = "task";
  let previousIteration: number | null = null;
  sessions.forEach((session, index) => {
    const id = `session-${index}`;
    const phase = typeof session.phase === "string" ? session.phase : "unknown";
    let status: Pick<WorkflowSnapshotNodeV1, "status" | "rawStatus">;
    if (session.status === "running") status = { status: "running" };
    else if (session.status === "error") status = { status: "failed" };
    else if (session.status === "idle") {
      status =
        session.completedAt || index < current || pipeline.phase === "complete"
          ? { status: "succeeded" }
          : pipeline.phase === "paused"
            ? { status: "blocked", rawStatus: "idle" }
            : { status: "unknown", rawStatus: "idle" };
    } else status = mapped(session.status, {});
    let validation: WorkflowSnapshotNodeV1["validation"];
    if (
      index === lastVerify &&
      (pipeline.verificationResult === "pass" || pipeline.verificationResult === "fail")
    ) {
      validation = { state: pipeline.verificationResult === "pass" ? "accepted" : "rejected" };
    } else if (index === lastReview && isRecord(pipeline.structuredReview)) {
      // The report on the pipeline is not by itself an acceptance: the
      // review session must record that the backend accepted its result.
      validation =
        session.structuredResultStatus === "accepted"
          ? { state: "accepted", ...reportCounts(pipeline.structuredReview) }
          : { state: "unknown" };
    }
    const iteration = typeof session.iteration === "number" ? session.iteration : undefined;
    nodes.push(
      node(null, {
        id,
        label: asString(session.label) ?? phase,
        role: PIPELINE_SESSION_ROLE[phase] ?? "unknown",
        ...status,
        ...timing(session.startedAt, session.completedAt),
        ...(iteration !== undefined ? { attemptId: `iteration-${iteration}` } : {}),
        ...(validation ? { validation } : {}),
        transcript: true,
        findings: index === lastReview && isRecord(pipeline.structuredReview),
      }),
    );
    edges.push(
      edge(
        previous,
        id,
        previousIteration !== null && iteration !== undefined && iteration > previousIteration
          ? "retry"
          : "handoff",
      ),
    );
    previous = id;
    if (iteration !== undefined) previousIteration = iteration;
  });
  const title = asString(pipeline.taskTitle);
  return {
    title: clean(title ? `Build pipeline: ${title}` : "Build pipeline", 200),
    description: `Iteration ${typeof pipeline.iteration === "number" ? pipeline.iteration : 0} of ${typeof pipeline.maxIterations === "number" ? pipeline.maxIterations : 0}`,
    status: overall(pipeline.phase, BUILD_PIPELINE_STATUS),
    nodes,
    edges,
  };
}

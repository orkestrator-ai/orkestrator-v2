/**
 * Projects a graph run of the Multi Review template onto its Multi Review
 * record (item 301, plan Phase 3, D5).
 *
 * A graph-engine Multi Review keeps the record every surface already reads —
 * the review-pass tab, the CLI's `review` commands, the coordinator's
 * `get_multi_review` and status wakes, the environment's activity badge —
 * and the graph run is the authority behind it. Each pass reads the run once
 * and maps its activations onto the record's shape:
 *
 * | Graph node | Record |
 * | --- | --- |
 * | `plan` | `preparationSession`, `stepRuntimes.prepare`, phase `preparing` |
 * | `package` | `reviewPackage` (the sealed `review-package@2` descriptor) |
 * | `review` (panel branch N) | `reviewers[N-1]`: status, session, report, provisional findings |
 * | `consolidate` | `reviewSession`, `stepRuntimes.consolidate`, `consolidatedReport`, `consolidationOverlap` |
 * | `fix` | `fixSession`, `stepRuntimes.fix`, `fixResult` |
 * | `describe-pr`, `pr` | `autoPrLaunch` |
 *
 * The consolidated report cites graph item ids (`review/panel.2/issue-3`,
 * `review/panel.2/coverage-gap-1`). They are translated to Multi Review's own
 * source ids (`reviewer-2/issue-3`) by the reviewer position of the report
 * they name, so `deriveConsolidatedProvenance` and `consolidationOverlap` run
 * exactly as they do for a bespoke review.
 *
 * Artifacts are read only for what the record does not hold yet (a reviewer's
 * report, the consolidated report, the package, the fix result), so a pass
 * over an unchanged run reads nothing but the run. Pure apart from that read.
 */
import { createHash } from "node:crypto";
import type { GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import {
  graphArtifactItemIds,
  graphNodeBranches,
  isGraphRunTerminal,
  type GraphActivationSession,
  type GraphArtifact,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import { graphBuiltInType } from "@orkestrator/protocol/graphs/types";
import type {
  MultiReviewModelSelection,
  MultiReviewPhase,
  MultiReviewSession,
  MultiReviewStepKind,
  MultiReviewStepRuntime,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  isProvisionalReviewIssue,
  REVIEW_PROVISIONAL_FINDINGS_MAX,
  type ReviewerProvisionalFinding,
  type ReviewerRecord,
} from "@orkestrator/protocol/review-fanout";
import type { ReviewFixResult } from "@orkestrator/protocol/review-results";
import {
  isReviewPackageReference,
  type ReviewPackageReference,
} from "@orkestrator/protocol/review-workflow";
import {
  isStructuredReviewReport,
  safeParseStructuredReviewReport,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import { graphReviewCoverageGapIds } from "./graph-agent-builtins.js";
import { graphAgentSessionKey } from "./graph-agent-state.js";
import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";
import { parseFixResult } from "./review-prompts.js";
import {
  attributeReportFindings,
  consolidationOverlap,
  deriveConsolidatedProvenance,
} from "./review-fanout-provenance.js";

/** The template's node ids (`builtins/multi-review.ts`). */
export const MULTI_REVIEW_GRAPH_NODES = Object.freeze({
  plan: "plan",
  package: "package",
  review: "review",
  consolidate: "consolidate",
  hasFindings: "has-findings",
  fix: "fix",
  describePr: "describe-pr",
  pr: "pr",
} as const);

const N = MULTI_REVIEW_GRAPH_NODES;
const MAX_ERROR_CHARS = 4_096;

/** Reads one of the run's artifacts; null when it does not exist. */
export type MultiReviewGraphArtifactReader = (artifactId: string) => Promise<GraphArtifact | null>;

/** The record a graph-engine Multi Review shows for its run, at the run's revision. */
export async function projectMultiReviewGraphRun(
  workflow: MultiReviewWorkflow,
  run: GraphRun,
  read: MultiReviewGraphArtifactReader,
): Promise<MultiReviewWorkflow> {
  const next: MultiReviewWorkflow = structuredClone(workflow);
  const latest = latestActivations(run);
  const terminal = isGraphRunTerminal(run.status);

  // Reviewers, in configured order: panel position N is branch `panel.N`.
  const reviewNode = agentNode(run, N.review);
  const branches = reviewNode ? (graphNodeBranches(reviewNode, run.bindings.roles) ?? []) : [];
  const reviewers = await Promise.all(
    next.reviewers.map(async (reviewer, index) => {
      const key = branches[index]?.key;
      const activation = key === undefined ? undefined : latest.get(slot(N.review, key));
      return projectReviewer(run.id, reviewer, activation, read, terminal);
    }),
  );
  next.reviewers = reviewers;

  // Steps and their sessions.
  const plan = latest.get(slot(N.plan));
  const consolidate = latest.get(slot(N.consolidate));
  const fix = latest.get(slot(N.fix));
  const packageStep = latest.get(slot(N.package));
  const preparer = workflow.reviewModel ?? workflow.fixModel;
  const consolidator = workflow.consolidationModel ?? preparer;
  setSession(next, run.id, "preparationSession", plan, preparer, "prepare");
  setSession(next, run.id, "reviewSession", consolidate, consolidator, "consolidate");
  setSession(next, run.id, "fixSession", fix, workflow.fixModel, "fix");
  setRuntime(next, "prepare", plan);
  setRuntime(next, "consolidate", consolidate);
  setRuntime(next, "fix", fix);

  // The sealed package every reviewer shared.
  if (!next.reviewPackage && packageStep?.state === "complete" && packageStep.outputs.package) {
    const reference = await readPackage(read, packageStep.outputs.package);
    if (reference && reference.targetBranch === next.targetBranch) next.reviewPackage = reference;
  }

  // The consolidated report, translated to Multi Review's source ids.
  if (!next.consolidatedReport && consolidate?.state === "complete" && consolidate.outputs.report) {
    const consolidated = await readConsolidation(run, consolidate, branches, reviewers, read);
    if (consolidated) {
      next.consolidatedReport = consolidated.report;
      next.consolidationOverlap = consolidated.overlap;
    }
  }

  // The Fix's result.
  if (!next.fixResult && fix?.state === "complete" && fix.outputs.result) {
    const result = await readFixResult(read, fix.outputs.result);
    if (result) next.fixResult = result;
  }

  projectAutoPr(next, run, latest, terminal);
  projectPhase(next, run, latest);
  projectActiveRequest(next, latest, terminal);
  next.graphRun = {
    runId: run.id,
    projectedRevision: run.revision,
    ...(terminal ? { settled: true } : {}),
  };
  return next;
}

/**
 * The step a live run is working on, as the bespoke engine's `activeRequest`
 * shows it: its request id, journal state and result delivery state (the
 * tab's result-submission header). Only while the run is live: a settled
 * record keeps none, so no bespoke step logic ever acts on a graph request.
 */
function projectActiveRequest(
  workflow: MultiReviewWorkflow,
  latest: ReadonlyMap<string, NodeActivation>,
  terminal: boolean,
): void {
  delete workflow.activeRequest;
  if (terminal) return;
  const steps: [MultiReviewStepKind, string][] = [
    ["fix", N.fix],
    ["consolidate", N.consolidate],
    ["prepare", N.plan],
  ];
  for (const [kind, nodeId] of steps) {
    const activation = latest.get(slot(nodeId));
    const session = activation?.session;
    if (!activation || !session || !isActive(activation)) continue;
    const transport = resultTransport(session);
    workflow.activeRequest = {
      kind,
      requestId: session.requestId,
      state: session.dispatchState,
      ...(transport ? { resultTransport: transport } : {}),
      ...(session.resultSubmission ? { resultSubmission: session.resultSubmission } : {}),
      createdAt: activation.startedAt ?? activation.createdAt,
    };
    return;
  }
}

// ---------------------------------------------------------------- activations

function slot(nodeId: string, branchKey?: string): string {
  return branchKey === undefined ? nodeId : `${nodeId}#${branchKey}`;
}

/** The newest live activation of each node position (iteration 1; the template has no loops). */
function latestActivations(run: GraphRun): Map<string, NodeActivation> {
  const latest = new Map<string, NodeActivation>();
  for (const activation of run.activations) {
    if (activation.state === "superseded") continue;
    const key = slot(activation.nodeId, activation.branchKey);
    const current = latest.get(key);
    if (!current || activation.attempt > current.attempt) latest.set(key, activation);
  }
  return latest;
}

function agentNode(run: GraphRun, id: string): GraphPlanAgentNode | undefined {
  return run.plan.nodes.find(
    (node): node is GraphPlanAgentNode => node.kind === "agent" && node.id === id,
  );
}

function bounded(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function isActive(activation: NodeActivation | undefined): boolean {
  return (
    activation !== undefined &&
    ["ready", "admitting", "running", "awaiting-human"].includes(activation.state)
  );
}

function resultTransport(session: GraphActivationSession): ReviewerRecord["resultTransport"] {
  if (session.resultTransport.startsWith("tool")) return "tool-v1";
  if (session.resultTransport.startsWith("structured")) return "structured-output-v1";
  return undefined;
}

function digest(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

// ---------------------------------------------------------------- reviewers

function selectionOf(reviewer: ReviewerRecord): Partial<ReviewerRecord> {
  const { id, agent, model, reasoningEffort, fastMode, lens, modelUnpinned, modelSubstitution } =
    reviewer;
  return {
    id,
    agent,
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(lens !== undefined ? { lens } : {}),
    ...(modelUnpinned !== undefined ? { modelUnpinned } : {}),
    ...(modelSubstitution !== undefined ? { modelSubstitution } : {}),
  };
}

async function projectReviewer(
  runId: string,
  reviewer: ReviewerRecord,
  activation: NodeActivation | undefined,
  read: MultiReviewGraphArtifactReader,
  terminal: boolean,
): Promise<ReviewerRecord> {
  const base = selectionOf(reviewer) as ReviewerRecord;
  if (!activation || activation.state === "waiting") {
    return { ...base, status: terminal ? "cancelled" : "pending" };
  }
  const session = activation.session;
  const projected: ReviewerRecord = {
    ...base,
    status: "pending",
    // The key the graph host runs the session under (`sessionKeyFor`): the
    // reviewer tab's transcript artifacts resolve in that conversation.
    ...(session
      ? { sessionKey: session.sessionKey ?? graphAgentSessionKey(runId, activation.key) }
      : {}),
    ...(session?.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    ...(session?.requestId ? { requestId: session.requestId } : {}),
    ...(session?.dispatchState ? { dispatchState: session.dispatchState } : {}),
    ...(session && resultTransport(session) ? { resultTransport: resultTransport(session) } : {}),
    ...(session?.resultSubmission ? { resultSubmission: session.resultSubmission } : {}),
    ...(session?.tokenCount !== undefined ? { tokenCount: session.tokenCount } : {}),
    ...(session?.cacheReadTokens !== undefined ? { cacheReadTokens: session.cacheReadTokens } : {}),
    ...(session?.commandSandboxOff ? { commandSandboxOff: session.commandSandboxOff } : {}),
    ...(session?.progressAt ? { progressAt: session.progressAt } : {}),
    ...(digest(session?.progressDigest) ? { progressDigest: session!.progressDigest } : {}),
    ...(session?.stalledSince ? { stalledSince: session.stalledSince } : {}),
    ...(activation.startedAt ? { startedAt: activation.startedAt } : {}),
  };
  switch (activation.state) {
    case "ready":
      return { ...projected, status: terminal ? "cancelled" : "pending", admissionState: "queued" };
    case "admitting":
      return {
        ...projected,
        status: terminal ? "cancelled" : "pending",
        admissionState: "admitting",
      };
    case "running":
    case "awaiting-human": {
      const findings = provisionalFindings(session);
      return {
        ...projected,
        status: terminal ? "cancelled" : "running",
        ...(findings.length > 0 ? { provisionalFindings: findings } : {}),
      };
    }
    case "complete": {
      const report =
        reviewer.status === "completed" && reviewer.report
          ? reviewer.report
          : await readReviewReport(read, activation.outputs.report, reviewer);
      return {
        ...projected,
        status: report ? "completed" : "failed",
        ...(report ? { report } : { error: "The reviewer's report could not be read" }),
        ...(activation.finishedAt ? { completedAt: activation.finishedAt } : {}),
      };
    }
    case "failed":
      return {
        ...projected,
        status: "failed",
        ...(bounded(activation.error) ? { error: bounded(activation.error) } : {}),
        // The activation failed before its agent session existed.
        ...(session?.providerSessionId ? {} : { startFailed: true }),
        ...(activation.finishedAt ? { completedAt: activation.finishedAt } : {}),
      };
    default:
      return {
        ...projected,
        status: "cancelled",
        ...(activation.finishedAt ? { completedAt: activation.finishedAt } : {}),
      };
  }
}

/**
 * A live reviewer's `report_progress` issues as provisional findings, as a
 * bespoke reviewer's `report_finding` calls are shown: unconfirmed, and
 * replaced by the accepted report.
 */
function provisionalFindings(
  session: GraphActivationSession | undefined,
): ReviewerProvisionalFinding[] {
  const findings: ReviewerProvisionalFinding[] = [];
  const seen = new Set<string>();
  for (const entry of session?.progress ?? []) {
    if (findings.length >= REVIEW_PROVISIONAL_FINDINGS_MAX) break;
    if (entry.port !== "report" || !isProvisionalReviewIssue(entry.item)) continue;
    const id = createHash("sha256").update(entry.id).digest("hex").slice(0, 24);
    if (seen.has(id)) continue;
    seen.add(id);
    findings.push({ id, reportedAt: entry.reportedAt, issue: entry.item });
  }
  return findings;
}

function artifactValue(artifact: GraphArtifact | null): unknown {
  return artifact && "value" in artifact.body ? artifact.body.value : undefined;
}

async function readReviewReport(
  read: MultiReviewGraphArtifactReader,
  artifactId: string | undefined,
  reviewer: ReviewerRecord,
): Promise<StructuredReviewReport | undefined> {
  if (!artifactId) return undefined;
  const value = acceptedReport(artifactValue(await read(artifactId)));
  if (!value) return undefined;
  // Provider output cannot name its own model: the backend attributes it.
  return attributeReportFindings(value, reviewer);
}

/**
 * A stored report as Multi Review accepts one: the domain parse, which drops
 * the provider schema's `null` placeholders a submitted `review-report@1`
 * keeps, so the record holds what a bespoke review stores.
 */
function acceptedReport(value: unknown): StructuredReviewReport | undefined {
  const parsed = safeParseStructuredReviewReport(value);
  return parsed.success ? parsed.data : undefined;
}

async function readPackage(
  read: MultiReviewGraphArtifactReader,
  artifactId: string,
): Promise<ReviewPackageReference | undefined> {
  const value = artifactValue(await read(artifactId));
  return isReviewPackageReference(value) ? value : undefined;
}

async function readFixResult(
  read: MultiReviewGraphArtifactReader,
  artifactId: string,
): Promise<ReviewFixResult | undefined> {
  const value = artifactValue(await read(artifactId));
  try {
    return parseFixResult(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- consolidation

/**
 * The consolidated report as Multi Review stores it: its graph source ids
 * translated to `reviewer-<position>/<kind>-<n>` by the position of the
 * report each id names, then provenance derived and overlap counted as the
 * bespoke consolidation does.
 */
async function readConsolidation(
  run: GraphRun,
  consolidate: NodeActivation,
  branches: readonly { key: string }[],
  reviewers: readonly ReviewerRecord[],
  read: MultiReviewGraphArtifactReader,
): Promise<
  | { report: StructuredReviewReport; overlap: MultiReviewWorkflow["consolidationOverlap"] }
  | undefined
> {
  const value = acceptedReport(artifactValue(await read(consolidate.outputs.report!)));
  // Unreadable: the record keeps no report, and a run that completes without
  // one fails the review ("completed without a consolidated report").
  if (!value) return undefined;
  const translation = await sourceIdTranslation(run, consolidate, branches, read);
  const translated = translateSourceIds(value, translation);
  const derived = deriveConsolidatedProvenance(translated, reviewers);
  return { report: derived.report, overlap: consolidationOverlap(translated, reviewers) };
}

/** Graph source id → Multi Review source id, for every report consolidation read. */
async function sourceIdTranslation(
  run: GraphRun,
  consolidate: NodeActivation,
  branches: readonly { key: string }[],
  read: MultiReviewGraphArtifactReader,
): Promise<Map<string, string>> {
  const items = graphBuiltInType("review-report@1")?.items;
  const positions = new Map(branches.map((branch, index) => [branch.key, index + 1]));
  const producers = new Map(run.activations.map((activation) => [activation.key, activation]));
  const translation = new Map<string, string>();
  const bound = consolidate.inputs.reports;
  for (const id of Array.isArray(bound) ? bound : bound ? [bound] : []) {
    const artifact = await read(id);
    if (!artifact) continue;
    const value = artifactValue(artifact);
    if (!isStructuredReviewReport(value)) continue;
    const branchKey = producers.get(artifact.producer.activation)?.branchKey;
    const position = branchKey === undefined ? undefined : positions.get(branchKey);
    if (position === undefined) continue;
    graphArtifactItemIds(artifact, items, { value }).forEach((itemId, index) =>
      translation.set(itemId, `reviewer-${position}/issue-${index + 1}`),
    );
    graphReviewCoverageGapIds(artifact.producer, value.testCoverageGaps.length).forEach(
      (gapId, index) => translation.set(gapId, `reviewer-${position}/coverage-gap-${index + 1}`),
    );
  }
  return translation;
}

function translateSourceIds(
  report: StructuredReviewReport,
  translation: ReadonlyMap<string, string>,
): StructuredReviewReport {
  // An id that names nothing stays as it is: provenance derivation rejects it
  // and the overlap ignores it, exactly as for a bespoke report.
  const map = (ids: string[] | undefined) => ids?.map((id) => translation.get(id) ?? id);
  return {
    ...report,
    issues: report.issues.map((issue) => ({
      ...issue,
      ...(issue.reviewSourceIds ? { reviewSourceIds: map(issue.reviewSourceIds) } : {}),
    })),
    testCoverageGaps: report.testCoverageGaps.map((gap) => ({
      ...gap,
      ...(gap.reviewSourceIds ? { reviewSourceIds: map(gap.reviewSourceIds) } : {}),
    })),
  };
}

/** Exported for the evaluation parity suite: the translation a run's consolidation uses. */
export const multiReviewGraphSourceIds = { sourceIdTranslation, translateSourceIds };

// ---------------------------------------------------------------- sessions

function sessionStatus(activation: NodeActivation): MultiReviewSession["status"] {
  switch (activation.state) {
    case "complete":
      return "idle";
    case "failed":
      return "failed";
    case "cancelled":
    case "skipped":
      return "cancelled";
    default:
      return "running";
  }
}

function setSession(
  workflow: MultiReviewWorkflow,
  runId: string,
  field: "preparationSession" | "reviewSession" | "fixSession",
  activation: NodeActivation | undefined,
  selection: MultiReviewModelSelection,
  step: MultiReviewStepKind,
): void {
  const session = activation?.session;
  if (!activation || !session?.providerSessionId) return;
  workflow[field] = {
    agent: session.agent,
    model: session.model ?? selection.model,
    ...(selection.reasoningEffort !== undefined
      ? { reasoningEffort: selection.reasoningEffort }
      : {}),
    ...(selection.fastMode !== undefined ? { fastMode: selection.fastMode } : {}),
    sessionKey: session.sessionKey ?? graphAgentSessionKey(runId, activation.key),
    providerSessionId: session.providerSessionId,
    openedFor: step,
    requestIds: [session.requestId],
    status: sessionStatus(activation),
    startedAt: activation.startedAt ?? activation.createdAt,
    ...(session.tokenCount !== undefined ? { tokenCount: session.tokenCount } : {}),
    ...(session.progressAt ? { progressAt: session.progressAt } : {}),
    ...(digest(session.progressDigest) ? { progressDigest: session.progressDigest } : {}),
    ...(session.stalledSince ? { stalledSince: session.stalledSince } : {}),
    ...(activation.finishedAt ? { completedAt: activation.finishedAt } : {}),
    ...(bounded(activation.error) ? { error: bounded(activation.error) } : {}),
  };
}

function setRuntime(
  workflow: MultiReviewWorkflow,
  step: MultiReviewStepKind,
  activation: NodeActivation | undefined,
): void {
  if (!activation?.startedAt) return;
  const runtime: MultiReviewStepRuntime = {
    startedAt: activation.startedAt,
    ...(activation.finishedAt ? { completedAt: activation.finishedAt } : {}),
    ...(activation.session?.tokenCount !== undefined
      ? { tokenCount: activation.session.tokenCount }
      : {}),
    ...(activation.session?.commandSandboxOff
      ? { commandSandboxOff: activation.session.commandSandboxOff }
      : {}),
  };
  workflow.stepRuntimes = { ...workflow.stepRuntimes, [step]: runtime };
}

// ---------------------------------------------------------------- PR and phase

/**
 * The automatic pull request, from the `describe-pr` and `pr` nodes. Only a
 * Fix that completed or a clean report reaches them (the template's gates),
 * so the record says what the bespoke handoff would: pending while they run,
 * launched once the pull request exists.
 */
function projectAutoPr(
  workflow: MultiReviewWorkflow,
  run: GraphRun,
  latest: ReadonlyMap<string, NodeActivation>,
  terminal: boolean,
): void {
  if (workflow.autoPr !== true) return;
  const describe = latest.get(slot(N.describePr));
  const pr = latest.get(slot(N.pr));
  const gate = latest.get(slot(N.hasFindings));
  // A Fix-authorized launch names the Fix it follows, as `queueAutoPr` does,
  // so status notices never present it as the outcome of a later Fix.
  const fixIdentity = multiReviewFixIdentity(workflow.fixSession);
  const cleanReport =
    gate?.outlet === "clean" ||
    (!workflow.fixResult &&
      workflow.consolidatedReport !== undefined &&
      !hasFindings(workflow.consolidatedReport));
  const basis = cleanReport
    ? { basis: "clean-review" as const }
    : fixIdentity
      ? { fixIdentity }
      : {};
  const requestId = `${run.id}:pr`;
  const attempts = Math.max(0, (pr?.attempt ?? 1) - 1);
  const reached = (activation: NodeActivation | undefined) =>
    activation !== undefined && activation.state !== "waiting" && activation.state !== "skipped";
  if (pr?.state === "complete") {
    workflow.autoPrLaunch = { ...basis, state: "launched", requestId };
    return;
  }
  if (pr?.state === "failed" || describe?.state === "failed") {
    workflow.autoPrLaunch = {
      ...basis,
      state: "failed",
      requestId,
      ...(attempts > 0 ? { attempts } : {}),
      ...(bounded(pr?.error ?? describe?.error)
        ? { message: bounded(pr?.error ?? describe?.error) }
        : {}),
    };
    return;
  }
  // The gates between the step that authorizes the pull request (a clean
  // consolidation, a Fix that completed) and `describe-pr` run in later saves
  // of the run. The bespoke engine queues the pull request in the same save as
  // that step, so a revision in between must already read pending: otherwise
  // it shows a review that ended without one, and a status wake reports that.
  const authorized =
    (cleanReport || workflow.fixResult?.complete === true) &&
    pr?.state !== "skipped" &&
    describe?.state !== "skipped";
  if (reached(pr) || reached(describe) || authorized) {
    workflow.autoPrLaunch = terminal
      ? {
          ...basis,
          state: "failed",
          requestId,
          message: "The review ended before the pull request was opened",
        }
      : { ...basis, state: "pending", requestId, ...(attempts > 0 ? { attempts } : {}) };
    return;
  }
  // An anticipated launch whose nodes were then skipped. Never leave it
  // pending: on a settled record the bespoke supervisor would launch it.
  if (workflow.autoPrLaunch?.state === "pending") {
    workflow.autoPrLaunch = {
      ...basis,
      state: "skipped",
      requestId,
      message: "The pull request step did not run",
    };
  }
}

/** Issues or coverage gaps: what the template's `has-findings` gate routes to the Fix. */
function hasFindings(report: StructuredReviewReport): boolean {
  return report.issues.length > 0 || report.testCoverageGaps.length > 0;
}

function projectPhase(
  workflow: MultiReviewWorkflow,
  run: GraphRun,
  latest: ReadonlyMap<string, NodeActivation>,
): void {
  const previous = workflow.phase;
  const phase = phaseOf(workflow, run, latest);
  workflow.phase = phase;
  if (phase === "cancelling") {
    workflow.cancellingSince ??= run.cancelRequestedAt ?? run.updatedAt;
  } else {
    delete workflow.cancellingSince;
  }
  if (phase === "failed") {
    workflow.error = bounded(failureOf(workflow, run, latest));
  } else if (previous !== phase) {
    delete workflow.error;
  }
}

function phaseOf(
  workflow: MultiReviewWorkflow,
  run: GraphRun,
  latest: ReadonlyMap<string, NodeActivation>,
): MultiReviewPhase {
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "cancelling") return "cancelling";
  const fix = latest.get(slot(N.fix));
  if (workflow.fixResult) return workflow.fixResult.complete ? "completed" : "failed";
  if (run.status === "failed") return "failed";
  if (isActive(fix)) return workflow.consolidatedReport ? "fixing" : "consolidating";
  // Auto-fix hands a report with findings to the Fix through a gate that
  // runs in a later save; the bespoke engine moves on in the same save, so
  // the review is never shown ready (with a Fix button and a wake) in between.
  if (
    workflow.consolidatedReport &&
    workflow.autoFix === true &&
    hasFindings(workflow.consolidatedReport) &&
    !isGraphRunTerminal(run.status) &&
    (!fix || fix.state === "waiting")
  ) {
    return "fixing";
  }
  if (workflow.consolidatedReport) return "ready";
  if (run.status === "complete") return "failed";
  const consolidate = latest.get(slot(N.consolidate));
  if (isActive(consolidate) || consolidate?.state === "complete") return "consolidating";
  const reviewing = [...latest.values()].some(
    (activation) => activation.nodeId === N.review && activation.state !== "waiting",
  );
  return reviewing ? "reviewing" : "preparing";
}

function failureOf(
  workflow: MultiReviewWorkflow,
  run: GraphRun,
  latest: ReadonlyMap<string, NodeActivation>,
): string {
  if (workflow.fixResult && !workflow.fixResult.complete) {
    return `The fix model could not address every finding: ${workflow.fixResult.summary}`;
  }
  const failed = [N.plan, N.package, N.consolidate, N.fix]
    .map((nodeId) => latest.get(slot(nodeId)))
    .find((activation) => activation?.state === "failed");
  return (
    run.error ??
    failed?.error ??
    (run.status === "complete"
      ? "The graph run completed without a consolidated report"
      : "The graph run failed")
  );
}

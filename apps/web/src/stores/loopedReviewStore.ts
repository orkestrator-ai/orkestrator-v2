import { create } from "zustand";
import {
  isReviewFindingPool,
  isReviewReconciliation,
  backfillLegacyTestResults,
  isStructuredReviewReport,
  type ReviewFindingPool,
  type ReviewReconciliation,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import {
  REVIEW_WORKFLOW_FAILURE_KINDS,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  type ReviewWorkflowFailureKind,
} from "@orkestrator/protocol/review-workflow";
import type {
  AgentInteractionPolicy,
  AgentInteractionWorkflowSummary,
} from "@orkestrator/protocol/agent-interactions";
import { isAgentInteractionPolicy } from "@orkestrator/protocol/agent-interactions";
import type { DefaultAgent } from "@/types";
import { createUuid } from "@/lib/uuid";

export { LOOPED_REVIEW_WORKFLOW_VERSION };
export const LOOPED_REVIEW_DEFAULT_ALLOWANCE = 6;
export const LOOPED_REVIEW_MIN_ALLOWANCE = 1;
export const LOOPED_REVIEW_MAX_ALLOWANCE = 10;
/** Legacy key retained only so upgrades/tests can remove the obsolete mirror. */
export const LOOPED_REVIEW_STORAGE_KEY = "orkestrator-looped-reviews";

export type LoopedReviewPhase =
  | "preparing"
  | "discovering"
  | "reconciling"
  | "fixing"
  | "creating-pr"
  | "cancelling"
  | "paused"
  | "failed"
  | "cancelled"
  | "completed";

export type ActiveLoopedReviewPhase = Exclude<
  LoopedReviewPhase,
  "cancelling" | "paused" | "failed" | "cancelled" | "completed"
>;

export type LoopedReviewSessionPhase =
  | "preparation"
  | "discovery"
  | "fix"
  | "pr";

export interface ReviewPackageCommandResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  limitation?: string;
}

export interface ReviewPackageFile {
  path: string;
  status: string;
  content: string | null;
  contentSha256: string | null;
  omittedReason: string | null;
}

export interface ReviewPackageContext {
  ticketTitle?: string;
  ticketDescription?: string;
  acceptanceCriteria?: string;
  comments?: string[];
  imageNames?: string[];
  projectNotes?: string;
}

/**
 * One immutable discovery input. A package is replaced only when a successful
 * fix advances to the next round.
 */
export interface ReviewPackage {
  id: string;
  round: number;
  preparedAt: string;
  targetBranch: string;
  baseRef: string;
  headRef: string;
  commit: {
    sha: string;
    subject: string;
    committedFiles: string[];
  } | null;
  completeDiff: string;
  changedFiles: ReviewPackageFile[];
  validation: ReviewPackageCommandResult[];
  skippedFiles: Array<{ path: string; reason: string }>;
  uncommittedFiles: Array<{ path: string; reason: string }>;
  limitations: string[];
  context?: ReviewPackageContext;
}

export interface LoopedReviewSession {
  id: string;
  phase: LoopedReviewSessionPhase;
  round: number;
  pass?: number;
  providerSessionId: string;
  sessionKey?: string;
  origin?: "looped-review";
  interactionPolicy?: AgentInteractionPolicy;
  interactionSummary?: AgentInteractionWorkflowSummary;
  interactionTranscript?: unknown[];
  autoDeclineCount?: number;
  requestIds: string[];
  status: "running" | "idle" | "error" | "cancelled";
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface LoopedReviewPass {
  pass: number;
  sessionId: string;
  status: "discovering" | "reconciling" | "completed" | "failed";
  report?: StructuredReviewReport;
  reconciliation?: LoopedReviewReconciliation;
  startedAt: string;
  completedAt?: string;
}

export interface LoopedReviewFindingOutcome {
  reportIndex: number;
  outcome: "new" | "updated" | "existing";
  poolId: string | null;
}

/**
 * A looped pass must account for every report finding. The shared operations
 * remain provider-neutral, while these dispositions make unchanged semantic
 * matches explicit and prevent a finding from silently disappearing.
 */
export interface LoopedReviewReconciliation extends ReviewReconciliation {
  issueOutcomes: LoopedReviewFindingOutcome[];
  coverageGapOutcomes: LoopedReviewFindingOutcome[];
}

export interface LoopedReviewRound {
  round: number;
  allowance: number;
  status: "preparing" | "reviewing" | "fixing" | "completed" | "failed";
  package?: ReviewPackage;
  passes: LoopedReviewPass[];
  startedAt: string;
  completedAt?: string;
}

export interface ArchivedReviewPool {
  round: number;
  fixedAt: string;
  fixSessionId: string;
  pool: ReviewFindingPool;
  /**
   * What the fix session reported about this pool. Optional because workflows
   * archived before the fix result carried an outcome are still restored.
   */
  fixSummary?: string;
  fixNotes?: string[];
}

export interface ReviewFixOutcome {
  summary: string;
  notes: string[];
}

export interface LoopedReviewDispatch {
  id: string;
  requestId: string;
  sessionId: string;
  phase: ActiveLoopedReviewPhase;
  kind: "prepare" | "discover" | "reconcile" | "fix" | "pr";
  state: "prepared" | "dispatching" | "sent";
  createdAt: string;
}

export interface LoopedReviewFailure {
  code: ReviewWorkflowFailureKind;
  message: string;
  retryPhase: ActiveLoopedReviewPhase;
  /**
   * The provider may have accepted the request even though its response could
   * not be observed. Retry must reconcile this lease instead of dispatching a
   * second side-effecting turn.
   */
  preserveDispatch?: boolean;
  occurredAt: string;
}

export interface LoopedReviewWorkflow {
  version: typeof LOOPED_REVIEW_WORKFLOW_VERSION;
  controller?: "backend";
  controllerFence?: string;
  id: string;
  environmentId: string;
  projectId: string;
  agent: DefaultAgent;
  model: string;
  reasoningEffort?: string;
  targetBranch: string;
  reviewInstruction?: string;
  context?: ReviewPackageContext;
  startingAllowance: number;
  currentAllowance: number;
  currentRound: number;
  currentPass: number;
  phase: LoopedReviewPhase;
  pausedFromPhase?: ActiveLoopedReviewPhase;
  cancellingFromPhase?: ActiveLoopedReviewPhase;
  cancellingSince?: string;
  rounds: LoopedReviewRound[];
  activePool: ReviewFindingPool;
  archivedPools: ArchivedReviewPool[];
  sessions: LoopedReviewSession[];
  activeSessionId?: string;
  dispatch?: LoopedReviewDispatch;
  structuredWait?: { dispatchId: string; startedAt: string; idlePolls: number };
  pendingInteractionResolution?: unknown;
  interactionSummary?: AgentInteractionWorkflowSummary;
  autoDeclineCount?: number;
  interactionPolicy?: AgentInteractionPolicy;
  failure?: LoopedReviewFailure;
  pr: {
    status: "pending" | "running" | "failed" | "created";
    sessionId?: string;
    url?: string;
    error?: string;
  };
  createdAt: string;
  updatedAt: string;
  backendRevision: number;
}

export interface ReconciliationApplyResult {
  pool: ReviewFindingPool;
  added: number;
  updated: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minimum;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isReviewPackageCommandResult(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "command",
      "status",
      "exitCode",
      "stdout",
      "stderr",
      "durationMs",
      "limitation",
    ])
    && isString(value.command)
    && isOneOf(value.status, ["passed", "failed", "skipped"])
    && (value.exitCode === null || Number.isInteger(value.exitCode))
    && isString(value.stdout)
    && isString(value.stderr)
    && isIntegerAtLeast(value.durationMs, 0)
    && (
      value.limitation === undefined
      || value.limitation === null
      || isString(value.limitation)
    );
}

function isReviewPackageFile(value: unknown): value is ReviewPackageFile {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      "path",
      "status",
      "content",
      "contentSha256",
      "omittedReason",
    ])
    || !isString(value.path)
    || value.path.length === 0
    || !isString(value.status)
    || !isStringOrNull(value.content)
    || !isStringOrNull(value.contentSha256)
    || !isStringOrNull(value.omittedReason)
  ) {
    return false;
  }
  if (value.content === null) {
    return value.contentSha256 === null
      && typeof value.omittedReason === "string"
      && value.omittedReason.trim().length > 0;
  }
  return value.omittedReason === null
    && typeof value.contentSha256 === "string"
    && /^[a-f0-9]{64}$/i.test(value.contentSha256);
}

function isReviewPackageContext(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [
    "ticketTitle",
    "ticketDescription",
    "acceptanceCriteria",
    "comments",
    "imageNames",
    "projectNotes",
  ])) {
    return false;
  }
  return ["ticketTitle", "ticketDescription", "acceptanceCriteria", "projectNotes"]
    .every((key) =>
      value[key] === undefined
      || value[key] === null
      || isString(value[key])
    )
    && ["comments", "imageNames"].every((key) =>
      value[key] === undefined
      || value[key] === null
      || (
        Array.isArray(value[key])
        && value[key].every(isString)
      )
    );
}

function normalizeReviewPackageContext(value: unknown): ReviewPackageContext | undefined {
  if (!isRecord(value)) return undefined;
  const context: ReviewPackageContext = {};
  if (typeof value.ticketTitle === "string") context.ticketTitle = value.ticketTitle;
  if (typeof value.ticketDescription === "string") {
    context.ticketDescription = value.ticketDescription;
  }
  if (typeof value.acceptanceCriteria === "string") {
    context.acceptanceCriteria = value.acceptanceCriteria;
  }
  if (Array.isArray(value.comments)) context.comments = value.comments as string[];
  if (Array.isArray(value.imageNames)) context.imageNames = value.imageNames as string[];
  if (typeof value.projectNotes === "string") context.projectNotes = value.projectNotes;
  return Object.keys(context).length > 0 ? context : undefined;
}

export function parseReviewPackage(
  value: unknown,
  expected?: {
    id?: string;
    round?: number;
    targetBranch?: string;
    context?: ReviewPackageContext;
  },
): ReviewPackage {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      "id",
      "round",
      "preparedAt",
      "targetBranch",
      "baseRef",
      "headRef",
      "commit",
      "completeDiff",
      "changedFiles",
      "validation",
      "skippedFiles",
      "uncommittedFiles",
      "limitations",
      "context",
    ])
    || !isString(value.id)
    || value.id.length === 0
    || !isIntegerAtLeast(value.round, 1)
    || !isString(value.preparedAt)
    || !Number.isFinite(Date.parse(value.preparedAt))
    || !isString(value.targetBranch)
    || value.targetBranch.length === 0
    || !isString(value.baseRef)
    || !/^[a-f0-9]{7,64}$/i.test(value.baseRef)
    || !isString(value.headRef)
    || !/^[a-f0-9]{7,64}$/i.test(value.headRef)
    || !isString(value.completeDiff)
    || !Array.isArray(value.changedFiles)
    || !value.changedFiles.every(isReviewPackageFile)
    || !Array.isArray(value.validation)
    || !value.validation.every(isReviewPackageCommandResult)
    || !Array.isArray(value.skippedFiles)
    || !value.skippedFiles.every((file) =>
      isRecord(file)
      && hasOnlyKeys(file, ["path", "reason"])
      && isString(file.path)
      && file.path.length > 0
      && isString(file.reason)
      && file.reason.length > 0
    )
    || !Array.isArray(value.uncommittedFiles)
    || !value.uncommittedFiles.every((file) =>
      isRecord(file)
      && hasOnlyKeys(file, ["path", "reason"])
      && isString(file.path)
      && file.path.length > 0
      && isString(file.reason)
      && file.reason.length > 0
    )
    || !Array.isArray(value.limitations)
    || !value.limitations.every(isString)
    || (
      value.context !== undefined
      && value.context !== null
      && !isReviewPackageContext(value.context)
    )
  ) {
    throw new Error("Review package failed runtime validation");
  }
  if (value.commit !== null) {
    if (
      !isRecord(value.commit)
      || !hasOnlyKeys(value.commit, ["sha", "subject", "committedFiles"])
      || !isString(value.commit.sha)
      || value.commit.sha !== value.headRef
      || !isString(value.commit.subject)
      || !Array.isArray(value.commit.committedFiles)
      || !value.commit.committedFiles.every(isString)
    ) {
      throw new Error("Review package commit metadata is incompatible with its HEAD");
    }
  }
  const paths = value.changedFiles.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Review package contains duplicate changed-file paths");
  }
  if (value.changedFiles.length > 0 && value.completeDiff.length === 0) {
    throw new Error("Review package omitted the complete diff");
  }
  if (
    (expected?.id !== undefined && value.id !== expected.id)
    || (expected?.round !== undefined && value.round !== expected.round)
    || (
      expected?.targetBranch !== undefined
      && value.targetBranch !== expected.targetBranch
    )
    || (
      expected?.context !== undefined
      && JSON.stringify(normalizeReviewPackageContext(value.context))
        !== JSON.stringify(normalizeReviewPackageContext(expected.context))
    )
  ) {
    throw new Error("Prepared package does not match the active review round");
  }
  const normalizedContext = normalizeReviewPackageContext(value.context);
  const { context: _context, ...packageWithoutContext } = value;
  return {
    ...packageWithoutContext,
    validation: value.validation.map((command) => {
      if (!isRecord(command) || command.limitation !== null) return command;
      const { limitation: _limitation, ...normalized } = command;
      return normalized;
    }),
    ...(normalizedContext === undefined ? {} : { context: normalizedContext }),
  } as unknown as ReviewPackage;
}

function isReviewPackage(value: unknown, round: number): value is ReviewPackage {
  try {
    parseReviewPackage(value, { round });
    return true;
  } catch {
    return false;
  }
}

function isFindingOutcome(value: unknown): value is LoopedReviewFindingOutcome {
  return isRecord(value)
    && Number.isInteger(value.reportIndex)
    && (value.reportIndex as number) >= 0
    && (
      value.outcome === "new"
      || value.outcome === "updated"
      || value.outcome === "existing"
    )
    && (
      value.poolId === null
      || (typeof value.poolId === "string" && value.poolId.length > 0)
    )
    && (value.outcome === "new" ? value.poolId === null : typeof value.poolId === "string");
}

export function parseLoopedReviewReconciliation(
  value: unknown,
): LoopedReviewReconciliation {
  if (!isRecord(value)) {
    throw new Error("Looped review reconciliation must be an object");
  }
  const {
    issueOutcomes,
    coverageGapOutcomes,
    ...shared
  } = value;
  if (
    !isReviewReconciliation(shared)
    || !Array.isArray(issueOutcomes)
    || !issueOutcomes.every(isFindingOutcome)
    || !Array.isArray(coverageGapOutcomes)
    || !coverageGapOutcomes.every(isFindingOutcome)
  ) {
    throw new Error("Looped review reconciliation failed runtime validation");
  }
  return {
    ...shared,
    issueOutcomes,
    coverageGapOutcomes,
  };
}

function isLoopedReviewReconciliation(
  value: unknown,
): value is LoopedReviewReconciliation {
  try {
    parseLoopedReviewReconciliation(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeReviewAllowance(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return LOOPED_REVIEW_DEFAULT_ALLOWANCE;
  }
  return Math.min(
    LOOPED_REVIEW_MAX_ALLOWANCE,
    Math.max(LOOPED_REVIEW_MIN_ALLOWANCE, value),
  );
}

export function nextReviewAllowance(value: number): number {
  return Math.max(1, Math.ceil(normalizeReviewAllowance(value) / 2));
}

export function isLoopedReviewTerminalPhase(phase: LoopedReviewPhase): boolean {
  return phase === "cancelled" || phase === "completed";
}

export function isLoopedReviewActivePhase(
  phase: LoopedReviewPhase,
): phase is ActiveLoopedReviewPhase {
  return !isLoopedReviewTerminalPhase(phase)
    && phase !== "paused"
    && phase !== "failed"
    && phase !== "cancelling";
}

export function hasReviewFindings(pool: ReviewFindingPool): boolean {
  return pool.issues.length > 0 || pool.coverageGaps.length > 0;
}

/** Runtime guard used for local and backend workflow recovery. */
/**
 * Materializes `testResults.notRun` on every persisted pass report.
 *
 * Runs before {@link isLoopedReviewWorkflow} so a workflow written by a build
 * that predates the field is restored with a complete report rather than
 * leaving each reader to infer the count. Anything it cannot parse is returned
 * untouched for the guard below to reject.
 */
export function normalizeLoopedReviewWorkflow(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const workflow = value as Record<string, unknown>;
  if (!Array.isArray(workflow.rounds)) return value;

  let changed = false;
  const rounds = workflow.rounds.map((round) => {
    if (typeof round !== "object" || round === null) return round;
    const passes = (round as Record<string, unknown>).passes;
    if (!Array.isArray(passes)) return round;

    let roundChanged = false;
    const nextPasses = passes.map((pass) => {
      if (typeof pass !== "object" || pass === null) return pass;
      const report = (pass as Record<string, unknown>).report;
      if (report === undefined) return pass;
      const migrated = backfillLegacyTestResults(report);
      if (migrated === report) return pass;
      roundChanged = true;
      return { ...(pass as Record<string, unknown>), report: migrated };
    });
    if (!roundChanged) return round;
    changed = true;
    return { ...(round as Record<string, unknown>), passes: nextPasses };
  });

  return changed ? { ...workflow, rounds } : value;
}

export function isLoopedReviewWorkflow(value: unknown): value is LoopedReviewWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workflow = value as Partial<LoopedReviewWorkflow>;
  const phases: ReadonlySet<string> = new Set([
    "preparing",
    "discovering",
    "reconciling",
    "fixing",
    "creating-pr",
    "cancelling",
    "paused",
    "failed",
    "cancelled",
    "completed",
  ]);
  const validAllowance = (allowance: unknown) =>
    typeof allowance === "number"
    && Number.isInteger(allowance)
    && allowance >= LOOPED_REVIEW_MIN_ALLOWANCE
    && allowance <= LOOPED_REVIEW_MAX_ALLOWANCE;

  return workflow.version === LOOPED_REVIEW_WORKFLOW_VERSION
    && workflow.controller === "backend"
    && typeof workflow.id === "string"
    && typeof workflow.environmentId === "string"
    && typeof workflow.projectId === "string"
    && (workflow.agent === "claude"
      || workflow.agent === "codex"
      || workflow.agent === "opencode")
    && typeof workflow.targetBranch === "string"
    && typeof workflow.model === "string"
    && (
      workflow.reasoningEffort === undefined
      || typeof workflow.reasoningEffort === "string"
    )
    && (
      workflow.reviewInstruction === undefined
      || typeof workflow.reviewInstruction === "string"
    )
    && (
      workflow.context === undefined
      || isReviewPackageContext(workflow.context)
    )
    && validAllowance(workflow.startingAllowance)
    && validAllowance(workflow.currentAllowance)
    && typeof workflow.currentRound === "number"
    && Number.isInteger(workflow.currentRound)
    && workflow.currentRound >= 1
    && typeof workflow.currentPass === "number"
    && Number.isInteger(workflow.currentPass)
    && workflow.currentPass >= 0
    && typeof workflow.phase === "string"
    && phases.has(workflow.phase)
    && Array.isArray(workflow.rounds)
    && workflow.rounds.every((round) =>
      !!round
      && Number.isInteger(round.round)
      && validAllowance(round.allowance)
      && isOneOf(round.status, [
        "preparing",
        "reviewing",
        "fixing",
        "completed",
        "failed",
      ])
      && typeof round.startedAt === "string"
      && (
        round.completedAt === undefined
        || typeof round.completedAt === "string"
      )
      && (round.package === undefined || isReviewPackage(round.package, round.round))
      && Array.isArray(round.passes)
      && round.passes.every((pass) =>
        !!pass
        && isIntegerAtLeast(pass.pass, 1)
        && typeof pass.sessionId === "string"
        && isOneOf(pass.status, [
          "discovering",
          "reconciling",
          "completed",
          "failed",
        ])
        && typeof pass.startedAt === "string"
        && (
          pass.completedAt === undefined
          || typeof pass.completedAt === "string"
        )
        && (
          pass.report === undefined
          // Persisted passes may predate `testResults.notRun`; rejecting one
          // would discard the whole workflow. `normalizeLoopedReviewWorkflow`
          // has already materialized the field for anything reaching here.
          || isStructuredReviewReport(pass.report, { allowLegacyTestResults: true })
        )
        && (
          pass.reconciliation === undefined
          || isLoopedReviewReconciliation(pass.reconciliation)
        )
      )
    )
    && Array.isArray(workflow.sessions)
    && workflow.sessions.every((session) =>
      !!session
      && typeof session.id === "string"
      && typeof session.sessionKey === "string"
      && session.sessionKey.length > 0
      && typeof session.providerSessionId === "string"
      && session.origin === "looped-review"
      && isAgentInteractionPolicy(session.interactionPolicy)
      && session.interactionPolicy.mode === "unattended"
      && isOneOf(session.phase, ["preparation", "discovery", "fix", "pr"])
      && isIntegerAtLeast(session.round, 1)
      && (
        session.pass === undefined
        || isIntegerAtLeast(session.pass, 1)
      )
      && isOneOf(session.status, ["running", "idle", "error", "cancelled"])
      && typeof session.startedAt === "string"
      && (
        session.completedAt === undefined
        || typeof session.completedAt === "string"
      )
      && (session.error === undefined || typeof session.error === "string")
      && Array.isArray(session.requestIds)
      && session.requestIds.every((requestId) => typeof requestId === "string")
    )
    && isAgentInteractionPolicy(workflow.interactionPolicy)
    && workflow.interactionPolicy.mode === "unattended"
    && (
      workflow.structuredWait === undefined
      || (
        isRecord(workflow.structuredWait)
        && typeof workflow.structuredWait.dispatchId === "string"
        && typeof workflow.structuredWait.startedAt === "string"
        && isIntegerAtLeast(workflow.structuredWait.idlePolls, 0)
      )
    )
    && (
      workflow.dispatch === undefined
      || (
        isRecord(workflow.dispatch)
        && typeof workflow.dispatch.id === "string"
        && typeof workflow.dispatch.requestId === "string"
        && typeof workflow.dispatch.sessionId === "string"
        && isOneOf(workflow.dispatch.phase, [
          "preparing",
          "discovering",
          "reconciling",
          "fixing",
          "creating-pr",
        ])
        && isOneOf(workflow.dispatch.kind, [
          "prepare",
          "discover",
          "reconcile",
          "fix",
          "pr",
        ])
        && (
          (workflow.dispatch.phase === "preparing"
            && workflow.dispatch.kind === "prepare")
          || (workflow.dispatch.phase === "discovering"
            && workflow.dispatch.kind === "discover")
          || (workflow.dispatch.phase === "reconciling"
            && workflow.dispatch.kind === "reconcile")
          || (workflow.dispatch.phase === "fixing"
            && workflow.dispatch.kind === "fix")
          || (workflow.dispatch.phase === "creating-pr"
            && workflow.dispatch.kind === "pr")
        )
        && typeof workflow.dispatch.createdAt === "string"
        && (
          workflow.dispatch.state === "prepared"
          || workflow.dispatch.state === "dispatching"
          || workflow.dispatch.state === "sent"
        )
      )
    )
    && isReviewFindingPool(workflow.activePool)
    && Array.isArray(workflow.archivedPools)
    && workflow.archivedPools.every((archive) =>
      !!archive
      && Number.isInteger(archive.round)
      && typeof archive.fixSessionId === "string"
      && typeof archive.fixedAt === "string"
      && isReviewFindingPool(archive.pool)
      && (
        archive.fixSummary === undefined
        || typeof archive.fixSummary === "string"
      )
      && (
        archive.fixNotes === undefined
        || (
          Array.isArray(archive.fixNotes)
          && archive.fixNotes.every((note) => typeof note === "string")
        )
      )
    )
    && (
      workflow.pausedFromPhase === undefined
      || isOneOf(workflow.pausedFromPhase, [
        "preparing",
        "discovering",
        "reconciling",
        "fixing",
        "creating-pr",
      ])
    )
    && (
      workflow.cancellingFromPhase === undefined
      || isOneOf(workflow.cancellingFromPhase, [
        "preparing",
        "discovering",
        "reconciling",
        "fixing",
        "creating-pr",
      ])
    )
    && (
      workflow.failure === undefined
      || (
        isRecord(workflow.failure)
        && isOneOf(workflow.failure.code, REVIEW_WORKFLOW_FAILURE_KINDS)
        && typeof workflow.failure.message === "string"
        && isOneOf(workflow.failure.retryPhase, [
          "preparing",
          "discovering",
          "reconciling",
          "fixing",
          "creating-pr",
        ])
        && (
          workflow.failure.preserveDispatch === undefined
          || typeof workflow.failure.preserveDispatch === "boolean"
        )
        && typeof workflow.failure.occurredAt === "string"
      )
    )
    && !!workflow.pr
    && (
      workflow.pr.status === "pending"
      || workflow.pr.status === "running"
      || workflow.pr.status === "failed"
      || workflow.pr.status === "created"
    )
    && (
      workflow.pr.sessionId === undefined
      || typeof workflow.pr.sessionId === "string"
    )
    && (workflow.pr.url === undefined || typeof workflow.pr.url === "string")
    && (workflow.pr.error === undefined || typeof workflow.pr.error === "string")
    && typeof workflow.createdAt === "string"
    && typeof workflow.updatedAt === "string"
    && isIntegerAtLeast(workflow.backendRevision, 0)
    && (
      workflow.cancellingSince === undefined
      || typeof workflow.cancellingSince === "string"
    )
    && workflow.rounds.some((round) => round.round === workflow.currentRound)
    && (
      workflow.activeSessionId === undefined
      || workflow.sessions.some((session) => session.id === workflow.activeSessionId)
    )
    && (
      workflow.dispatch === undefined
      || workflow.sessions.some((session) => session.id === workflow.dispatch!.sessionId)
    )
    && (
      workflow.phase === "paused"
        ? workflow.pausedFromPhase !== undefined
        : workflow.pausedFromPhase === undefined
    )
    && (
      workflow.phase === "cancelling"
        ? workflow.cancellingFromPhase !== undefined
        : workflow.cancellingFromPhase === undefined
    );
}

/**
 * Applies provider-proposed reconciliation operations without allowing the
 * provider to choose stable IDs or update entries outside the active pool.
 */
export function applyReviewReconciliation(
  current: ReviewFindingPool,
  reconciliation: ReviewReconciliation,
  createId: () => string = createUuid,
): ReconciliationApplyResult {
  const issueIds = new Set(current.issues.map((finding) => finding.poolId));
  const gapIds = new Set(current.coverageGaps.map((finding) => finding.poolId));
  const updatedIssueIds = new Set<string>();
  const updatedGapIds = new Set<string>();

  for (const update of reconciliation.issueUpdates) {
    if (!issueIds.has(update.poolId)) {
      throw new Error(`Reconciliation referenced unknown issue pool ID: ${update.poolId}`);
    }
    if (updatedIssueIds.has(update.poolId)) {
      throw new Error(`Reconciliation updated issue pool ID more than once: ${update.poolId}`);
    }
    updatedIssueIds.add(update.poolId);
  }
  for (const update of reconciliation.coverageGapUpdates) {
    if (!gapIds.has(update.poolId)) {
      throw new Error(`Reconciliation referenced unknown coverage-gap pool ID: ${update.poolId}`);
    }
    if (updatedGapIds.has(update.poolId)) {
      throw new Error(`Reconciliation updated coverage-gap pool ID more than once: ${update.poolId}`);
    }
    updatedGapIds.add(update.poolId);
  }

  const issueUpdates = new Map(
    reconciliation.issueUpdates.map((update) => [update.poolId, update.finding]),
  );
  const gapUpdates = new Map(
    reconciliation.coverageGapUpdates.map((update) => [update.poolId, update.finding]),
  );
  const nextIssues = current.issues.map((finding) => {
    const update = issueUpdates.get(finding.poolId);
    return update ? { poolId: finding.poolId, ...update } : finding;
  });
  const nextCoverageGaps = current.coverageGaps.map((finding) => {
    const update = gapUpdates.get(finding.poolId);
    return update ? { poolId: finding.poolId, ...update } : finding;
  });
  const assignedIds = new Set([...issueIds, ...gapIds]);
  const assignId = (prefix: "issue" | "gap"): string => {
    let id: string;
    do {
      id = `${prefix}-${createId()}`;
    } while (assignedIds.has(id));
    assignedIds.add(id);
    return id;
  };

  for (const finding of reconciliation.newIssues) {
    nextIssues.push({ poolId: assignId("issue"), ...finding });
  }
  for (const finding of reconciliation.newCoverageGaps) {
    nextCoverageGaps.push({ poolId: assignId("gap"), ...finding });
  }

  return {
    pool: { issues: nextIssues, coverageGaps: nextCoverageGaps },
    added:
      reconciliation.newIssues.length
      + reconciliation.newCoverageGaps.length,
    updated:
      reconciliation.issueUpdates.length
      + reconciliation.coverageGapUpdates.length,
  };
}

function sameFinding(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertReconciliationAccountsForReport(
  report: StructuredReviewReport,
  current: ReviewFindingPool,
  reconciliation: LoopedReviewReconciliation,
): void {
  const validate = <T,>(
    label: "issue" | "coverage gap",
    findings: T[],
    outcomes: LoopedReviewFindingOutcome[],
    newFindings: T[],
    updates: Array<{ poolId: string; finding: T }>,
    existingIds: Set<string>,
  ) => {
    if (outcomes.length !== findings.length) {
      throw new Error(
        `Reconciliation accounted for ${outcomes.length} ${label}s but the report contains ${findings.length}`,
      );
    }
    const byIndex = new Map<number, LoopedReviewFindingOutcome>();
    for (const outcome of outcomes) {
      if (
        outcome.reportIndex >= findings.length
        || byIndex.has(outcome.reportIndex)
      ) {
        throw new Error(`Reconciliation contains an invalid duplicate ${label} report index`);
      }
      byIndex.set(outcome.reportIndex, outcome);
    }

    let newIndex = 0;
    const usedUpdateIds = new Set<string>();
    for (let reportIndex = 0; reportIndex < findings.length; reportIndex += 1) {
      const finding = findings[reportIndex]!;
      const outcome = byIndex.get(reportIndex);
      if (!outcome) {
        throw new Error(`Reconciliation omitted ${label} report index ${reportIndex}`);
      }
      if (outcome.outcome === "new") {
        const proposed = newFindings[newIndex++];
        if (proposed === undefined || !sameFinding(proposed, finding)) {
          throw new Error(`Reconciliation new ${label} does not match report index ${reportIndex}`);
        }
        continue;
      }
      const poolId = outcome.poolId!;
      if (!existingIds.has(poolId)) {
        throw new Error(`Reconciliation matched ${label} to unknown pool ID: ${poolId}`);
      }
      if (outcome.outcome === "updated") {
        const update = updates.find((candidate) => candidate.poolId === poolId);
        if (
          !update
          || usedUpdateIds.has(poolId)
          || !sameFinding(update.finding, finding)
        ) {
          throw new Error(`Reconciliation update for ${label} ${poolId} does not match the report`);
        }
        usedUpdateIds.add(poolId);
      }
    }
    if (newIndex !== newFindings.length || usedUpdateIds.size !== updates.length) {
      throw new Error(`Reconciliation contains unaccounted ${label} operations`);
    }
  };

  validate(
    "issue",
    report.issues,
    reconciliation.issueOutcomes,
    reconciliation.newIssues,
    reconciliation.issueUpdates,
    new Set(current.issues.map((finding) => finding.poolId)),
  );
  validate(
    "coverage gap",
    report.testCoverageGaps,
    reconciliation.coverageGapOutcomes,
    reconciliation.newCoverageGaps,
    reconciliation.coverageGapUpdates,
    new Set(current.coverageGaps.map((finding) => finding.poolId)),
  );
}

interface LoopedReviewState {
  workflows: Map<string, LoopedReviewWorkflow>;
  /** Install an authoritative backend snapshot. */
  replaceWorkflow: (workflow: LoopedReviewWorkflow) => void;
  /** Remove a projection after the backend resource or environment is deleted. */
  removeWorkflow: (workflowId: string) => void;
}

/**
 * Read-through projection of backend-owned workflows.
 *
 * Deliberately exposes no phase mutation methods: renderer commands go to the
 * backend and resource-change hydration installs the resulting snapshot.
 */
export const useLoopedReviewStore = create<LoopedReviewState>()((set) => ({
  workflows: new Map(),

  replaceWorkflow: (workflow) =>
    set((state) => {
      const existing = state.workflows.get(workflow.id);
      if (existing && existing.backendRevision > workflow.backendRevision) return state;
      const workflows = new Map(state.workflows);
      workflows.set(workflow.id, workflow);
      return { workflows };
    }),

  removeWorkflow: (workflowId) =>
    set((state) => {
      if (!state.workflows.has(workflowId)) return state;
      const workflows = new Map(state.workflows);
      workflows.delete(workflowId);
      return { workflows };
    }),
}));

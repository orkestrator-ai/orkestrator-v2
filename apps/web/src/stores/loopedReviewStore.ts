import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  isReviewFindingPool,
  isReviewReconciliation,
  isStructuredReviewReport,
  type ReviewFindingPool,
  type ReviewReconciliation,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { DefaultAgent } from "@/types";
import { createUuid } from "@/lib/uuid";

export const LOOPED_REVIEW_WORKFLOW_VERSION = 1;
export const LOOPED_REVIEW_DEFAULT_ALLOWANCE = 6;
export const LOOPED_REVIEW_MIN_ALLOWANCE = 1;
export const LOOPED_REVIEW_MAX_ALLOWANCE = 10;
export const LOOPED_REVIEW_STORAGE_KEY = "orkestrator-looped-reviews";

export type LoopedReviewPhase =
  | "preparing"
  | "discovering"
  | "reconciling"
  | "fixing"
  | "creating-pr"
  | "paused"
  | "failed"
  | "cancelled"
  | "completed";

export type ActiveLoopedReviewPhase = Exclude<
  LoopedReviewPhase,
  "paused" | "failed" | "cancelled" | "completed"
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
  state: "prepared" | "sent";
  createdAt: string;
}

export interface LoopedReviewFailure {
  code:
    | "connection"
    | "dispatch"
    | "provider"
    | "structured-output"
    | "package"
    | "reconciliation"
    | "fix"
    | "pr"
    | "persistence";
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
  rounds: LoopedReviewRound[];
  activePool: ReviewFindingPool;
  archivedPools: ArchivedReviewPool[];
  sessions: LoopedReviewSession[];
  activeSessionId?: string;
  dispatch?: LoopedReviewDispatch;
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

function emptyPool(): ReviewFindingPool {
  return { issues: [], coverageGaps: [] };
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
    && phase !== "failed";
}

export function hasReviewFindings(pool: ReviewFindingPool): boolean {
  return pool.issues.length > 0 || pool.coverageGaps.length > 0;
}

/** Runtime guard used for local and backend workflow recovery. */
export function isLoopedReviewWorkflow(value: unknown): value is LoopedReviewWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workflow = value as Partial<LoopedReviewWorkflow>;
  const phases: ReadonlySet<string> = new Set([
    "preparing",
    "discovering",
    "reconciling",
    "fixing",
    "creating-pr",
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
        && (pass.report === undefined || isStructuredReviewReport(pass.report))
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
      && typeof session.providerSessionId === "string"
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
      workflow.failure === undefined
      || (
        isRecord(workflow.failure)
        && isOneOf(workflow.failure.code, [
          "connection",
          "dispatch",
          "provider",
          "structured-output",
          "package",
          "reconciliation",
          "fix",
          "pr",
          "persistence",
        ])
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
  createWorkflow: (input: {
    environmentId: string;
    projectId: string;
    agent: DefaultAgent;
    model: string;
    reasoningEffort?: string;
    targetBranch: string;
    reviewInstruction?: string;
    context?: ReviewPackageContext;
    allowance?: number;
  }) => string;
  replaceWorkflow: (workflow: LoopedReviewWorkflow) => void;
  removeWorkflow: (workflowId: string) => void;
  setBackendRevision: (workflowId: string, revision: number) => void;
  setPhase: (workflowId: string, phase: ActiveLoopedReviewPhase) => void;
  addSession: (
    workflowId: string,
    session: Omit<LoopedReviewSession, "id" | "requestIds" | "startedAt" | "status"> & {
      id?: string;
    },
  ) => string | undefined;
  updateSession: (
    workflowId: string,
    sessionId: string,
    updates: Partial<LoopedReviewSession>,
  ) => void;
  setPreparedPackage: (workflowId: string, reviewPackage: ReviewPackage) => void;
  startPass: (workflowId: string, sessionId: string) => void;
  recordReport: (
    workflowId: string,
    sessionId: string,
    report: StructuredReviewReport,
  ) => void;
  recordReconciliation: (
    workflowId: string,
    sessionId: string,
    reconciliation: LoopedReviewReconciliation,
  ) => ReconciliationApplyResult | undefined;
  completeFix: (
    workflowId: string,
    fixSessionId: string,
    outcome: ReviewFixOutcome,
  ) => void;
  claimDispatch: (
    workflowId: string,
    dispatch: Omit<LoopedReviewDispatch, "state" | "createdAt">,
  ) => boolean;
  markDispatchSent: (workflowId: string, dispatchId: string) => void;
  clearDispatch: (workflowId: string, dispatchId: string) => void;
  failWorkflow: (
    workflowId: string,
    failure: Omit<LoopedReviewFailure, "occurredAt">,
  ) => void;
  pauseWorkflow: (workflowId: string) => void;
  resumeWorkflow: (workflowId: string) => void;
  retryWorkflow: (workflowId: string) => void;
  cancelWorkflow: (workflowId: string) => void;
  startPr: (workflowId: string, sessionId: string) => void;
  completePr: (workflowId: string, url: string) => void;
}

type PersistedLoopedReviewState = {
  workflows: Array<[string, LoopedReviewWorkflow]>;
};

function updateWorkflow(
  state: LoopedReviewState,
  workflowId: string,
  updater: (workflow: LoopedReviewWorkflow) => LoopedReviewWorkflow,
): Partial<LoopedReviewState> | LoopedReviewState {
  const workflow = state.workflows.get(workflowId);
  if (!workflow) return state;
  const next = updater(workflow);
  if (next === workflow) return state;
  const workflows = new Map(state.workflows);
  workflows.set(workflowId, { ...next, updatedAt: new Date().toISOString() });
  return { workflows };
}

export const useLoopedReviewStore = create<LoopedReviewState>()(
  persist<LoopedReviewState, [], [], PersistedLoopedReviewState>((set, get) => ({
    workflows: new Map(),

    createWorkflow: (input) => {
      const id = createUuid();
      const now = new Date().toISOString();
      const allowance = normalizeReviewAllowance(input.allowance);
      const workflow: LoopedReviewWorkflow = {
        version: LOOPED_REVIEW_WORKFLOW_VERSION,
        id,
        environmentId: input.environmentId,
        projectId: input.projectId,
        agent: input.agent,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        targetBranch: input.targetBranch,
        reviewInstruction: input.reviewInstruction,
        context: input.context,
        startingAllowance: allowance,
        currentAllowance: allowance,
        currentRound: 1,
        currentPass: 0,
        phase: "preparing",
        rounds: [{
          round: 1,
          allowance,
          status: "preparing",
          passes: [],
          startedAt: now,
        }],
        activePool: emptyPool(),
        archivedPools: [],
        sessions: [],
        pr: { status: "pending" },
        createdAt: now,
        updatedAt: now,
        backendRevision: 0,
      };
      set((state) => {
        const workflows = new Map(state.workflows);
        workflows.set(id, workflow);
        return { workflows };
      });
      return id;
    },

    replaceWorkflow: (workflow) =>
      set((state) => {
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

    setBackendRevision: (workflowId, revision) =>
      set((state) => {
        const workflow = state.workflows.get(workflowId);
        if (
          !workflow
          || !isIntegerAtLeast(revision, 0)
          || workflow.backendRevision === revision
        ) {
          return state;
        }
        const workflows = new Map(state.workflows);
        // A backend acknowledgement is not a workflow transition. Preserve the
        // durable updatedAt value so acknowledging a save cannot enqueue
        // another save forever.
        workflows.set(workflowId, { ...workflow, backendRevision: revision });
        return { workflows };
      }),

    setPhase: (workflowId, phase) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => ({
        ...workflow,
        phase,
        pausedFromPhase: undefined,
        failure: undefined,
      }))),

    addSession: (workflowId, input) => {
      const workflow = get().workflows.get(workflowId);
      if (!workflow || !isLoopedReviewActivePhase(workflow.phase)) return undefined;
      const id = input.id ?? createUuid();
      if (workflow.sessions.some((session) => session.id === id)) return undefined;
      set((state) => updateWorkflow(state, workflowId, (current) => ({
        ...current,
        sessions: [...current.sessions, {
          ...input,
          id,
          requestIds: [],
          status: "running",
          startedAt: new Date().toISOString(),
        }],
        activeSessionId: id,
      })));
      return id;
    },

    updateSession: (workflowId, sessionId, updates) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        const {
          id: _immutableId,
          phase: _immutablePhase,
          round: _immutableRound,
          pass: _immutablePass,
          startedAt: _immutableStartedAt,
          ...mutableUpdates
        } = updates;
        if (!workflow.sessions.some((session) => session.id === sessionId)) {
          return workflow;
        }
        return {
          ...workflow,
          sessions: workflow.sessions.map((session) =>
            session.id === sessionId
              ? { ...session, ...mutableUpdates }
              : session
          ),
        };
      })),

    setPreparedPackage: (workflowId, reviewPackage) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (
          workflow.phase !== "preparing"
          || reviewPackage.round !== workflow.currentRound
        ) {
          return workflow;
        }
        return {
          ...workflow,
          phase: "discovering",
          currentPass: 0,
          dispatch: undefined,
          rounds: workflow.rounds.map((round) =>
            round.round === workflow.currentRound
              ? { ...round, package: reviewPackage, status: "reviewing" }
              : round
          ),
        };
      })),

    startPass: (workflowId, sessionId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (workflow.phase !== "discovering") return workflow;
        const nextPass = workflow.currentPass + 1;
        if (nextPass > workflow.currentAllowance) return workflow;
        const session = workflow.sessions.find((candidate) =>
          candidate.id === sessionId
        );
        if (
          !session
          || session.phase !== "discovery"
          || session.round !== workflow.currentRound
          || session.pass !== nextPass
        ) {
          return workflow;
        }
        const pass: LoopedReviewPass = {
          pass: nextPass,
          sessionId,
          status: "discovering",
          startedAt: new Date().toISOString(),
        };
        return {
          ...workflow,
          currentPass: nextPass,
          activeSessionId: sessionId,
          rounds: workflow.rounds.map((round) =>
            round.round === workflow.currentRound
              ? { ...round, passes: [...round.passes, pass] }
              : round
          ),
        };
      })),

    recordReport: (workflowId, sessionId, report) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        const activePass = workflow.rounds
          .find((round) => round.round === workflow.currentRound)
          ?.passes.some((pass) =>
            pass.pass === workflow.currentPass
            && pass.sessionId === sessionId
          );
        if (
          workflow.phase !== "discovering"
          || workflow.activeSessionId !== sessionId
          || !activePass
        ) {
          return workflow;
        }
        return {
          ...workflow,
          phase: "reconciling",
          dispatch: undefined,
          rounds: workflow.rounds.map((round) =>
            round.round === workflow.currentRound
              ? {
                  ...round,
                  passes: round.passes.map((pass) =>
                    pass.pass === workflow.currentPass
                    && pass.sessionId === sessionId
                      ? { ...pass, report, status: "reconciling" }
                      : pass
                  ),
                }
              : round
          ),
        };
      })),

    recordReconciliation: (workflowId, sessionId, reconciliation) => {
      const workflow = get().workflows.get(workflowId);
      if (
        !workflow
        || workflow.phase !== "reconciling"
        || workflow.activeSessionId !== sessionId
      ) {
        return undefined;
      }
      const report = workflow.rounds
        .find((round) => round.round === workflow.currentRound)
        ?.passes.find((pass) =>
          pass.pass === workflow.currentPass
          && pass.sessionId === sessionId
        )?.report;
      if (!report) {
        throw new Error("Cannot reconcile a pass without its validated report");
      }
      assertReconciliationAccountsForReport(
        report,
        workflow.activePool,
        reconciliation,
      );
      const applied = applyReviewReconciliation(workflow.activePool, reconciliation);
      const shouldStop =
        applied.added + applied.updated === 0
        || workflow.currentPass >= workflow.currentAllowance;
      const now = new Date().toISOString();
      set((state) => updateWorkflow(state, workflowId, (current) => ({
        ...current,
        phase: shouldStop
          ? hasReviewFindings(applied.pool) ? "fixing" : "creating-pr"
          : "discovering",
        activePool: applied.pool,
        dispatch: undefined,
        rounds: current.rounds.map((round) =>
          round.round === current.currentRound
            ? {
                ...round,
                status: shouldStop
                  ? hasReviewFindings(applied.pool) ? "fixing" : "completed"
                  : round.status,
                completedAt:
                  shouldStop && !hasReviewFindings(applied.pool)
                    ? now
                    : round.completedAt,
                passes: round.passes.map((pass) =>
                  pass.pass === current.currentPass
                  && pass.sessionId === sessionId
                    ? {
                        ...pass,
                        reconciliation,
                        status: "completed",
                        completedAt: now,
                      }
                    : pass
                ),
              }
            : round
        ),
      })));
      return applied;
    },

    completeFix: (workflowId, fixSessionId, outcome) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (workflow.phase !== "fixing" || !hasReviewFindings(workflow.activePool)) {
          return workflow;
        }
        const now = new Date().toISOString();
        const archivedPools = [...workflow.archivedPools, {
          round: workflow.currentRound,
          fixedAt: now,
          fixSessionId,
          pool: workflow.activePool,
          // The pool is cleared from here on, so this is the only durable record
          // of what the fix session did and of findings it reported as disproved.
          fixSummary: outcome.summary,
          fixNotes: outcome.notes,
        }];
        const completedRounds = workflow.rounds.map((round) =>
          round.round === workflow.currentRound
            ? { ...round, status: "completed" as const, completedAt: now }
            : round
        );
        if (workflow.currentAllowance === 1) {
          return {
            ...workflow,
            phase: "creating-pr",
            activePool: emptyPool(),
            archivedPools,
            rounds: completedRounds,
            dispatch: undefined,
          };
        }
        const allowance = nextReviewAllowance(workflow.currentAllowance);
        const nextRound = workflow.currentRound + 1;
        return {
          ...workflow,
          phase: "preparing",
          currentAllowance: allowance,
          currentRound: nextRound,
          currentPass: 0,
          activePool: emptyPool(),
          archivedPools,
          rounds: [...completedRounds, {
            round: nextRound,
            allowance,
            status: "preparing",
            passes: [],
            startedAt: now,
          }],
          activeSessionId: undefined,
          dispatch: undefined,
        };
      })),

    claimDispatch: (workflowId, input) => {
      const workflow = get().workflows.get(workflowId);
      const expectedKind: Record<
        ActiveLoopedReviewPhase,
        LoopedReviewDispatch["kind"]
      > = {
        preparing: "prepare",
        discovering: "discover",
        reconciling: "reconcile",
        fixing: "fix",
        "creating-pr": "pr",
      };
      const expectedSessionPhase: Record<
        ActiveLoopedReviewPhase,
        LoopedReviewSessionPhase
      > = {
        preparing: "preparation",
        discovering: "discovery",
        reconciling: "discovery",
        fixing: "fix",
        "creating-pr": "pr",
      };
      const session = workflow?.sessions.find((candidate) =>
        candidate.id === input.sessionId
      );
      if (
        !workflow
        || !isLoopedReviewActivePhase(workflow.phase)
        || workflow.phase !== input.phase
        || input.kind !== expectedKind[input.phase]
        || !session
        || session.phase !== expectedSessionPhase[input.phase]
        || session.round !== workflow.currentRound
        || workflow.dispatch
      ) {
        return false;
      }
      set((state) => updateWorkflow(state, workflowId, (current) => ({
        ...current,
        dispatch: {
          ...input,
          state: "prepared",
          createdAt: new Date().toISOString(),
        },
        sessions: current.sessions.map((session) =>
          session.id === input.sessionId
            ? {
                ...session,
                status: "running",
                error: undefined,
                completedAt: undefined,
                requestIds: session.requestIds.includes(input.requestId)
                  ? session.requestIds
                  : [...session.requestIds, input.requestId],
              }
            : session
        ),
      })));
      return true;
    },

    markDispatchSent: (workflowId, dispatchId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) =>
        workflow.dispatch?.id !== dispatchId
          ? workflow
          : {
              ...workflow,
              dispatch: { ...workflow.dispatch, state: "sent" },
            }
      )),

    clearDispatch: (workflowId, dispatchId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) =>
        workflow.dispatch?.id !== dispatchId
          ? workflow
          : { ...workflow, dispatch: undefined }
      )),

    failWorkflow: (workflowId, failure) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (isLoopedReviewTerminalPhase(workflow.phase)) return workflow;
        return {
          ...workflow,
          phase: "failed",
          pausedFromPhase: undefined,
          failure: { ...failure, occurredAt: new Date().toISOString() },
          pr: failure.code === "pr"
            ? { ...workflow.pr, status: "failed", error: failure.message }
            : workflow.pr,
          rounds: workflow.rounds.map((round) =>
            round.round !== workflow.currentRound
              ? round
              : {
                  ...round,
                  status: "failed",
                  passes: round.passes.map((pass) =>
                    pass.pass === workflow.currentPass
                    && pass.sessionId === workflow.activeSessionId
                      ? { ...pass, status: "failed" }
                      : pass
                  ),
                }
          ),
        };
      })),

    pauseWorkflow: (workflowId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (!isLoopedReviewActivePhase(workflow.phase)) return workflow;
        return {
          ...workflow,
          phase: "paused",
          pausedFromPhase: workflow.phase,
        };
      })),

    resumeWorkflow: (workflowId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (workflow.phase !== "paused" || !workflow.pausedFromPhase) return workflow;
        return {
          ...workflow,
          phase: workflow.pausedFromPhase,
          pausedFromPhase: undefined,
        };
      })),

    retryWorkflow: (workflowId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (workflow.phase !== "failed" || !workflow.failure) return workflow;
        const failure = workflow.failure;
        const preserveDispatch =
          failure.preserveDispatch === true
          && workflow.dispatch !== undefined;
        const retryingDiscovery =
          !preserveDispatch
          &&
          failure.retryPhase === "discovering"
          && workflow.rounds
            .find((round) => round.round === workflow.currentRound)
            ?.passes.some((pass) =>
              pass.pass === workflow.currentPass
              && pass.report === undefined
            );
        return {
          ...workflow,
          phase: failure.retryPhase,
          currentPass: retryingDiscovery
            ? Math.max(0, workflow.currentPass - 1)
            : workflow.currentPass,
          failure: undefined,
          dispatch: preserveDispatch ? workflow.dispatch : undefined,
          rounds: workflow.rounds.map((round) =>
            round.round !== workflow.currentRound
              ? round
              : {
                  ...round,
                  status:
                    failure.retryPhase === "preparing"
                      ? "preparing"
                      : failure.retryPhase === "fixing"
                        ? "fixing"
                        : failure.retryPhase === "creating-pr"
                          ? "completed"
                        : "reviewing",
                  passes: round.passes.map((pass) =>
                    pass.pass === workflow.currentPass
                    && pass.sessionId === workflow.activeSessionId
                    && pass.status === "failed"
                    && failure.retryPhase === "reconciling"
                      ? { ...pass, status: "reconciling" }
                      : pass
                  ),
                }
          ),
          pr: failure.code === "pr"
            ? { ...workflow.pr, status: "pending", error: undefined }
            : workflow.pr,
        };
      })),

    cancelWorkflow: (workflowId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (isLoopedReviewTerminalPhase(workflow.phase)) return workflow;
        return {
          ...workflow,
          phase: "cancelled",
          pausedFromPhase: undefined,
          failure: undefined,
          dispatch: undefined,
          sessions: workflow.sessions.map((session) =>
            session.status === "running"
              ? { ...session, status: "cancelled" }
              : session
          ),
        };
      })),

    startPr: (workflowId, sessionId) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        const session = workflow.sessions.find((candidate) =>
          candidate.id === sessionId
        );
        if (
          workflow.phase !== "creating-pr"
          || !session
          || session.phase !== "pr"
          || session.round !== workflow.currentRound
        ) {
          return workflow;
        }
        return {
          ...workflow,
          activeSessionId: sessionId,
          pr: { status: "running", sessionId },
        };
      })),

    completePr: (workflowId, url) =>
      set((state) => updateWorkflow(state, workflowId, (workflow) => {
        if (workflow.phase !== "creating-pr" || workflow.pr.status !== "running") {
          return workflow;
        }
        return {
          ...workflow,
          phase: "completed",
          dispatch: undefined,
          pr: { ...workflow.pr, status: "created", url, error: undefined },
        };
      })),
  }), {
    name: LOOPED_REVIEW_STORAGE_KEY,
    version: LOOPED_REVIEW_WORKFLOW_VERSION,
    partialize: (state) => ({
      workflows: Array.from(state.workflows.entries()),
    }),
    merge: (persisted, current) => {
      const workflows = new Map<string, LoopedReviewWorkflow>();
      const entries = (persisted as PersistedLoopedReviewState | undefined)?.workflows;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [id, workflow] = entry;
        if (
          typeof id !== "string"
          || !isLoopedReviewWorkflow(workflow)
          || workflow.id !== id
        ) {
          continue;
        }
        workflows.set(id, workflow);
      }
      return { ...current, workflows };
    },
  }),
);

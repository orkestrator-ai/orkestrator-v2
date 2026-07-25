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
  reconciliation?: ReviewReconciliation;
  startedAt: string;
  completedAt?: string;
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
      && Array.isArray(round.passes)
      && round.passes.every((pass) =>
        !!pass
        && Number.isInteger(pass.pass)
        && typeof pass.sessionId === "string"
        && (pass.report === undefined || isStructuredReviewReport(pass.report))
        && (
          pass.reconciliation === undefined
          || isReviewReconciliation(pass.reconciliation)
        )
      )
    )
    && Array.isArray(workflow.sessions)
    && workflow.sessions.every((session) =>
      !!session
      && typeof session.id === "string"
      && typeof session.providerSessionId === "string"
      && Array.isArray(session.requestIds)
      && session.requestIds.every((requestId) => typeof requestId === "string")
    )
    && (
      workflow.dispatch === undefined
      || (
        typeof workflow.dispatch.id === "string"
        && typeof workflow.dispatch.requestId === "string"
        && typeof workflow.dispatch.sessionId === "string"
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
      && isReviewFindingPool(archive.pool)
    )
    && !!workflow.pr
    && (
      workflow.pr.status === "pending"
      || workflow.pr.status === "running"
      || workflow.pr.status === "failed"
      || workflow.pr.status === "created"
    )
    && typeof workflow.createdAt === "string"
    && typeof workflow.updatedAt === "string";
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
    reconciliation: ReviewReconciliation,
  ) => ReconciliationApplyResult | undefined;
  completeFix: (workflowId: string, fixSessionId: string) => void;
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
        if (!workflow || workflow.backendRevision === revision) return state;
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
      set((state) => updateWorkflow(state, workflowId, (workflow) => ({
        ...workflow,
        sessions: workflow.sessions.map((session) =>
          session.id === sessionId ? { ...session, ...updates } : session
        ),
      }))),

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
        if (workflow.phase !== "discovering" || workflow.activeSessionId !== sessionId) {
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

    completeFix: (workflowId, fixSessionId) =>
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
      if (
        !workflow
        || !isLoopedReviewActivePhase(workflow.phase)
        || workflow.phase !== input.phase
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
        const retryingDiscovery =
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
          dispatch: undefined,
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
        if (workflow.phase !== "creating-pr") return workflow;
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

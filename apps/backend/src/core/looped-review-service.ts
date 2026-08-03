import { randomUUID } from "node:crypto";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  AGENT_INTERACTION_JOURNAL_VERSION,
  AGENT_INTERACTION_LIMITS,
  AGENT_INTERACTION_SUMMARY_VERSION,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  agentInteractionPolicyAction,
  type AgentInteractionOutcome,
  type AgentInteractionRequest,
  type AgentInteractionResolutionJournalEntry,
  type AgentInteractionWorkflowSummary,
} from "@orkestrator/protocol/agent-interactions";
import {
  LOOPED_REVIEW_WORKFLOW_VERSION,
  hasReviewFindings,
  isLoopedReviewActivePhase,
  isLoopedReviewTerminalPhase,
  isLoopedReviewWorkflow,
  isSafelyAdoptableLegacyLoopedReview,
  isStartLoopedReviewInput,
  nextReviewAllowance,
  normalizeReviewAllowance,
  type ActiveLoopedReviewPhase,
  type LoopedReviewDispatch,
  type LoopedReviewFailure,
  type LoopedReviewInteractionTranscriptEntry,
  type LoopedReviewReconciliation,
  type LoopedReviewSession,
  type LoopedReviewSessionPhase,
  type LoopedReviewWorkflow,
  type PendingLoopedReviewInteractionResolution,
  type ReviewPackage,
  type StartLoopedReviewInput,
} from "@orkestrator/protocol/review-workflow";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  isReviewReconciliation,
  parseStructuredReviewReport,
  type ReviewFindingPool,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { Environment, PersistedLoopedReviewWorkflow } from "./models.js";
import type { StorageService } from "./storage.js";
import {
  AmbiguousPromptDispatchError,
  createBuildPipelineProvider,
  ProviderUnavailableError,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderDependencies,
  type ProviderInteractionObservationEvent,
} from "./build-pipeline-provider.js";
import { prPrompt } from "./build-pipeline-prompts.js";
import {
  LOOPED_REVIEW_RECONCILIATION_JSON_SCHEMA,
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  REVIEW_PR_RESULT_JSON_SCHEMA,
  createDiscoveryPrompt,
  createFixPoolPrompt,
  createReconciliationPrompt,
  createReviewPreparationPrompt,
  parseFixResult,
  parsePrResult,
  parseReviewPreparationResult,
} from "./looped-review-prompts.js";

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const CONTROLLER_LEASE_MS = 15_000;
const CONTROLLER_RENEW_MS = 5_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MISSING_RESULT_POLLS = 5;
const INTERACTION_PROCESSING_LEASE_MS = 2 * 60_000;
const UNATTENDED_POLICY_INSTRUCTION =
  "This is an unattended looped-review phase. No user can answer input. If input is declined, make the safest reasonable assumption, state it, and continue. Never treat the absence of a person as authorization.";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyPool(): ReviewFindingPool {
  return { issues: [], coverageGaps: [] };
}

function sessionLabel(phase: LoopedReviewSessionPhase, round: number, pass?: number): string {
  if (phase === "preparation") return `Round ${round} · Package preparation`;
  if (phase === "discovery") return `Round ${round} · Review pass ${pass}`;
  if (phase === "fix") return `Round ${round} · Fix session`;
  return "Final · PR creation";
}

function providerPhase(phase: LoopedReviewSessionPhase): "review" | "fix" | "pr" {
  return phase === "fix" ? "fix" : phase === "pr" ? "pr" : "review";
}

function executionMode(phase: LoopedReviewSessionPhase): "plan" | "build" {
  return phase === "discovery" ? "plan" : "build";
}

function dispatchKind(phase: ActiveLoopedReviewPhase): LoopedReviewDispatch["kind"] {
  switch (phase) {
    case "preparing": return "prepare";
    case "discovering": return "discover";
    case "reconciling": return "reconcile";
    case "fixing": return "fix";
    case "creating-pr": return "pr";
  }
}

function failureKind(kind: LoopedReviewDispatch["kind"] | undefined): LoopedReviewFailure["code"] {
  if (kind === "prepare") return "package";
  if (kind === "reconcile") return "reconciliation";
  if (kind === "fix") return "fix";
  if (kind === "pr") return "pr";
  return "provider";
}

function reviewPackage(value: unknown, expected: {
  id: string;
  round: number;
  targetBranch: string;
  context?: LoopedReviewWorkflow["context"];
}): ReviewPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Review package failed runtime validation");
  }
  const candidate = value as Partial<ReviewPackage>;
  if (candidate.id !== expected.id || candidate.round !== expected.round
    || candidate.targetBranch !== expected.targetBranch
    || typeof candidate.preparedAt !== "string"
    || typeof candidate.baseRef !== "string" || typeof candidate.headRef !== "string"
    || typeof candidate.completeDiff !== "string"
    || !Array.isArray(candidate.changedFiles) || !Array.isArray(candidate.validation)
    || !Array.isArray(candidate.skippedFiles) || !Array.isArray(candidate.uncommittedFiles)
    || !Array.isArray(candidate.limitations)) {
    throw new Error("Prepared package does not match the active review round");
  }
  return { ...candidate, ...(expected.context ? { context: expected.context } : {}) } as ReviewPackage;
}

function parseReconciliation(value: unknown): LoopedReviewReconciliation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Looped review reconciliation must be an object");
  }
  const source = value as Record<string, unknown>;
  const { issueOutcomes, coverageGapOutcomes, ...shared } = source;
  const outcome = (entry: unknown): boolean => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return Number.isInteger(item.reportIndex) && (item.reportIndex as number) >= 0
      && (item.outcome === "new" || item.outcome === "updated" || item.outcome === "existing")
      && (item.outcome === "new" ? item.poolId === null : typeof item.poolId === "string");
  };
  if (!isReviewReconciliation(shared) || !Array.isArray(issueOutcomes)
    || !issueOutcomes.every(outcome) || !Array.isArray(coverageGapOutcomes)
    || !coverageGapOutcomes.every(outcome)) {
    throw new Error("Looped review reconciliation failed runtime validation");
  }
  return { ...shared, issueOutcomes, coverageGapOutcomes } as LoopedReviewReconciliation;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyReconciliation(
  current: ReviewFindingPool,
  report: StructuredReviewReport,
  reconciliation: LoopedReviewReconciliation,
): { pool: ReviewFindingPool; added: number; updated: number } {
  const validate = <T>(
    findings: T[],
    outcomes: LoopedReviewReconciliation["issueOutcomes"],
    additions: T[],
    updates: Array<{ poolId: string; finding: T }>,
    ids: Set<string>,
    label: string,
  ) => {
    if (outcomes.length !== findings.length) throw new Error(`Reconciliation omitted ${label} findings`);
    const byIndex = new Map(outcomes.map((entry) => [entry.reportIndex, entry]));
    if (byIndex.size !== outcomes.length) throw new Error(`Reconciliation duplicated a ${label} index`);
    let addition = 0;
    const usedUpdates = new Set<string>();
    findings.forEach((finding, index) => {
      const result = byIndex.get(index);
      if (!result) throw new Error(`Reconciliation omitted ${label} index ${index}`);
      if (result.outcome === "new") {
        if (!same(additions[addition++], finding)) throw new Error(`Reconciliation ${label} addition mismatch`);
      } else {
        const poolId = result.poolId!;
        if (!ids.has(poolId)) throw new Error(`Reconciliation referenced unknown ${label} pool ID`);
        if (result.outcome === "updated") {
          const update = updates.find((entry) => entry.poolId === poolId);
          if (!update || usedUpdates.has(poolId) || !same(update.finding, finding)) {
            throw new Error(`Reconciliation ${label} update mismatch`);
          }
          usedUpdates.add(poolId);
        }
      }
    });
    if (addition !== additions.length || usedUpdates.size !== updates.length) {
      throw new Error(`Reconciliation contains unaccounted ${label} operations`);
    }
  };
  const issueIds = new Set(current.issues.map((entry) => entry.poolId));
  const gapIds = new Set(current.coverageGaps.map((entry) => entry.poolId));
  validate(report.issues, reconciliation.issueOutcomes, reconciliation.newIssues,
    reconciliation.issueUpdates, issueIds, "issue");
  validate(report.testCoverageGaps, reconciliation.coverageGapOutcomes,
    reconciliation.newCoverageGaps, reconciliation.coverageGapUpdates, gapIds, "coverage gap");
  const issueUpdates = new Map(reconciliation.issueUpdates.map((entry) => [entry.poolId, entry.finding]));
  const gapUpdates = new Map(reconciliation.coverageGapUpdates.map((entry) => [entry.poolId, entry.finding]));
  const issues = current.issues.map((entry) => issueUpdates.has(entry.poolId)
    ? { poolId: entry.poolId, ...issueUpdates.get(entry.poolId)! } : entry);
  const coverageGaps = current.coverageGaps.map((entry) => gapUpdates.has(entry.poolId)
    ? { poolId: entry.poolId, ...gapUpdates.get(entry.poolId)! } : entry);
  for (const finding of reconciliation.newIssues) issues.push({ poolId: `issue-${randomUUID()}`, ...finding });
  for (const finding of reconciliation.newCoverageGaps) {
    coverageGaps.push({ poolId: `gap-${randomUUID()}`, ...finding });
  }
  return {
    pool: { issues, coverageGaps },
    added: reconciliation.newIssues.length + reconciliation.newCoverageGaps.length,
    updated: reconciliation.issueUpdates.length + reconciliation.coverageGapUpdates.length,
  };
}

export interface LoopedReviewServiceOptions {
  autoAdvance?: boolean;
  pollIntervalMs?: number;
  missingResultPollLimit?: number;
  /** Test/recovery tuning; production defaults preserve the 15s/5s lease cadence. */
  controllerLeaseMs?: number;
  controllerRenewMs?: number;
  provider?: (workflow: LoopedReviewWorkflow) => Promise<BuildPipelineProvider>;
  providerDependencies?: Pick<ProviderDependencies, "openCodeClient" | "monitorRetryMs">;
  onInteractionObservation?: (
    event: ProviderInteractionObservationEvent & {
      environmentId: string;
      provider: LoopedReviewWorkflow["agent"];
    },
  ) => void | Promise<void>;
}

/** Backend-owned, fenced controller for every looped-review transition. */
export class LoopedReviewService {
  private readonly ownerId = randomUUID();
  private readonly interactionOwnerId = randomUUID();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private readonly leases = new Map<string, { token: string; expiresAt: string }>();
  private readonly interactionWatches = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: LoopedReviewServiceOptions = {},
  ) {}

  async init(): Promise<void> {
    this.stopped = false;
    for (const record of await this.storage.listAllLoopedReviewWorkflows()) {
      if (isLoopedReviewWorkflow(record.snapshot)) continue;
      if (isSafelyAdoptableLegacyLoopedReview(record.snapshot)) {
        await this.adoptLegacy(record).catch(() => undefined);
      }
    }
    if (this.options.autoAdvance !== false) {
      this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs ?? DEFAULT_POLL_MS);
      this.timer.unref?.();
      this.renewTimer = setInterval(
        () => void this.renewLeases(),
        this.options.controllerRenewMs ?? CONTROLLER_RENEW_MS,
      );
      this.renewTimer.unref?.();
      await this.tick();
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.timer = null;
    this.renewTimer = null;
    await Promise.allSettled([...this.locks.values()]);
    for (const stop of this.interactionWatches.values()) stop();
    this.interactionWatches.clear();
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.dispose?.()));
    this.providers.clear();
    await Promise.allSettled([...this.leases].map(([workflowId, lease]) =>
      this.storage.releaseLoopedReviewController(workflowId, this.ownerId, lease.token)));
    this.leases.clear();
  }

  async start(input: StartLoopedReviewInput): Promise<LoopedReviewWorkflow> {
    if (!isStartLoopedReviewInput(input)) throw new Error("Invalid looped review start request");
    const environment = await this.storage.getEnvironment(input.environmentId);
    if (!environment || environment.projectId !== input.projectId || environment.deletionRequestedAt) {
      throw new Error("The review environment is unavailable");
    }
    const allowance = normalizeReviewAllowance(input.allowance);
    const timestamp = nowIso();
    const workflow: LoopedReviewWorkflow = {
      version: LOOPED_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: randomUUID(),
      environmentId: input.environmentId,
      projectId: input.projectId,
      agent: input.agent,
      model: input.model,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      targetBranch: input.targetBranch,
      ...(input.reviewInstruction ? { reviewInstruction: input.reviewInstruction } : {}),
      ...(input.context ? { context: input.context } : {}),
      startingAllowance: allowance,
      currentAllowance: allowance,
      currentRound: 1,
      currentPass: 0,
      phase: "preparing",
      rounds: [{ round: 1, allowance, status: "preparing", passes: [], startedAt: timestamp }],
      activePool: emptyPool(),
      archivedPools: [],
      sessions: [],
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      pr: { status: "pending" },
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    };
    const saved = await this.storage.saveLoopedReviewWorkflow(
      workflow.id, workflow.environmentId, LOOPED_REVIEW_WORKFLOW_VERSION, workflow, 0,
    );
    workflow.backendRevision = saved.revision;
    void this.advanceNow(workflow.id);
    return workflow;
  }

  advanceNow(workflowId: string): Promise<void> {
    return this.runLocked(workflowId);
  }

  async pause(workflowId: string): Promise<LoopedReviewWorkflow> {
    return this.mutate(workflowId, (workflow) => {
      if (isLoopedReviewActivePhase(workflow.phase)) {
        workflow.pausedFromPhase = workflow.phase;
        workflow.phase = "paused";
      }
    });
  }

  async resume(workflowId: string): Promise<LoopedReviewWorkflow> {
    const workflow = await this.mutate(workflowId, (current) => {
      if (current.phase === "paused" && current.pausedFromPhase) {
        current.phase = current.pausedFromPhase;
        delete current.pausedFromPhase;
      }
    });
    void this.advanceNow(workflowId);
    return workflow;
  }

  async retry(workflowId: string): Promise<LoopedReviewWorkflow> {
    const workflow = await this.mutate(workflowId, (current) => {
      if (current.phase !== "failed" || !current.failure) return;
      const failure = current.failure;
      const preserve = failure.preserveDispatch === true && current.dispatch !== undefined;
      if (!preserve && failure.retryPhase === "discovering") {
        const round = current.rounds.find((entry) => entry.round === current.currentRound);
        if (round?.passes.some((entry) => entry.pass === current.currentPass && !entry.report)) {
          round.passes = round.passes.filter((entry) =>
            entry.pass !== current.currentPass || entry.report !== undefined);
          current.currentPass = Math.max(0, current.currentPass - 1);
        }
      }
      current.phase = failure.retryPhase;
      delete current.failure;
      delete current.structuredWait;
      if (!preserve) delete current.dispatch;
      if (failure.code === "pr") current.pr = { ...current.pr, status: "pending", error: undefined };
      const round = current.rounds.find((entry) => entry.round === current.currentRound);
      if (round) round.status = current.phase === "preparing" ? "preparing"
        : current.phase === "fixing" ? "fixing" : current.phase === "creating-pr" ? "completed" : "reviewing";
    });
    void this.advanceNow(workflowId);
    return workflow;
  }

  async cancel(workflowId: string): Promise<LoopedReviewWorkflow> {
    let providerSessionId: string | undefined;
    const workflow = await this.mutate(workflowId, (current) => {
      if (isLoopedReviewTerminalPhase(current.phase)) return;
      providerSessionId = current.sessions.find((entry) => entry.id === current.activeSessionId)?.providerSessionId;
      current.phase = "cancelled";
      delete current.pausedFromPhase;
      delete current.failure;
      delete current.dispatch;
      delete current.structuredWait;
      delete current.pendingInteractionResolution;
      for (const session of current.sessions) {
        if (session.status === "running") session.status = "cancelled";
      }
    });
    if (providerSessionId) {
      const provider = await this.provider(workflow).catch(() => null);
      await provider?.abort(providerSessionId).catch(() => undefined);
    }
    this.stopInteractionWatches(workflow);
    return workflow;
  }

  async providerSession(workflowId: string, sessionId?: string): Promise<{ providerSessionId: string } | null> {
    const record = await this.storage.getLoopedReviewWorkflow(workflowId);
    if (!record || !isLoopedReviewWorkflow(record.snapshot)) return null;
    const workflow = record.snapshot;
    const session = sessionId
      ? workflow.sessions.find((entry) => entry.id === sessionId)
      : workflow.sessions.find((entry) => entry.id === workflow.activeSessionId);
    return session ? { providerSessionId: session.providerSessionId } : null;
  }

  private async mutate(
    workflowId: string,
    update: (workflow: LoopedReviewWorkflow) => void,
  ): Promise<LoopedReviewWorkflow> {
    let result!: LoopedReviewWorkflow;
    await this.withLock(workflowId, async () => {
      const { workflow, lease } = await this.loadControlled(workflowId);
      update(workflow);
      result = await this.save(workflow, lease.token);
    });
    return result;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const records = await this.storage.listAllLoopedReviewWorkflows();
    await Promise.all(records
      .filter((record) => isLoopedReviewWorkflow(record.snapshot)
        && !isLoopedReviewTerminalPhase(record.snapshot.phase))
      .map((record) => this.runLocked(record.id)));
  }

  private runLocked(workflowId: string): Promise<void> {
    return this.withLock(workflowId, async () => {
      try {
        await this.advance(workflowId);
      } catch (error) {
        await this.fail(workflowId, error).catch(() => undefined);
      }
    });
  }

  private withLock(workflowId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(workflowId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(workflowId, current);
    void current.finally(() => {
      if (this.locks.get(workflowId) === current) this.locks.delete(workflowId);
    });
    return current;
  }

  private async advance(workflowId: string): Promise<void> {
    const { workflow, lease } = await this.loadControlled(workflowId);
    if (!isLoopedReviewActivePhase(workflow.phase)) return;
    const provider = await this.provider(workflow);
    this.registerSessions(workflow, provider);
    const active = workflow.sessions.find((entry) => entry.id === workflow.activeSessionId);
    if (active && await this.enforceInteraction(workflow, active, provider, lease.token)) return;
    if (!workflow.dispatch) {
      await this.startCurrentPhase(workflow, provider, lease.token);
      return;
    }
    const dispatch = workflow.dispatch;
    const session = workflow.sessions.find((entry) => entry.id === dispatch.sessionId);
    if (!session) throw new Error("Active dispatch lost its provider session");
    if (await this.enforceInteraction(workflow, session, provider, lease.token)) return;
    if (dispatch.state === "prepared") {
      dispatch.state = "dispatching";
      await this.save(workflow, lease.token);
      await this.assertFence(workflow.id, lease.token);
      const material = this.dispatchMaterial(workflow, dispatch);
      try {
        await provider.send(session.providerSessionId,
          `${material.prompt}\n\n${UNATTENDED_POLICY_INSTRUCTION}`, {
            requestId: dispatch.requestId,
            schema: material.schema,
            mode: executionMode(session.phase),
            model: workflow.model === "default" ? undefined : workflow.model,
            effort: workflow.reasoningEffort,
          });
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) return;
        throw new DefiniteDispatchError(message(error));
      }
      await this.assertFence(workflow.id, lease.token);
      dispatch.state = "sent";
      await this.save(workflow, lease.token);
      return;
    }
    const result = await provider.structured<unknown>(session.providerSessionId, dispatch.requestId);
    await this.assertFence(workflow.id, lease.token);
    if (result) {
      await this.applyResult(workflow, session, dispatch, result, lease.token);
      return;
    }
    const status = await provider.status(session.providerSessionId);
    await this.assertFence(workflow.id, lease.token);
    if (status === "blocked") {
      // An authoritative interaction snapshot was already checked above. A
      // provider that still reports blocked cannot be left busy indefinitely.
      throw new Error("Native provider is blocked without a resolvable interaction");
    }
    if (status === "error") throw new Error("Native provider failed before returning structured output");
    if (status === "missing") throw new MissingProviderSessionError();
    if (status === "idle") {
      const wait = workflow.structuredWait?.dispatchId === dispatch.id
        ? workflow.structuredWait
        : { dispatchId: dispatch.id, startedAt: nowIso(), idlePolls: 0 };
      wait.idlePolls += 1;
      workflow.structuredWait = wait;
      if (wait.idlePolls >= (this.options.missingResultPollLimit ?? DEFAULT_MISSING_RESULT_POLLS)) {
        throw new Error("Native provider completed without a structured result");
      }
      await this.save(workflow, lease.token);
    }
  }

  private async startCurrentPhase(
    workflow: LoopedReviewWorkflow,
    provider: BuildPipelineProvider,
    token: string,
  ): Promise<void> {
    let phase: LoopedReviewSessionPhase;
    let pass: number | undefined;
    if (workflow.phase === "preparing") phase = "preparation";
    else if (workflow.phase === "discovering") { phase = "discovery"; pass = workflow.currentPass + 1; }
    else if (workflow.phase === "reconciling") {
      const current = workflow.sessions.find((entry) => entry.id === workflow.activeSessionId);
      if (!current || current.phase !== "discovery") throw new Error("Reconciliation lost its discovery session");
      await this.prepareDispatch(workflow, current, token);
      return;
    } else if (workflow.phase === "fixing") {
      if (!hasReviewFindings(workflow.activePool)) throw new Error("Fixing phase has no active findings");
      phase = "fix";
    } else {
      if (hasReviewFindings(workflow.activePool)) throw new Error("PR creation is blocked by active findings");
      phase = "pr";
    }
    const sessionKey = `looped-review:${workflow.id}:${phase}:round-${workflow.currentRound}:pass-${pass ?? 0}`;
    let session = workflow.sessions.find((entry) => entry.sessionKey === sessionKey);
    if (!session) {
      const providerSessionId = await provider.createSession(providerPhase(phase),
        sessionLabel(phase, workflow.currentRound, pass), {
          clientSessionKey: sessionKey,
          mode: executionMode(phase),
          model: workflow.model === "default" ? undefined : workflow.model,
          effort: workflow.reasoningEffort,
          interaction: {
            origin: "looped-review",
            interactionPolicy: workflow.interactionPolicy,
            phase,
            workflowId: workflow.id,
            provider: workflow.agent,
            fence: token,
          },
        });
      await this.assertFence(workflow.id, token);
      session = {
        id: randomUUID(), phase, round: workflow.currentRound, ...(pass ? { pass } : {}),
        sessionKey, providerSessionId, requestIds: [], origin: "looped-review",
        interactionPolicy: workflow.interactionPolicy, status: "running", startedAt: nowIso(),
      };
      workflow.sessions.push(session);
    } else {
      session.status = "running";
      delete session.error;
      delete session.completedAt;
    }
    workflow.activeSessionId = session.id;
    if (phase === "discovery") {
      workflow.currentPass = pass!;
      const round = workflow.rounds.find((entry) => entry.round === workflow.currentRound);
      if (!round?.passes.some((entry) => entry.pass === pass! && entry.sessionId === session.id)) {
        round?.passes.push({
          pass: pass!, sessionId: session.id, status: "discovering", startedAt: nowIso(),
        });
      }
    }
    if (phase === "pr") workflow.pr = { status: "running", sessionId: session.id };
    await this.save(workflow, token);
    await this.prepareDispatch(workflow, session, token);
  }

  private async prepareDispatch(
    workflow: LoopedReviewWorkflow,
    session: LoopedReviewSession,
    token: string,
  ): Promise<void> {
    const phase = workflow.phase;
    if (!isLoopedReviewActivePhase(phase)) return;
    const requestId = randomUUID();
    workflow.dispatch = {
      id: randomUUID(), requestId, sessionId: session.id, phase,
      kind: dispatchKind(phase), state: "prepared", createdAt: nowIso(),
    };
    if (!session.requestIds.includes(requestId)) session.requestIds.push(requestId);
    session.status = "running";
    delete session.error;
    delete session.completedAt;
    delete workflow.structuredWait;
    await this.save(workflow, token);
  }

  private dispatchMaterial(
    workflow: LoopedReviewWorkflow,
    dispatch: LoopedReviewDispatch,
  ): { prompt: string; schema: JsonSchema } {
    const round = workflow.rounds.find((entry) => entry.round === workflow.currentRound);
    if (dispatch.kind === "prepare") return {
      prompt: createReviewPreparationPrompt({
        round: workflow.currentRound,
        packageId: `review-package-${workflow.id}-r${workflow.currentRound}`,
        targetBranch: workflow.targetBranch,
        context: workflow.context,
      }),
      schema: REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
    };
    if (dispatch.kind === "discover") {
      if (!round?.package) throw new Error("Current round has no review package");
      return { prompt: createDiscoveryPrompt({ reviewPackage: round.package,
        reviewInstruction: workflow.reviewInstruction }),
        schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema };
    }
    if (dispatch.kind === "reconcile") {
      const pass = round?.passes.find((entry) => entry.pass === workflow.currentPass
        && entry.sessionId === dispatch.sessionId);
      if (!pass?.report) throw new Error("Current pass has no validated report");
      return { prompt: createReconciliationPrompt({ report: pass.report, pool: workflow.activePool }),
        schema: LOOPED_REVIEW_RECONCILIATION_JSON_SCHEMA };
    }
    if (dispatch.kind === "fix") return {
      prompt: createFixPoolPrompt({ pool: workflow.activePool, targetBranch: workflow.targetBranch }),
      schema: REVIEW_FIX_RESULT_JSON_SCHEMA,
    };
    return {
      prompt: `${prPrompt(workflow.targetBranch)}\n\nReturn the PR URL using the enforced structured result.`,
      schema: REVIEW_PR_RESULT_JSON_SCHEMA,
    };
  }

  private async applyResult(
    workflow: LoopedReviewWorkflow,
    session: LoopedReviewSession,
    dispatch: LoopedReviewDispatch,
    result: StructuredOutputResult<unknown>,
    token: string,
  ): Promise<void> {
    if (!result.ok) throw new DefiniteResultError(result.error.message);
    const timestamp = nowIso();
    session.status = "idle";
    if (dispatch.kind !== "discover") session.completedAt = timestamp;
    delete workflow.structuredWait;
    if (dispatch.kind === "prepare") {
      const preparation = parseReviewPreparationResult(result.value);
      const packageId = `review-package-${workflow.id}-r${workflow.currentRound}`;
      const generated = await this.invoke<unknown>("generate_looped_review_package", {
        environmentId: workflow.environmentId, packageId, round: workflow.currentRound,
        targetBranch: workflow.targetBranch, preparation,
      });
      await this.assertFence(workflow.id, token);
      const prepared = reviewPackage(generated, {
        id: packageId, round: workflow.currentRound, targetBranch: workflow.targetBranch,
        context: workflow.context,
      });
      const round = workflow.rounds.find((entry) => entry.round === workflow.currentRound)!;
      round.package = prepared;
      round.status = "reviewing";
      workflow.phase = "discovering";
      workflow.currentPass = 0;
      delete workflow.dispatch;
    } else if (dispatch.kind === "discover") {
      const report = parseStructuredReviewReport(result.value);
      const pass = workflow.rounds.find((entry) => entry.round === workflow.currentRound)?.passes
        .find((entry) => entry.pass === workflow.currentPass && entry.sessionId === session.id);
      if (!pass) throw new Error("Discovery result lost its active pass");
      pass.report = report;
      pass.status = "reconciling";
      workflow.phase = "reconciling";
      delete workflow.dispatch;
    } else if (dispatch.kind === "reconcile") {
      const reconciliation = parseReconciliation(result.value);
      const pass = workflow.rounds.find((entry) => entry.round === workflow.currentRound)?.passes
        .find((entry) => entry.pass === workflow.currentPass && entry.sessionId === session.id);
      if (!pass?.report) throw new Error("Reconciliation lost its validated report");
      const applied = applyReconciliation(workflow.activePool, pass.report, reconciliation);
      workflow.activePool = applied.pool;
      pass.reconciliation = reconciliation;
      pass.status = "completed";
      pass.completedAt = timestamp;
      const stop = applied.added + applied.updated === 0
        || workflow.currentPass >= workflow.currentAllowance;
      const round = workflow.rounds.find((entry) => entry.round === workflow.currentRound)!;
      if (stop) {
        workflow.phase = hasReviewFindings(applied.pool) ? "fixing" : "creating-pr";
        round.status = hasReviewFindings(applied.pool) ? "fixing" : "completed";
        if (!hasReviewFindings(applied.pool)) round.completedAt = timestamp;
      } else workflow.phase = "discovering";
      delete workflow.dispatch;
    } else if (dispatch.kind === "fix") {
      const fixed = parseFixResult(result.value);
      if (!fixed.complete) throw new Error(`The fix session did not resolve the active pool: ${fixed.summary}`);
      workflow.archivedPools.push({
        round: workflow.currentRound, fixedAt: timestamp, fixSessionId: session.id,
        pool: workflow.activePool, fixSummary: fixed.summary, fixNotes: fixed.notes,
      });
      const round = workflow.rounds.find((entry) => entry.round === workflow.currentRound)!;
      round.status = "completed";
      round.completedAt = timestamp;
      workflow.activePool = emptyPool();
      delete workflow.dispatch;
      if (workflow.currentAllowance === 1) workflow.phase = "creating-pr";
      else {
        workflow.currentAllowance = nextReviewAllowance(workflow.currentAllowance);
        workflow.currentRound += 1;
        workflow.currentPass = 0;
        workflow.phase = "preparing";
        workflow.rounds.push({
          round: workflow.currentRound, allowance: workflow.currentAllowance,
          status: "preparing", passes: [], startedAt: timestamp,
        });
        delete workflow.activeSessionId;
      }
    } else {
      const pr = parsePrResult(result.value);
      const verified = await this.invoke<{ url: string }>("verify_environment_pr", {
        environmentId: workflow.environmentId, prUrl: pr.url, targetBranch: workflow.targetBranch,
      });
      await this.assertFence(workflow.id, token);
      workflow.phase = "completed";
      workflow.pr = { ...workflow.pr, status: "created", url: verified.url, error: undefined };
      delete workflow.dispatch;
    }
    await this.save(workflow, token);
    if (isLoopedReviewTerminalPhase(workflow.phase)) this.stopInteractionWatches(workflow);
  }

  private async provider(workflow: LoopedReviewWorkflow): Promise<BuildPipelineProvider> {
    const key = `${workflow.environmentId}:${workflow.agent}`;
    const cached = this.providers.get(key);
    if (cached) return cached;
    if (this.options.provider) {
      const provider = await this.options.provider(workflow);
      this.providers.set(key, provider);
      return provider;
    }
    const environment = await this.storage.getEnvironment(workflow.environmentId);
    if (!environment) throw new Error("Review environment no longer exists");
    const connection = await this.bridgeConnection(workflow.agent, environment);
    const provider = createBuildPipelineProvider({
      ...connection,
      model: workflow.model === "default" ? undefined : workflow.model,
      effort: workflow.reasoningEffort,
    }, {
      ...this.options.providerDependencies,
      autoAnswerRequests: false,
      onInteractionObservation: async (event) => {
        try {
          await this.options.onInteractionObservation?.({
            ...event, environmentId: workflow.environmentId, provider: workflow.agent,
          });
        } catch { /* diagnostics never control the workflow */ }
      },
    });
    this.providers.set(key, provider);
    return provider;
  }

  private registerSessions(workflow: LoopedReviewWorkflow, provider: BuildPipelineProvider): void {
    for (const session of workflow.sessions) {
      provider.registerSession?.(session.providerSessionId, {
        origin: "looped-review", interactionPolicy: workflow.interactionPolicy,
        phase: session.phase, workflowId: workflow.id, provider: workflow.agent,
        fence: workflow.controllerFence ?? session.sessionKey,
      });
      if (!this.interactionWatches.has(session.sessionKey) && provider.interactions?.watchInteractions) {
        // Subscribe before the first recovery snapshot so an update between
        // registration and calculation is followed by another supervisor pass.
        const stop = provider.interactions.watchInteractions(session.providerSessionId, () => {
          void this.advanceNow(workflow.id);
        });
        this.interactionWatches.set(session.sessionKey, stop);
      }
    }
  }

  private stopInteractionWatches(workflow: LoopedReviewWorkflow): void {
    for (const session of workflow.sessions) {
      this.interactionWatches.get(session.sessionKey)?.();
      this.interactionWatches.delete(session.sessionKey);
    }
  }

  private async bridgeConnection(
    agent: LoopedReviewWorkflow["agent"],
    environment: Environment,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${suffix}_server_cmd`, { environmentId: environment.id });
      if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
      return { agent, baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken, directory: environment.worktreePath };
    }
    if (!environment.containerId) throw new Error("Review container is unavailable");
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${suffix}_server`, { containerId: environment.containerId });
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return { agent, baseUrl: `http://127.0.0.1:${result.hostPort}`, authToken: result.authToken };
  }

  private interactionPresentation(
    request: AgentInteractionRequest,
    session: LoopedReviewSession,
    journalId: string,
    claimedAt: number,
    action: PendingLoopedReviewInteractionResolution["action"],
  ): PendingLoopedReviewInteractionResolution {
    const visible = action === "decline-and-continue";
    const truncate = (text: string, limit: number) => text.length <= limit
      ? text : `${text.slice(0, limit - 1)}…`;
    return {
      journalId, sessionKey: session.sessionKey, sessionId: session.providerSessionId,
      interactionId: request.id, provider: request.provider, kind: request.kind,
      phase: session.phase, requestedAt: Math.min(request.createdAt, claimedAt), claimedAt,
      action,
      title: visible ? truncate(request.presentation.title, 512)
        : `Unexpected ${request.provider} ${request.kind} authorization`,
      ...(visible && request.presentation.body
        ? { body: truncate(request.presentation.body, 1_024) } : {}),
      questions: visible ? request.presentation.questions.slice(0, 4).map((question) => ({
        prompt: truncate(question.prompt, 512),
        options: question.options.slice(0, 8).map((option) => truncate(option.label, 128)),
      })) : [],
    };
  }

  private async enforceInteraction(
    workflow: LoopedReviewWorkflow,
    session: LoopedReviewSession,
    provider: BuildPipelineProvider,
    token: string,
  ): Promise<boolean> {
    if (!provider.interactions) return false;
    const snapshot = await provider.interactions.listPendingInteractions(session.providerSessionId);
    let pending = workflow.pendingInteractionResolution;
    let journal = await this.storage.getAgentInteractionResolutionJournal();
    let entry = pending ? journal.entries.find((item) => item.id === pending!.journalId) : undefined;
    if (!pending) {
      entry = journal.entries.find((item) => item.claim.workflowType === "looped-review"
        && item.claim.workflowId === workflow.id && item.claim.fence === session.sessionKey
        && item.state !== "workflow-recorded");
      const request = entry
        ? snapshot.requests.find((item) => item.id === entry!.interactionId)
        : snapshot.requests[0];
      if (!request && !entry) return false;
      if (!entry) {
        const action = agentInteractionPolicyAction(workflow.interactionPolicy, request!.kind);
        if (action === "await-user") return false;
        const claimedAt = Date.now();
        let claimed!: AgentInteractionResolutionJournalEntry;
        await this.storage.updateAgentInteractionResolutionJournal((current) => {
          const existing = current.entries.find((item) => item.sessionId === session.providerSessionId
            && item.interactionId === request!.id);
          if (existing) { claimed = existing; return current; }
          claimed = {
            id: randomUUID(), interactionId: request!.id, provider: request!.provider,
            kind: request!.kind, sessionId: session.providerSessionId, state: "claimed",
            claim: { workflowType: "looped-review", workflowId: workflow.id,
              phase: session.phase, fence: session.sessionKey, claimedAt },
          };
          return { version: AGENT_INTERACTION_JOURNAL_VERSION, entries: [...current.entries, claimed] };
        });
        entry = claimed;
      }
      const action = agentInteractionPolicyAction(workflow.interactionPolicy, entry.kind);
      pending = request
        ? this.interactionPresentation(request, session, entry.id, entry.claim.claimedAt,
          action === "decline-and-continue" ? "decline-and-continue" : "deny-and-fail")
        : {
            journalId: entry.id, sessionKey: session.sessionKey, sessionId: session.providerSessionId,
            interactionId: entry.interactionId, provider: entry.provider, kind: entry.kind,
            phase: session.phase, requestedAt: entry.claim.claimedAt, claimedAt: entry.claim.claimedAt,
            action: action === "decline-and-continue" ? "decline-and-continue" : "deny-and-fail",
            title: "Provider interaction recovered after restart", questions: [],
          };
      workflow.pendingInteractionResolution = pending;
      await this.save(workflow, token);
      journal = await this.storage.getAgentInteractionResolutionJournal();
      entry = journal.entries.find((item) => item.id === pending!.journalId);
    }
    if (!entry) {
      await this.recordInteraction(workflow, session, pending, "failed", token);
      return true;
    }
    if (entry.state === "workflow-recorded" || entry.state === "provider-resolved") {
      await this.recordInteraction(workflow, session, pending, entry.outcome ?? "failed", token);
      return true;
    }
    const processingToken = await this.acquireInteractionLease(entry.id);
    if (!processingToken) return true;
    const current = await provider.interactions.listPendingInteractions(session.providerSessionId);
    const live = current.requests.some((item) => item.id === pending!.interactionId);
    const resolvedAt = Date.now();
    let outcome: AgentInteractionOutcome;
    if (!live) outcome = pending.action === "decline-and-continue" ? "auto-declined" : "denied";
    else {
      const applied = await provider.interactions.resolveInteraction(session.providerSessionId,
        pending.interactionId, {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: pending.interactionId,
          sessionId: session.providerSessionId,
          action: pending.action === "decline-and-continue" ? "decline" : "deny",
          resolvedAt,
        });
      let terminal = applied.result === "applied";
      if (applied.result === "already-resolved" || applied.result === "stale") {
        const reconciled = await provider.interactions.listPendingInteractions(session.providerSessionId);
        terminal = !reconciled.requests.some((item) => item.id === pending!.interactionId);
      }
      outcome = terminal ? (pending.action === "decline-and-continue" ? "auto-declined" : "denied") : "failed";
    }
    let recorded = false;
    await this.storage.updateAgentInteractionResolutionJournal((current) => ({
      ...current,
      entries: current.entries.map((item) => {
        if (item.id !== entry!.id || item.state !== "claimed"
          || item.processing?.ownerId !== this.interactionOwnerId
          || item.processing.token !== processingToken) return item;
        recorded = true;
        const { processing: _processing, ...rest } = item;
        return { ...rest, state: "provider-resolved" as const, outcome,
          providerResolvedAt: Math.max(resolvedAt, item.claim.claimedAt) };
      }),
    }));
    if (!recorded) return true;
    await this.recordInteraction(workflow, session, pending, outcome, token);
    if (outcome !== "auto-declined") await provider.abort(session.providerSessionId).catch(() => undefined);
    return true;
  }

  private async acquireInteractionLease(journalId: string): Promise<string | null> {
    const proposed = randomUUID();
    let acquired: string | null = null;
    const wallClock = Date.now();
    await this.storage.updateAgentInteractionResolutionJournal((journal) => ({
      ...journal,
      entries: journal.entries.map((entry) => {
        if (entry.id !== journalId || entry.state !== "claimed") return entry;
        if (entry.processing?.ownerId === this.interactionOwnerId) {
          acquired = entry.processing.token;
          return entry;
        }
        if (entry.processing && entry.processing.expiresAt > wallClock) return entry;
        const now = Math.max(wallClock, entry.claim.claimedAt);
        acquired = proposed;
        return { ...entry, processing: { ownerId: this.interactionOwnerId,
          token: proposed, acquiredAt: now, expiresAt: now + INTERACTION_PROCESSING_LEASE_MS } };
      }),
    }));
    return acquired;
  }

  private appendSummary(
    summary: AgentInteractionWorkflowSummary | undefined,
    pending: PendingLoopedReviewInteractionResolution,
    outcome: AgentInteractionOutcome,
    rawResolvedAt: number,
  ): AgentInteractionWorkflowSummary {
    const resolvedAt = Math.max(rawResolvedAt, pending.requestedAt);
    const next = summary ? structuredClone(summary)
      : { version: AGENT_INTERACTION_SUMMARY_VERSION, entries: [] };
    const existing = next.entries.find((entry) => entry.provider === pending.provider
      && entry.kind === pending.kind && entry.phase === pending.phase
      && entry.sessionId === pending.sessionId && entry.outcome === outcome);
    if (existing) {
      existing.count += 1;
      existing.lastResolvedAt = Math.max(existing.lastResolvedAt ?? 0, resolvedAt);
    } else if (next.entries.length < AGENT_INTERACTION_LIMITS.maxWorkflowSummaries) {
      next.entries.push({ provider: pending.provider, kind: pending.kind, phase: pending.phase,
        sessionId: pending.sessionId, firstSeenAt: pending.requestedAt,
        lastResolvedAt: resolvedAt, outcome, count: 1 });
    }
    return next;
  }

  private async recordInteraction(
    workflow: LoopedReviewWorkflow,
    session: LoopedReviewSession,
    pending: PendingLoopedReviewInteractionResolution,
    outcome: AgentInteractionOutcome,
    token: string,
  ): Promise<void> {
    const resolvedAt = Date.now();
    const continued = pending.action === "decline-and-continue" && outcome === "auto-declined";
    session.interactionSummary = this.appendSummary(session.interactionSummary, pending, outcome, resolvedAt);
    workflow.interactionSummary = this.appendSummary(workflow.interactionSummary, pending, outcome, resolvedAt);
    if (continued) {
      const history = session.interactionTranscript ?? [];
      if (!history.some((entry) => entry.id === pending.interactionId)) {
        const item: LoopedReviewInteractionTranscriptEntry = {
          id: pending.interactionId, provider: pending.provider, kind: pending.kind,
          phase: pending.phase, requestedAt: pending.requestedAt,
          resolvedAt: Math.max(resolvedAt, pending.requestedAt),
          outcome: "auto-declined-headless", title: pending.title,
          ...(pending.body ? { body: pending.body } : {}), questions: pending.questions,
        };
        session.interactionTranscript = [...history, item]
          .slice(-AGENT_INTERACTION_LIMITS.maxWorkflowSummaries);
        session.autoDeclineCount = (session.autoDeclineCount ?? 0) + 1;
        workflow.autoDeclineCount = (workflow.autoDeclineCount ?? 0) + 1;
      }
      delete workflow.pendingInteractionResolution;
    } else {
      const retryPhase = isLoopedReviewActivePhase(workflow.phase)
        ? workflow.phase : workflow.pausedFromPhase ?? "preparing";
      workflow.phase = "failed";
      workflow.failure = {
        code: "interactive-request",
        message: pending.action === "deny-and-fail" && outcome === "denied"
          ? `The ${sessionLabel(session.phase, session.round, session.pass)} requested unexpected authorization`
          : "A provider interaction could not be resolved safely",
        retryPhase,
        occurredAt: nowIso(),
        interaction: { requestId: pending.interactionId, sessionId: session.providerSessionId,
          provider: pending.provider, kind: pending.kind },
      };
      session.status = "error";
      delete workflow.pendingInteractionResolution;
      delete workflow.dispatch;
      delete workflow.structuredWait;
    }
    await this.save(workflow, token);
    await this.storage.updateAgentInteractionResolutionJournal((journal) => ({
      ...journal,
      entries: journal.entries.map((entry) => entry.id === pending.journalId
        && entry.state === "provider-resolved" && entry.providerResolvedAt !== undefined
        ? { ...entry, state: "workflow-recorded" as const,
            workflowRecordedAt: Math.max(Date.now(), entry.providerResolvedAt) }
        : entry),
    })).catch(() => undefined);
    console.info("[looped-review] interaction resolved", {
      provider: pending.provider, kind: pending.kind, phase: pending.phase, outcome,
      latencyMs: Math.max(0, resolvedAt - pending.requestedAt),
      count: workflow.autoDeclineCount ?? 0,
    });
  }

  private async loadControlled(workflowId: string): Promise<{
    workflow: LoopedReviewWorkflow;
    lease: { token: string; expiresAt: string };
  }> {
    const record = await this.storage.getLoopedReviewWorkflow(workflowId);
    if (!record || !isLoopedReviewWorkflow(record.snapshot)) {
      throw new Error(`Backend-owned looped review not found: ${workflowId}`);
    }
    const claimed = await this.storage.claimLoopedReviewController(
      workflowId, this.ownerId, this.controllerLeaseMs());
    if (!claimed.granted || !claimed.token) throw new ControllerFenceError();
    const lease = { token: claimed.token, expiresAt: claimed.expiresAt };
    this.leases.set(workflowId, lease);
    const workflow = structuredClone(record.snapshot);
    workflow.backendRevision = record.revision;
    if (workflow.controllerFence !== lease.token) {
      workflow.controllerFence = lease.token;
      return { workflow: await this.save(workflow, lease.token), lease };
    }
    return { workflow, lease };
  }

  private async save(workflow: LoopedReviewWorkflow, token: string): Promise<LoopedReviewWorkflow> {
    await this.assertFence(workflow.id, token);
    workflow.updatedAt = nowIso();
    workflow.controllerFence = token;
    const saved = await this.storage.saveLoopedReviewWorkflow(
      workflow.id, workflow.environmentId, LOOPED_REVIEW_WORKFLOW_VERSION,
      workflow, workflow.backendRevision, { ownerId: this.ownerId, token },
    );
    workflow.backendRevision = saved.revision;
    return workflow;
  }

  private async assertFence(workflowId: string, token: string): Promise<void> {
    if (!await this.storage.validateLoopedReviewController(workflowId, this.ownerId, token)) {
      throw new ControllerFenceError();
    }
  }

  private async renewLeases(): Promise<void> {
    if (this.stopped) return;
    for (const [workflowId, lease] of this.leases) {
      const claimed = await this.storage.claimLoopedReviewController(
        workflowId, this.ownerId, this.controllerLeaseMs()).catch(() => null);
      if (!claimed?.granted || claimed.token !== lease.token) this.leases.delete(workflowId);
      else this.leases.set(workflowId, { token: claimed.token, expiresAt: claimed.expiresAt });
    }
  }

  private async fail(workflowId: string, error: unknown): Promise<void> {
    if (error instanceof ControllerFenceError) return;
    const record = await this.storage.getLoopedReviewWorkflow(workflowId);
    if (!record || !isLoopedReviewWorkflow(record.snapshot)
      || !isLoopedReviewActivePhase(record.snapshot.phase)) return;
    const workflow = structuredClone(record.snapshot);
    workflow.backendRevision = record.revision;
    const claimed = await this.storage.claimLoopedReviewController(
      workflowId, this.ownerId, this.controllerLeaseMs());
    if (!claimed.granted || !claimed.token) return;
    const session = workflow.sessions.find((entry) => entry.id === workflow.activeSessionId);
    if (session) {
      session.status = "error";
      session.error = message(error);
      session.completedAt = nowIso();
    }
    const preserve = !(error instanceof DefiniteResultError)
      && !(error instanceof DefiniteDispatchError)
      && !(error instanceof MissingProviderSessionError)
      && workflow.dispatch?.state !== "prepared";
    workflow.failure = {
      code: failureKind(workflow.dispatch?.kind), message: message(error),
      retryPhase: workflow.phase as ActiveLoopedReviewPhase,
      preserveDispatch: preserve,
      occurredAt: nowIso(),
    };
    workflow.phase = "failed";
    const round = workflow.rounds.find((entry) => entry.round === workflow.currentRound);
    if (round) round.status = "failed";
    if (!preserve) delete workflow.dispatch;
    await this.save(workflow, claimed.token);
  }

  private async adoptLegacy(record: PersistedLoopedReviewWorkflow): Promise<void> {
    const source = record.snapshot as Record<string, unknown>;
    const sessions = Array.isArray(source.sessions) ? source.sessions.map((value) => {
      const session = value as Record<string, unknown>;
      return {
        ...session,
        sessionKey: typeof session.providerSessionId === "string"
          ? `legacy:${record.id}:${session.providerSessionId}` : `legacy:${record.id}:${randomUUID()}`,
        origin: "looped-review" as const,
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      };
    }) : [];
    const adopted = {
      ...source,
      version: LOOPED_REVIEW_WORKFLOW_VERSION,
      controller: "backend" as const,
      sessions,
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      backendRevision: record.revision,
    };
    if (!isLoopedReviewWorkflow(adopted)) return;
    const claimed = await this.storage.claimLoopedReviewController(
      record.id, this.ownerId, this.controllerLeaseMs(),
    );
    if (!claimed.granted || !claimed.token) return;
    adopted.controllerFence = claimed.token;
    await this.storage.saveLoopedReviewWorkflow(record.id, record.environmentId,
      LOOPED_REVIEW_WORKFLOW_VERSION, adopted, record.revision,
      { ownerId: this.ownerId, token: claimed.token });
  }

  private controllerLeaseMs(): number {
    return this.options.controllerLeaseMs ?? CONTROLLER_LEASE_MS;
  }
}

class ControllerFenceError extends Error {}
class DefiniteDispatchError extends Error {}
class DefiniteResultError extends Error {}
class MissingProviderSessionError extends ProviderUnavailableError {
  constructor() { super("The native provider session no longer exists; retry creates a replacement"); }
}

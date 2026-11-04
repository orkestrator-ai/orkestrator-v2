/**
 * Suborks (`docs/architecture/suborks.md`): the backend owns a call from
 * `ask_agents` to the mail that carries its answers home.
 *
 * `ask` resolves the targets, stores one row and returns at once, so no provider
 * tool timeout can cut a call short. Each row then advances on its own timer on
 * the shared agent branch runner, in parallel across its targets and independent
 * of any mounted tab. When every target has settled, the answers go to the
 * caller's mailbox as one workflow notice, whose route wakes it. Every step of
 * that is on the row, so a backend restart resumes the same turns and a repeat of
 * the send is the same mail (`requestId` is the call).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_PLATFORM_LABELS,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  agentPolicyEnforcement,
  coordinatorEnforcementPolicy,
  type AgentEnforcementHost,
} from "@orkestrator/protocol/graphs/capability-profiles";
import { AgentMailError } from "@orkestrator/protocol/agent-mail";
import type { AgentSettingsTiers } from "@orkestrator/protocol/agent-settings";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  renderSuborkDeliveryBody,
  resolveSuborkTarget,
  SUBORK_LIMITS,
  SUBORK_RESULT_KIND,
  suborkDefaultName,
  suborkOneLine,
  type NativeAgentSuborkBatchView,
  type NativeAgentSuborkView,
  type SuborkDeliveryEntry,
  type SuborkStatus,
  type SuborkTargetRequest,
} from "@orkestrator/protocol/suborks";
import type { WorkflowResultKind } from "@orkestrator/protocol/workflow-results";
import { isAgentBranchFenceError } from "./agent-branch-commits.js";
import { AgentBranchRunner } from "./agent-branch-runner.js";
import { agentBranchSettled, type AgentBranchPollGate } from "./agent-branch-types.js";
import type { GraphAgentProviders } from "./graph-agent-providers.js";
import { createGraphRunTranscriptCapture } from "./graph-run-transcripts.js";
import type { AppConfig, Environment } from "./models.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import {
  SuborkBranchHost,
  SuborkFenceError,
  type SuborkHostDependencies,
} from "./native-agent-subork-host.js";
import {
  SUBORK_BATCH_VERSION,
  SuborkStorageError,
  type PersistedSuborkBatch,
  type PersistedSuborkBranch,
  type PersistedSuborkRefusal,
  type SuborksStorage,
} from "./storage-suborks.js";
import type { StorageService } from "./storage.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import type { RecordUsageTurnsInput } from "./usage-history-store.js";
import { ElapsedPollGate } from "./workflow-poll-gate.js";
import type { WorkflowResultService } from "./workflow-result-service.js";
import {
  readOnlyAcceptanceCheck,
  WorkspaceBaselineUnavailableError,
  WorkspaceReadOnlyGuard,
  WorkspaceReadOnlyViolationError,
  type ReadOnlyGuardSubject,
  type WorkspaceSnapshotProbe,
} from "./workspace-read-only-guard.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("native-agent.subork");

/** Spacing between looks at a running call. */
export const SUBORK_POLL_MS = 3_000;
/** How often the sweep checks that running calls still have a caller. */
const SWEEP_INTERVAL_MS = 5_000;
/** How long stopping a session may wait on a bridge that does not answer. */
const STOP_TIMEOUT_MS = 15_000;
/** Consecutive failed passes (not an agent's failures) before a call's targets are failed. */
const MAX_PASS_FAILURES = 20;
/** Delivery attempts before the failure is reported on the rows. */
const MAX_DELIVERY_FAILURES = 20;
const MAX_PENDING_CONSUMPTIONS = 64;

/** A refused call: the tool reports the message to the agent. */
export class SuborkRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuborkRefusedError";
  }
}

/** How a guarded subork is named in the guard's errors and refusals. */
export const SUBORK_READ_ONLY_SUBJECT: ReadOnlyGuardSubject = {
  stage: "This subork's answer",
  activity: "the subork",
};

/** Who is asking, as the tool's credential established. */
export interface SuborkCaller {
  /** The caller's own environment: a coordinator conversation's runtime id for a coordinator. */
  environmentId: string;
  projectId: string;
  tabId: string;
  agent: AgentPlatform;
  /** Where the suborks run, when not in `environmentId`: a coordinator's project home. */
  runEnvironmentId?: string;
  /** The caller's logical session key, when it is not the tab key `env-<environment>:<tab>`. */
  logicalSessionKey?: string;
  /** This tab's delivery is Off: its mail waits in the inbox and does not wake it. */
  inboxOnly?: boolean;
}

export interface SuborkAskInput {
  targets: readonly SuborkTargetRequest[];
  prompt?: string;
  requestId?: string;
}

/** What the tool returns: a handle, never the answers. */
export interface SuborkAskResult {
  batchId: string;
  suborks: {
    id: string;
    name: string;
    agent?: AgentPlatform;
    model?: string;
    status: SuborkStatus;
    error?: string;
    readOnly?: string;
    /** Its answer stands only if the workspace's Git state is unchanged afterwards. */
    guarded?: boolean;
  }[];
  next: string;
}

export interface NativeAgentSuborkServiceOptions {
  storage: {
    getEnvironment(environmentId: string): Promise<Environment | null>;
    loadConfig(): Promise<Pick<AppConfig, "global">>;
    getNativeAgentSession(key: string): Promise<unknown>;
    sendAgentMail: StorageService["sendAgentMail"];
    discardAgentMail: StorageService["discardAgentMail"];
    getAgentMailStatus: StorageService["getAgentMailStatus"];
    recordAgentUsageTurns?(input: RecordUsageTurnsInput): number;
    suborks: SuborksStorage;
  };
  providers: GraphAgentProviders;
  workflowResults?: SuborkHostDependencies["workflowResults"];
  agentTools?: SuborkHostDependencies["agentTools"];
  assertAgentToolsReachable?(environmentId: string, stage: string): Promise<void>;
  rollout?: {
    refresh(): Promise<void>;
    allows(provider: AgentPlatform, kind: WorkflowResultKind): boolean;
  };
  /** The environment's model catalogue, as a launcher reads it. */
  modelCatalog(environmentId: string): Promise<AgentModel[]>;
  settingsTiers(environment: Environment): Promise<AgentSettingsTiers>;
  /** What the read-only tier may assume about the host. */
  enforcementHost(environment: Environment): AgentEnforcementHost;
  /**
   * Observes an environment's Git state for the read-only guard on suborks
   * whose provider cannot enforce read-only itself. Without one, no subork is
   * guarded.
   */
  workspaceProbe?: WorkspaceSnapshotProbe;
  /** Where the guard's submit-time check is registered. */
  acceptanceChecks?: Pick<WorkflowResultService, "addAcceptanceCheck">;
  /** The caller's projection changed: a view should read it again. */
  announce(sessionKey: string): void;
  pollIntervalMs?: number;
  /** Tests drive passes by hand with {@link NativeAgentSuborkService.advanceNow}. */
  autoAdvance?: boolean;
  deadlineMs?: number;
  stallWarningMs?: number;
  stallAbandonMs?: number;
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowStatus(branch: PersistedSuborkBranch): SuborkStatus {
  switch (branch.status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "running":
      return branch.dispatchState === "sent" ? "running" : "starting";
    default:
      return "starting";
  }
}

function rowLine(branch: PersistedSuborkBranch, status: SuborkStatus): string | undefined {
  if (status === "finished") return branch.answer ? suborkOneLine(branch.answer) : undefined;
  if (status === "failed") {
    return branch.error ? suborkOneLine(branch.error, SUBORK_LIMITS.errorMaxChars) : undefined;
  }
  if (status === "stopped") return undefined;
  return branch.latestAction;
}

function branchView(branch: PersistedSuborkBranch): NativeAgentSuborkView {
  const status = rowStatus(branch);
  const line = rowLine(branch, status);
  return {
    id: branch.id,
    name: branch.name,
    agent: branch.agent,
    ...(branch.model && !branch.modelUnpinned ? { model: branch.model } : {}),
    ...(branch.modelLabel ? { modelLabel: branch.modelLabel } : {}),
    status,
    ...(line ? { line } : {}),
    ...(branch.startedAt ? { startedAt: branch.startedAt } : {}),
    ...(branch.completedAt ? { endedAt: branch.completedAt } : {}),
    ...(branch.tokenCount !== undefined ? { tokens: branch.tokenCount } : {}),
    ...(branch.readOnly ? { readOnly: branch.readOnly } : {}),
    ...(branch.guarded ? { guarded: true } : {}),
    ...(branch.transcript ? { transcriptRevision: branch.transcript.manifestRevision } : {}),
  };
}

function refusalView(refusal: PersistedSuborkRefusal): NativeAgentSuborkView {
  return {
    id: refusal.id,
    name: refusal.name,
    status: "failed",
    line: suborkOneLine(refusal.error, SUBORK_LIMITS.errorMaxChars),
  };
}

function ordered(batch: PersistedSuborkBatch): (PersistedSuborkBranch | PersistedSuborkRefusal)[] {
  return [...batch.suborks, ...batch.refused].sort((a, b) => a.position - b.position);
}

function isBranch(
  entry: PersistedSuborkBranch | PersistedSuborkRefusal,
): entry is PersistedSuborkBranch {
  return "agent" in entry;
}

/** The transcript's view of a stored call. */
export function suborkBatchView(batch: PersistedSuborkBatch): NativeAgentSuborkBatchView {
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    status: batch.status,
    suborks: ordered(batch).map((entry) =>
      isBranch(entry) ? branchView(entry) : refusalView(entry),
    ),
    delivery: batch.delivery,
    ...(batch.deliveryDetail ? { deliveryDetail: batch.deliveryDetail } : {}),
    ...(batch.settledAt ? { settledAt: batch.settledAt } : {}),
  };
}

/** A call's answers, labelled with each agent and model, for its delivery mail. */
function deliveryEntries(batch: PersistedSuborkBatch): SuborkDeliveryEntry[] {
  return ordered(batch).map((entry) => {
    if (!isBranch(entry)) {
      return { label: entry.name, status: "failed", text: entry.error };
    }
    const label = `${AGENT_PLATFORM_LABELS[entry.agent]} · ${entry.modelLabel ?? entry.model ?? "saved default"}${
      entry.name === suborkDefaultName(entry.agent, entry.modelLabel) ? "" : ` (${entry.name})`
    }`;
    return entry.status === "completed" && entry.answer
      ? {
          label,
          status: "finished",
          text: entry.answer,
          ...(entry.answerBytes !== undefined ? { originalBytes: entry.answerBytes } : {}),
        }
      : { label, status: "failed", text: entry.error ?? "It stopped without an answer." };
  });
}

function batchIdForRequest(sessionKey: string, requestId: string): string {
  return createHash("sha256")
    .update("subork\0")
    .update(sessionKey)
    .update("\0")
    .update(requestId)
    .digest("hex")
    .slice(0, 32);
}

const READ_ONLY_POLICY = coordinatorEnforcementPolicy();

/** The environment a call's suborks run in. */
function runEnvironmentOf(batch: Pick<PersistedSuborkBatch, "environmentId" | "runEnvironmentId">) {
  return batch.runEnvironmentId ?? batch.environmentId;
}

export class NativeAgentSuborkService {
  private readonly bySession = new Map<string, Map<string, NativeAgentSuborkBatchView>>();
  /** Suborks each session has started. Survives retention through each row's total. */
  private readonly startedTotals = new Map<string, number>();
  /** A running or undelivered call's caller; what the timers and the sweep walk. */
  private readonly live = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly pendingAdmissions = new Map<string, Set<{ cancelled: boolean }>>();
  private readonly admissions = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly passFailures = new Map<string, number>();
  private readonly deliveryFailures = new Map<string, number>();
  private readonly pendingConsumptions = new Set<string>();
  private readonly actionReadAt = new Map<string, number>();
  private readonly progress = new MultiReviewProgressTracker();
  private readonly pollGate: AgentBranchPollGate;
  private readonly captureTranscript;
  private stopped = false;
  private lastSweepAt = 0;
  private readonly guard: WorkspaceReadOnlyGuard | undefined;

  constructor(private readonly options: NativeAgentSuborkServiceOptions) {
    if (options.workspaceProbe) {
      const guard = new WorkspaceReadOnlyGuard(options.workspaceProbe);
      this.guard = guard;
      // At submit time the subork gets a correctable refusal, so it can put the
      // tree back within its own turn before its answer is certified.
      options.acceptanceChecks?.addAcceptanceCheck(
        SUBORK_RESULT_KIND,
        readOnlyAcceptanceCheck(guard, async (attempt) => this.guardedAttempt(attempt.resultKey)),
      );
    }
    const gate = new ElapsedPollGate(this.pollIntervalMs);
    this.pollGate = {
      count: (scope) => gate.count(scope, "explicit"),
      exhausted: (scope, count, limit) => gate.exhausted(scope, count, limit),
      clear: (scope) => gate.clear(scope),
    };
    this.captureTranscript = createGraphRunTranscriptCapture({
      storage: {
        commitGraphRunTranscript: ({ runId, activationKey, ...rest }) =>
          this.batches.commitSuborkTranscript({
            batchId: runId,
            suborkId: activationKey,
            ...rest,
          }),
        describeGraphRunTranscript: (runId, activationKey) =>
          this.batches.describeSuborkTranscript(runId, activationKey),
      },
    });
  }

  private get pollIntervalMs(): number {
    return this.options.pollIntervalMs ?? SUBORK_POLL_MS;
  }

  private get batches(): SuborksStorage {
    return this.options.storage.suborks;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Rebuilds the index and resumes every call a previous process left running. */
  async init(): Promise<void> {
    this.stopped = false;
    for (const batch of await this.batches.listSuborkBatches()) {
      this.index(batch);
      if (
        batch.status === "running" ||
        (batch.status === "settled" && batch.delivery === "waiting")
      ) {
        this.live.set(batch.id, batch.sessionKey);
        this.schedule(batch.id, 0);
      }
    }
  }

  /** The backend is stopping. Sessions keep running; the next process resumes them. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.locks.values());
  }

  /** A session's calls, oldest first. Costs nothing for a session with none. */
  views(sessionKey: string): NativeAgentSuborkBatchView[] | undefined {
    const calls = this.bySession.get(sessionKey);
    if (!calls || calls.size === 0) return undefined;
    return [...calls.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private index(batch: PersistedSuborkBatch): boolean {
    let calls = this.bySession.get(batch.sessionKey);
    if (!calls) {
      calls = new Map();
      this.bySession.set(batch.sessionKey, calls);
    }
    this.startedTotals.set(
      batch.sessionKey,
      Math.max(this.startedTotals.get(batch.sessionKey) ?? 0, batch.sessionStartedTotal),
    );
    const view = suborkBatchView(batch);
    const previous = calls.get(batch.id);
    calls.set(batch.id, view);
    return !previous || JSON.stringify(previous) !== JSON.stringify(view);
  }

  private publish(batch: PersistedSuborkBatch): void {
    if (this.index(batch)) this.options.announce(batch.sessionKey);
  }

  // ------------------------------------------------------------ asking

  /** Starts a call and returns at once. Refusals of the whole call throw. */
  ask(caller: SuborkCaller, input: SuborkAskInput): Promise<SuborkAskResult> {
    const sessionKey = nativeAgentSessionStorageKey(
      caller.environmentId,
      caller.agent,
      caller.logicalSessionKey ?? `env-${caller.environmentId}:${caller.tabId}`,
    );
    const token = { cancelled: false };
    const pending = this.pendingAdmissions.get(sessionKey) ?? new Set();
    pending.add(token);
    this.pendingAdmissions.set(sessionKey, pending);
    // Serialized per session: the limits are read and spent together.
    const previous = this.admissions.get(sessionKey) ?? Promise.resolve();
    const run = previous.then(
      () => this.admit(caller, sessionKey, input, token),
      () => this.admit(caller, sessionKey, input, token),
    );
    const settled = run.catch(() => undefined);
    this.admissions.set(sessionKey, settled);
    void settled.finally(() => {
      pending.delete(token);
      if (pending.size === 0) this.pendingAdmissions.delete(sessionKey);
      if (this.admissions.get(sessionKey) === settled) this.admissions.delete(sessionKey);
    });
    return run;
  }

  private activeCount(sessionKey: string): number {
    let active = 0;
    for (const call of this.bySession.get(sessionKey)?.values() ?? []) {
      for (const { status } of call.suborks) {
        if (status === "starting" || status === "running") active += 1;
      }
    }
    return active;
  }

  private async admit(
    caller: SuborkCaller,
    sessionKey: string,
    input: SuborkAskInput,
    token: { cancelled: boolean },
  ): Promise<SuborkAskResult> {
    if (this.stopped) throw new SuborkRefusedError("The backend is stopping. Try again shortly.");
    const { workflowResults, agentTools, rollout } = this.options;
    if (!workflowResults || !agentTools) {
      throw new SuborkRefusedError("Result tools are unavailable on this backend.");
    }
    const batchId = input.requestId ? batchIdForRequest(sessionKey, input.requestId) : randomUUID();
    const repeated = input.requestId ? this.batches.getSuborkBatch(batchId) : null;
    if (repeated) return this.askResult(repeated, caller);
    const runEnvironmentId = caller.runEnvironmentId ?? caller.environmentId;
    const environment = await this.options.storage.getEnvironment(runEnvironmentId);
    if (!environment || environment.deletionRequestedAt) {
      throw new SuborkRefusedError("This environment no longer exists.");
    }
    if (environment.status !== "running") {
      throw new SuborkRefusedError(
        "This environment is not running, so a subork can't start in it.",
      );
    }
    const config = await this.options.storage.loadConfig();
    if (config.global.agentMessaging?.enabled !== true) {
      throw new SuborkRefusedError(
        "Suborks return their answers through agent mail, which is turned off in Settings → Messaging.",
      );
    }
    await rollout?.refresh().catch(() => undefined);
    const enabledAgents = normalizeAgentPlatforms(config.global.enabledAgentPlatforms, []);
    const [models, tiers] = await Promise.all([
      this.options.modelCatalog(runEnvironmentId).catch(() => [] as AgentModel[]),
      this.options.settingsTiers(environment),
    ]);
    const context = {
      enabledAgents,
      models,
      savedPreference: (agent: AgentPlatform) => {
        const settings = resolveAgentPlatformSettings(tiers, agent);
        return {
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
          ...(settings.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
        };
      },
    };
    const host = this.options.enforcementHost(environment);
    const suborks: PersistedSuborkBranch[] = [];
    const refused: PersistedSuborkRefusal[] = [];
    let active = this.activeCount(sessionKey);
    let total = this.startedTotals.get(sessionKey) ?? 0;
    input.targets.forEach((target, position) => {
      const id = randomUUID();
      const requestedName = target.name?.trim().slice(0, SUBORK_LIMITS.nameMaxChars);
      const named = [target.agent, target.model].filter(Boolean).join(" ").trim();
      const refuse = (error: string) =>
        refused.push({
          id,
          position,
          name: requestedName || named || "Unnamed target",
          error: error.slice(0, SUBORK_LIMITS.errorMaxChars),
        });
      if (position >= SUBORK_LIMITS.targetsPerCall) {
        refuse(
          `One call can start at most ${SUBORK_LIMITS.targetsPerCall} suborks. This target was not started.`,
        );
        return;
      }
      if (active >= SUBORK_LIMITS.activePerSession) {
        refuse(
          `This session already has ${SUBORK_LIMITS.activePerSession} suborks running, the limit. Wait for them to answer.`,
        );
        return;
      }
      if (total >= SUBORK_LIMITS.totalPerSession) {
        refuse(
          `This session has used its ${SUBORK_LIMITS.totalPerSession} suborks. Open a new tab to start more.`,
        );
        return;
      }
      const prompt = target.prompt ?? input.prompt;
      if (!prompt?.trim()) {
        refuse("This target has no prompt. Pass `prompt`, or `prompt` on the target.");
        return;
      }
      if (Buffer.byteLength(prompt, "utf8") > SUBORK_LIMITS.promptMaxBytes) {
        refuse(
          `The prompt is larger than ${SUBORK_LIMITS.promptMaxBytes} bytes. Name the files instead of pasting them.`,
        );
        return;
      }
      const resolved = resolveSuborkTarget(target, context);
      if (!resolved.ok) {
        refuse(resolved.message);
        return;
      }
      if (rollout && !rollout.allows(resolved.agent, SUBORK_RESULT_KIND)) {
        refuse(
          `Result tools are turned off for ${AGENT_PLATFORM_LABELS[resolved.agent]}, and a subork answers through them.`,
        );
        return;
      }
      active += 1;
      total += 1;
      const readOnly = agentPolicyEnforcement(READ_ONLY_POLICY, resolved.agent, host).tier;
      suborks.push({
        id,
        position,
        agent: resolved.agent,
        name:
          requestedName || suborkDefaultName(resolved.agent, resolved.modelLabel ?? resolved.model),
        prompt,
        ...(resolved.model ? { model: resolved.model } : { model: "default", modelUnpinned: true }),
        ...(resolved.modelLabel ? { modelLabel: resolved.modelLabel } : {}),
        ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
        ...(resolved.fastMode !== undefined ? { fastMode: resolved.fastMode } : {}),
        readOnly,
        ...(this.guard && readOnly !== "enforced" ? { guarded: true as const } : {}),
        status: "pending",
      });
    });
    // A guarded subork whose starting state cannot be recorded could never be
    // certified, so it does not start; the others still run.
    const { baseline: workspaceBaseline, unstarted } = await this.captureBaseline(
      runEnvironmentId,
      suborks,
      refused,
    );
    total -= unstarted;
    if (token.cancelled || this.stopped) {
      throw new SuborkRefusedError("This subork request was stopped before it could start.");
    }
    const nothingStarted = suborks.length === 0;
    const created = this.batches.createSuborkBatch({
      version: SUBORK_BATCH_VERSION,
      id: batchId,
      environmentId: caller.environmentId,
      projectId: caller.projectId,
      sessionKey,
      tabId: caller.tabId,
      ...(runEnvironmentId !== caller.environmentId ? { runEnvironmentId } : {}),
      ...(workspaceBaseline ? { workspaceBaseline } : {}),
      status: nothingStarted ? "settled" : "running",
      suborks,
      refused,
      delivery: nothingStarted ? "not-needed" : "waiting",
      sessionStartedTotal: total,
      revision: 0,
      createdAt: "",
      updatedAt: "",
      ...(nothingStarted ? { settledAt: new Date(this.now()).toISOString() } : {}),
    });
    this.publish(created);
    await this.pruneRetained(sessionKey);
    if (!nothingStarted && this.batches.getSuborkBatch(created.id)?.status === "running") {
      this.live.set(created.id, created.sessionKey);
      this.schedule(created.id, 0);
    }
    return this.askResult(created, caller);
  }

  /**
   * The read-only guard's baseline, captured once before any guarded subork is
   * sent. Guarded targets are moved to `refused` when it cannot be observed.
   */
  private async captureBaseline(
    environmentId: string,
    suborks: PersistedSuborkBranch[],
    refused: PersistedSuborkRefusal[],
  ): Promise<{ baseline?: PersistedSuborkBatch["workspaceBaseline"]; unstarted: number }> {
    const guarded = suborks.filter((branch) => branch.guarded);
    if (!this.guard || guarded.length === 0) return { unstarted: 0 };
    try {
      return {
        baseline: (await this.guard.capture(environmentId, SUBORK_READ_ONLY_SUBJECT)).baseline,
        unstarted: 0,
      };
    } catch (error) {
      if (!(error instanceof WorkspaceBaselineUnavailableError)) throw error;
      for (const branch of guarded) {
        suborks.splice(suborks.indexOf(branch), 1);
        refused.push({
          id: branch.id,
          position: branch.position,
          name: branch.name,
          error:
            `${AGENT_PLATFORM_LABELS[branch.agent]} cannot be stopped from writing, so its answer is accepted only if the workspace's Git state is unchanged afterwards, and that state could not be read: ${error.reason}. This target was not started.`.slice(
              0,
              SUBORK_LIMITS.errorMaxChars,
            ),
        });
      }
      return { unstarted: guarded.length };
    }
  }

  /** The guarded subork a submitted answer belongs to, or null to let it through. */
  private guardedAttempt(resultKey: string) {
    if (this.stopped) return null;
    for (const batchId of this.live.keys()) {
      const batch = this.batches.getSuborkBatch(batchId);
      if (batch?.status !== "running" || !batch.workspaceBaseline) continue;
      const branch = batch.suborks.find((candidate) => candidate.requestId === resultKey);
      if (!branch) continue;
      return branch.guarded
        ? {
            environmentId: runEnvironmentOf(batch),
            baseline: batch.workspaceBaseline,
            subject: SUBORK_READ_ONLY_SUBJECT,
          }
        : null;
    }
    return null;
  }

  /**
   * A guarded subork's answer stands only while the workspace still matches the
   * call's baseline. A change fails it with the paths named; nothing is reset,
   * so the workspace is the evidence. Every guarded subork of the call is judged
   * on the same tree, because they share it and Git cannot say which one wrote.
   */
  private async certifyGuarded(batch: PersistedSuborkBatch): Promise<boolean> {
    if (!this.guard) return false;
    let changed = false;
    for (const branch of batch.suborks) {
      if (!branch.guarded || branch.certified || branch.status !== "completed") continue;
      try {
        await this.guard.certify(
          runEnvironmentOf(batch),
          batch.workspaceBaseline ?? null,
          SUBORK_READ_ONLY_SUBJECT,
        );
      } catch (error) {
        if (!(error instanceof WorkspaceReadOnlyViolationError)) throw error;
        branch.status = "failed";
        branch.error = error.message.slice(0, SUBORK_LIMITS.errorMaxChars);
        delete branch.answer;
        delete branch.answerBytes;
      }
      branch.certified = true;
      changed = true;
    }
    return changed;
  }

  private askResult(batch: PersistedSuborkBatch, caller: SuborkCaller): SuborkAskResult {
    const view = suborkBatchView(batch);
    const started = batch.suborks.length;
    return {
      batchId: batch.id,
      suborks: ordered(batch).map((entry) =>
        isBranch(entry)
          ? {
              id: entry.id,
              name: entry.name,
              agent: entry.agent,
              ...(entry.model && !entry.modelUnpinned ? { model: entry.model } : {}),
              status: rowStatus(entry),
              ...(entry.readOnly ? { readOnly: entry.readOnly } : {}),
              ...(entry.guarded ? { guarded: true } : {}),
            }
          : { id: entry.id, name: entry.name, status: "failed" as const, error: entry.error },
      ),
      next:
        (started === 0
          ? ""
          : batch.suborks.some((entry) => entry.guarded)
            ? "Do not change files in this workspace until the answers arrive: an agent marked guarded cannot be stopped from writing, so its answer is refused if the workspace's Git state changes while it runs. "
            : "") +
        (started === 0
          ? "None of the targets started, for the reasons listed. No message will follow: correct the targets and call again, or tell the person."
          : caller.inboxOnly
            ? `${view.suborks.length === 1 ? "The subork is" : "The suborks are"} running. This tab's delivery is off, so the answers will wait in your inbox and will not wake you: read them with check_inbox on your next turn.`
            : `${view.suborks.length === 1 ? "The subork is" : "The suborks are"} running. End your turn now if you have nothing else to do. All the answers arrive together in a new message that wakes you, and you continue from there. Do not poll, and do not do the same work yourself.`),
    };
  }

  /** Keeps a session's newest calls. Running calls are never removed. */
  private async pruneRetained(sessionKey: string): Promise<void> {
    const calls = this.bySession.get(sessionKey);
    if (!calls || calls.size <= SUBORK_LIMITS.retainedBatchesPerSession) return;
    const removable = [...calls.values()]
      .filter((call) => call.status !== "running" && call.delivery !== "waiting")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const excess = calls.size - SUBORK_LIMITS.retainedBatchesPerSession;
    for (const call of removable.slice(0, excess)) {
      calls.delete(call.id);
      await this.batches.deleteSuborkBatch(call.id).catch((error: unknown) => {
        log.warn("retention.failed", { error: formatLogError(error) });
      });
    }
    this.options.announce(sessionKey);
  }

  // ------------------------------------------------------------ stopping

  /**
   * Stops a session's running calls. The row is committed first, in one
   * transaction, so a pass already in flight is fenced by its next read or save
   * and a crash after this point does not resume them.
   */
  async stopForSession(sessionKey: string, batchId?: string): Promise<void> {
    if (!batchId) {
      for (const token of this.pendingAdmissions.get(sessionKey) ?? []) token.cancelled = true;
    }
    const calls = this.bySession.get(sessionKey);
    if (!calls) return;
    const work: Promise<void>[] = [];
    for (const call of Array.from(calls.values())) {
      if (batchId && call.id !== batchId) continue;
      if (call.status === "running" || (call.status === "settled" && call.delivery === "waiting")) {
        const stopped = this.markStopped(call.id);
        if (stopped) work.push(this.afterStop(stopped));
      } else if (call.status === "settled" && call.delivery === "sent") {
        work.push(this.withdrawDelivery(call.id));
      }
    }
    await Promise.all(work);
  }

  private markStopped(batchId: string): PersistedSuborkBatch | null {
    const at = new Date(this.now()).toISOString();
    const stored = this.batches.updateSuborkBatch(batchId, (batch) => {
      if (
        batch.status !== "running" &&
        !(batch.status === "settled" && batch.delivery === "waiting")
      )
        return undefined;
      return {
        ...batch,
        status: "stopped",
        delivery: "not-needed",
        settledAt: at,
        suborks: batch.suborks.map((branch) =>
          agentBranchSettled(branch)
            ? branch
            : { ...branch, status: "cancelled" as const, completedAt: at },
        ),
      };
    });
    if (!stored || stored.status !== "stopped") return null;
    this.live.delete(batchId);
    this.clearTimer(batchId);
    this.publish(stored);
    return stored;
  }

  /** Answers not yet delivered are not wanted either. Mail already injected stays. */
  private async withdrawDelivery(batchId: string): Promise<void> {
    const batch = this.batches.getSuborkBatch(batchId);
    if (!batch?.deliveryMessageId || batch.delivery !== "sent") return;
    const { storage } = this.options;
    try {
      const { placement } = await storage.getAgentMailStatus(batch.deliveryMessageId);
      if (placement === "injected") return;
      await storage.discardAgentMail(batch.environmentId, batch.tabId, batch.deliveryMessageId);
      const stored = this.batches.updateSuborkBatch(batchId, (current) => ({
        ...current,
        delivery: "not-needed",
      }));
      if (stored) this.publish(stored);
    } catch {
      // Already on its way, or gone: it reaches the caller or it does not, as mail does.
    }
  }

  private async afterStop(batch: PersistedSuborkBatch): Promise<void> {
    await this.abortSessions(batch);
    await Promise.all(
      batch.suborks.map(async (branch) => {
        if (branch.requestId && branch.resultTransport === "tool-v1") {
          await this.options.workflowResults
            ?.close(branch.requestId, "cancelled")
            .catch(() => undefined);
        }
        this.releaseBranch(batch, branch);
      }),
    );
  }

  private async abortSessions(batch: PersistedSuborkBatch): Promise<void> {
    const environment = await this.options.storage
      .getEnvironment(runEnvironmentOf(batch))
      .catch(() => null);
    if (!environment) return;
    await Promise.all(
      batch.suborks.map(async (branch) => {
        const sessionId = branch.providerSessionId;
        if (!sessionId || branch.status === "completed") return;
        const abort = async () => {
          const provider = await this.options.providers.get(environment, branch.agent, branch.id);
          // Capture both before and after abort: some providers clear their final
          // snapshot on abort, while others publish usage only as it settles.
          const host = new SuborkBranchHost(
            this.hostDependencies(),
            batch,
            environment,
            this.actionReadAt,
          );
          await host.recordUsage(branch, provider, sessionId).catch(() => undefined);
          await provider.abort(sessionId);
          await host.recordUsage(branch, provider, sessionId).catch(() => undefined);
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          abort().catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, STOP_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      }),
    );
  }

  /** Called from the activity sweep. Costs nothing with no live call. */
  sweep(): void {
    if (this.stopped || this.live.size === 0) return;
    const now = this.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const sessionKey of new Set(this.live.values())) {
      void this.options.storage
        .getNativeAgentSession(sessionKey)
        .then((session) => (session ? undefined : this.stopForSession(sessionKey)))
        .catch((error: unknown) => {
          log.warn("sweep.failed", { error: formatLogError(error) });
        });
    }
  }

  // ------------------------------------------------------------ reading

  /** One subork's stored transcript; the row's `transcriptRevision` says when it moves. */
  async readTranscript(input: {
    environmentId: string;
    batchId: string;
    suborkId: string;
    fromIndex?: number;
    maxBytes?: number;
  }) {
    const batch = this.batches.getSuborkBatch(input.batchId);
    if (!batch || batch.environmentId !== input.environmentId) {
      return { status: "missing" as const };
    }
    const branch = batch.suborks.find((candidate) => candidate.id === input.suborkId);
    if (!branch?.transcript) return { status: "none" as const };
    const read = await this.batches.readSuborkTranscript(batch.id, branch.id, branch.transcript, {
      ...(input.fromIndex !== undefined ? { fromIndex: input.fromIndex } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    });
    return { ...read, agent: branch.agent, transcript: branch.transcript };
  }

  // ------------------------------------------------------------ passes

  /** One pass over a call, serialized with every other (tests and the timer). */
  async advanceNow(batchId: string): Promise<NativeAgentSuborkBatchView | null> {
    await this.withLock(batchId, () => this.pass(batchId));
    const batch = this.batches.getSuborkBatch(batchId);
    return batch ? suborkBatchView(batch) : null;
  }

  private clearTimer(batchId: string): void {
    const timer = this.timers.get(batchId);
    if (timer) clearTimeout(timer);
    this.timers.delete(batchId);
  }

  private schedule(batchId: string, delayMs: number): void {
    if (this.stopped || this.options.autoAdvance === false) return;
    this.clearTimer(batchId);
    const timer = setTimeout(() => {
      this.timers.delete(batchId);
      void this.withLock(batchId, () => this.pass(batchId)).finally(() => {
        if (!this.live.has(batchId)) return;
        const batch = this.batches.getSuborkBatch(batchId);
        const starting = batch?.suborks.some(
          (branch) => branch.status === "pending" || branch.dispatchState === "prepared",
        );
        this.schedule(batchId, starting ? 0 : this.pollIntervalMs);
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(batchId, timer);
  }

  private async withLock(batchId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(batchId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => undefined);
    this.locks.set(batchId, settled);
    try {
      await run;
    } finally {
      if (this.locks.get(batchId) === settled) this.locks.delete(batchId);
    }
  }

  private async pass(batchId: string): Promise<void> {
    if (this.stopped) return;
    const batch = this.batches.getSuborkBatch(batchId);
    if (!batch) {
      this.live.delete(batchId);
      return;
    }
    try {
      await this.retryConsumptions();
      if (batch.status === "running") await this.advance(batch);
      if (batch.status === "settled" && batch.delivery === "waiting") await this.deliver(batch);
      if (batch.status !== "running" && batch.delivery !== "waiting") this.live.delete(batchId);
      this.passFailures.delete(batchId);
    } catch (error) {
      if (isAgentBranchFenceError(error)) {
        await this.afterFence(batch);
        return;
      }
      const failures = (this.passFailures.get(batchId) ?? 0) + 1;
      this.passFailures.set(batchId, failures);
      // Content-free: the message could quote a response.
      log.warn("pass.failed", { failures, maxFailures: MAX_PASS_FAILURES });
      if (failures < MAX_PASS_FAILURES) return;
      this.passFailures.delete(batchId);
      await this.failRemaining(batchId, `The subork kept failing: ${errorMessage(error)}`);
    }
  }

  /**
   * A Stop landed during this pass. A send already under way may have started a
   * turn the stop's own abort could not see, so the pass's copy of the sessions
   * is aborted once more.
   */
  private async afterFence(batch: PersistedSuborkBatch): Promise<void> {
    if (this.stopped) return;
    const stored = this.batches.getSuborkBatch(batch.id);
    if (stored?.status === "stopped") await this.abortSessions(batch);
  }

  private async advance(batch: PersistedSuborkBatch): Promise<void> {
    const environment = await this.options.storage.getEnvironment(runEnvironmentOf(batch));
    if (!environment || environment.deletionRequestedAt || environment.status !== "running") {
      await this.failRemaining(batch.id, "The environment stopped before the subork answered.");
      Object.assign(batch, this.batches.getSuborkBatch(batch.id) ?? batch);
      return;
    }
    const unsettled = batch.suborks.filter((branch) => !agentBranchSettled(branch));
    const host = new SuborkBranchHost(
      this.hostDependencies(),
      batch,
      environment,
      this.actionReadAt,
    );
    const runner = new AgentBranchRunner(host);
    runner.beginPass();
    const deadlineMs = this.options.deadlineMs ?? SUBORK_LIMITS.deadlineMs;
    await Promise.all(
      unsettled.map(async (branch, index) => {
        const startedAt = Date.parse(branch.startedAt ?? batch.createdAt);
        if (this.now() - startedAt >= deadlineMs) {
          if (branch.providerSessionId) {
            await this.abortSessions({ ...batch, suborks: [branch] });
          }
          branch.status = "failed";
          branch.completedAt = new Date(this.now()).toISOString();
          branch.error = `It did not finish within ${Math.round(deadlineMs / 60_000)} minutes.`;
          await runner.commit();
          return;
        }
        await runner.advanceIsolated(branch, index, unsettled.length);
      }),
    );
    await runner.flushObservations();
    if (await this.certifyGuarded(batch)) await host.save();
    for (const branch of batch.suborks) {
      if (agentBranchSettled(branch)) this.releaseBranch(batch, branch);
    }
    if (batch.suborks.every(agentBranchSettled)) {
      batch.status = "settled";
      batch.settledAt = new Date(this.now()).toISOString();
      await host.save();
    }
    this.publish(batch);
  }

  private releaseBranch(batch: PersistedSuborkBatch, branch: PersistedSuborkBranch): void {
    if (branch.providerSessionId) this.progress.forget(branch.providerSessionId);
    this.actionReadAt.delete(branch.id);
    this.options.providers.release(runEnvironmentOf(batch), branch.agent, branch.id);
  }

  /** Every target still running resolves as failed, so the caller still hears back. */
  private async failRemaining(batchId: string, error: string): Promise<void> {
    const at = new Date(this.now()).toISOString();
    const stored = this.batches.updateSuborkBatch(batchId, (batch) =>
      batch.status !== "running"
        ? undefined
        : {
            ...batch,
            status: "settled",
            settledAt: at,
            suborks: batch.suborks.map((branch) =>
              agentBranchSettled(branch)
                ? branch
                : { ...branch, status: "failed" as const, completedAt: at, error },
            ),
          },
    );
    if (!stored) return;
    await this.abortSessions(stored);
    for (const branch of stored.suborks) this.releaseBranch(stored, branch);
    this.publish(stored);
    if (stored.status === "settled" && stored.delivery === "waiting") await this.deliver(stored);
    if (stored.delivery !== "waiting") this.live.delete(batchId);
  }

  /**
   * The answers, together, in one notice. `requestId` is the call, so a repeat
   * after a crash is the same mail. A send that cannot be placed is reported on
   * the rows; the answers themselves stay readable there either way.
   */
  private async deliver(batch: PersistedSuborkBatch): Promise<void> {
    const canDeliver = () => {
      const current = this.batches.getSuborkBatch(batch.id);
      return current?.status === "settled" && current.delivery === "waiting";
    };
    if (!canDeliver()) return;
    const entries = deliveryEntries(batch);
    const finished = entries.filter((entry) => entry.status === "finished").length;
    const save = (
      delivery: PersistedSuborkBatch["delivery"],
      detail?: string,
      messageId?: string,
    ) => {
      batch.delivery = delivery;
      if (detail) batch.deliveryDetail = detail;
      if (messageId) batch.deliveryMessageId = messageId;
      const stored = this.batches.saveSuborkBatch(batch);
      batch.revision = stored.revision;
      batch.updatedAt = stored.updatedAt;
      this.deliveryFailures.delete(batch.id);
      this.publish(batch);
    };
    try {
      const message = await this.options.storage.sendAgentMail(
        {
          kind: "system",
          projectId: batch.projectId,
          source: "workflow",
          resourceId: `subork:${batch.id}`,
        },
        {
          requestId: `subork:${batch.id}`,
          toEnvironmentId: batch.environmentId,
          toTabId: batch.tabId,
          subject: `Subork answers: ${finished} of ${entries.length} finished`,
          body: renderSuborkDeliveryBody(entries),
        },
        {
          isStillWanted: canDeliver,
          notice: {
            resource: {
              kind: "subork",
              id: batch.id,
              environmentId: batch.environmentId,
              tabId: batch.tabId,
            },
            state: finished === entries.length ? "completed" : "failed",
            tone: finished === entries.length ? "success" : "attention",
          },
        },
      );
      if (!canDeliver()) {
        await this.options.storage.discardAgentMail(batch.environmentId, batch.tabId, message.id);
        return;
      }
      if (message.placement === "bounced" || message.placement === "undeliverable") {
        save("failed", message.placementReason ?? message.placement, message.id);
      } else if (message.placement === "stored") {
        save("stored", message.placementReason, message.id);
      } else {
        save("sent", undefined, message.id);
      }
    } catch (error) {
      if (!canDeliver()) return;
      if (error instanceof SuborkStorageError) throw new SuborkFenceError();
      const failures = (this.deliveryFailures.get(batch.id) ?? 0) + 1;
      this.deliveryFailures.set(batch.id, failures);
      log.warn("delivery.failed", { failures, error: formatLogError(error, { message: false }) });
      if (error instanceof AgentMailError || failures >= MAX_DELIVERY_FAILURES) {
        save("failed", errorMessage(error).slice(0, SUBORK_LIMITS.errorMaxChars));
      }
    }
  }

  private async retryConsumptions(): Promise<void> {
    for (const requestId of [...this.pendingConsumptions].slice(0, 8)) {
      try {
        await this.options.workflowResults?.consume(requestId);
        this.pendingConsumptions.delete(requestId);
      } catch {
        // Kept for a later pass; bounded.
      }
    }
  }

  private hostDependencies(): SuborkHostDependencies {
    const { workflowResults, agentTools } = this.options;
    if (!workflowResults || !agentTools) {
      throw new SuborkRefusedError("Result tools are unavailable on this backend.");
    }
    const recordUsage = this.options.storage.recordAgentUsageTurns;
    return {
      providers: this.options.providers,
      workflowResults,
      agentTools,
      ...(this.options.assertAgentToolsReachable
        ? { assertAgentToolsReachable: this.options.assertAgentToolsReachable }
        : {}),
      save: (batch) => {
        if (this.stopped) throw new SuborkFenceError("The backend is stopping");
        try {
          return this.batches.saveSuborkBatch(batch);
        } catch (error) {
          if (error instanceof SuborkStorageError) throw new SuborkFenceError();
          throw error;
        }
      },
      assertRunning: (batch) => {
        if (this.stopped) throw new SuborkFenceError("The backend is stopping");
        if (this.batches.getSuborkBatch(batch.id)?.status !== "running") {
          throw new SuborkFenceError();
        }
      },
      captureTranscript: this.captureTranscript,
      ...(recordUsage
        ? {
            recordUsage: (input: RecordUsageTurnsInput) => {
              recordUsage.call(this.options.storage, input);
            },
          }
        : {}),
      deferConsumption: (requestId) => {
        if (this.pendingConsumptions.size < MAX_PENDING_CONSUMPTIONS) {
          this.pendingConsumptions.add(requestId);
        }
      },
      finishConsumption: (requestId) => {
        this.pendingConsumptions.delete(requestId);
      },
      progress: this.progress,
      pollGate: this.pollGate,
      ...(this.options.stallWarningMs !== undefined
        ? { stallWarningMs: this.options.stallWarningMs }
        : {}),
      ...(this.options.stallAbandonMs !== undefined
        ? { stallAbandonMs: this.options.stallAbandonMs }
        : {}),
    };
  }
}

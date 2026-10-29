/**
 * State and persistence shared by every build pipeline collaborator.
 *
 * Built once by `BuildPipelineService` (`build-pipeline-service.ts`) and handed
 * to each part: agent resolution (`-agents`), recovery and terminal
 * reconciliation (`-recovery`), interaction enforcement and failure handling
 * (`-interactions`), the stage supervisor (`-supervisor`) and the public
 * lifecycle operations (`-lifecycle`). It holds the in-memory maps and timers
 * that used to live on the base class of an `extends` chain, plus the
 * operations every part needs: the control-record save, the locked mutation
 * and the workflow-result helpers.
 */
import { randomUUID } from "node:crypto";
import type { ReviewFanoutConcurrency } from "./review-fanout-scheduler.js";
import type { MultiReviewEfficiencyObserver } from "./multi-review-efficiency.js";
import {
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSession,
  type ResumableBuildPhase,
  isBuildPipeline,
  isActiveBuildPhase,
  BUILD_PIPELINE_VERSION,
} from "@orkestrator/protocol/build-pipeline";
import type {
  StructuredOutputProvider,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import type { PersistedBuildPipeline } from "./models.js";
import type { StorageService } from "./storage.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { WorkflowResultService } from "./workflow-result-service.js";
import { WorkflowResultRollout } from "./workflow-result-rollout.js";
import { BuildPipelineTranscriptCheckpoints } from "./build-pipeline-transcript-checkpoints.js";
import type { WorkflowResultKind } from "@orkestrator/protocol/workflow-results";
import type { BuildPipelineProvider, ProviderDependencies } from "./build-pipeline-provider.js";
import {
  errorMessage,
  DEFAULT_RECONNECT_DEADLINE_MS,
  DEFAULT_STRUCTURED_RESULT_DEADLINE_MS,
  DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS,
  type CommandInvoker,
} from "./build-pipeline-service-helpers.js";
import { resolveEnvironmentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  KeyedWorkflowSupervisor,
  keyedSchedulingEnabled,
  type KeyedWorkflowServiceOptions,
} from "./workflow-supervisor.js";
import { ElapsedPollGate, type PollTrigger } from "./workflow-poll-gate.js";
import {
  buildPipelineObligation,
  buildPipelineTarget,
  type BuildPipelineObligation,
} from "./build-pipeline-scheduling.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  beginWorkflowArtifactTurn,
  settleArtifactDispatchTurn,
  type ArtifactTurnDispatch,
  type WorkflowArtifactTurnOptions,
} from "./workflow-artifact-turns.js";
import type { ArtifactLedgerSource } from "./workflow-transcript-artifacts.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { resetWorktreeToCommit } from "./build-pipeline-code-rewind.js";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";

/** The previous supervisor interval; the keyed driver's per-pipeline fallback cadence. */
export const BUILD_PIPELINE_PROGRESS_MS = 1_500;

export type BuildPipelineServiceOptions = {
  autoAdvance?: boolean;
  provider?: (pipeline: BuildPipeline, agent: BuildPipelineAgent) => Promise<BuildPipelineProvider>;
  reconnectDeadlineMs?: number;
  structuredResultDeadlineMs?: number;
  transcriptPersistIntervalMs?: number;
  /** Narrow production-provider seam used by deterministic backend tests. */
  providerDependencies?: Pick<ProviderDependencies, "openCodeClient" | "monitorRetryMs">;
  workflowResults?: WorkflowResultService;
  workflowResultRollout?: WorkflowResultRollout;
  resolveAgentToolConnection?: (
    environmentId: string,
    projectId: string,
    target: "host" | "container",
    resultKey: string,
    provider?: StructuredOutputProvider,
  ) => AgentToolConnection;
  /** Rejects when the environment's container cannot reach the agent tools server. */
  assertAgentToolsReachable?: (environmentId: string, stage: string) => Promise<void>;
  /** Multi-reviewer stage concurrency; clamped by the shared fan-out runner. */
  reviewFanoutConcurrency?: Partial<ReviewFanoutConcurrency>;
  /** Content-free fan-out measurements (tests and benchmarks). */
  efficiency?: MultiReviewEfficiencyObserver;
  /** Stage turns' transcript-artifact grants (`workflow-artifact-turns.ts`). */
  artifactDispatch?: ArtifactTurnDispatch;
  /** Publication ledger; stage transcripts place each publication beside its call. */
  artifactLedger?: ArtifactLedgerSource;
  /**
   * Git in an environment's worktree, for "Rewind code to here". Not a backend
   * command on purpose: a renderer must not be able to reset a branch without
   * the pipeline's own checks. Absent, the action reports itself unavailable.
   */
  environmentGit?: EnvironmentGit;
  /** The backend fence shared by file writes, commands and agent dispatch. */
  environmentFence?: EnvironmentMutationFence;
  /** Checks native/background writers while new work is excluded by the fence. */
  assertEnvironmentQuiescent?: (environmentId: string) => Promise<void>;
} & KeyedWorkflowServiceOptions;

export class BuildPipelineContext {
  timer: ReturnType<typeof setInterval> | null = null;

  /** The keyed driver (step 08); `null` on the rollback tick or before init. */
  supervisor: KeyedWorkflowSupervisor<BuildPipelineObligation> | null = null;

  unsubscribeStorage: (() => void) | null = null;

  /**
   * How the pass now running for each pipeline was triggered, so
   * attempt-counted deadlines can tell a wakeup burst from a cadence poll.
   */
  readonly passTriggers = new Map<string, PollTrigger>();

  /** Elapsed-time gate for reviewer idle/final-usage poll counts. */
  readonly reviewerPollGate = new ElapsedPollGate(BUILD_PIPELINE_PROGRESS_MS);

  private readonly rewindFence = new EnvironmentMutationFence();

  readonly locks = new Map<string, Promise<void>>();

  readonly providers = new Map<string, BuildPipelineProvider>();

  /** In-flight creations by provider key, so concurrent callers share one instance. */
  readonly providerCreations = new Map<string, Promise<BuildPipelineProvider>>();

  /**
   * The harness whose provider each pipeline last resolved.
   *
   * A stage transition resolves and caches the *next* step's provider before it
   * records that step's session, so a failure there cannot be attributed by
   * reading the stored snapshot — it still describes the previous stage. Passes
   * are serialised per pipeline by the supervisor's `runLocked`, so the last
   * agent handed to `BuildPipelineAgents.provider` is the one that failed.
   */
  readonly lastProviderAgent = new Map<string, BuildPipelineAgent>();

  readonly provisioningPrompts = new Map<string, string | undefined>();

  /** Fences provider responses across backend processes sharing one journal. */
  readonly interactionOwnerId = randomUUID();

  tickPromise: Promise<void> | null = null;
  tickRequested = false;
  stopped = false;

  constructor(
    readonly storage: StorageService,
    readonly invoke: CommandInvoker,
    readonly options: BuildPipelineServiceOptions = {},
  ) {
    this.keyed = options.keyedScheduling ?? keyedSchedulingEnabled("build-pipeline");
  }

  /** Selected once at construction: the keyed driver or the whole-store tick, never both. */
  readonly keyed: boolean;

  get reconnectDeadlineMs(): number {
    return this.options.reconnectDeadlineMs ?? DEFAULT_RECONNECT_DEADLINE_MS;
  }

  get structuredResultDeadlineMs(): number {
    return this.options.structuredResultDeadlineMs ?? DEFAULT_STRUCTURED_RESULT_DEADLINE_MS;
  }

  get transcriptPersistIntervalMs(): number {
    return this.options.transcriptPersistIntervalMs ?? DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS;
  }

  private cachedTranscriptCheckpoints: BuildPipelineTranscriptCheckpoints | null = null;

  /**
   * Newest observed transcripts and their checkpointing into the transcript
   * store ahead of each control-record save. Lazy for the same reason as the
   * rollout below: parameter properties are assigned after field initializers.
   */
  get transcriptCheckpoints(): BuildPipelineTranscriptCheckpoints {
    this.cachedTranscriptCheckpoints ??= new BuildPipelineTranscriptCheckpoints(this.storage);
    return this.cachedTranscriptCheckpoints;
  }

  /** Background legacy-transcript migration and orphan sweep started by `init`. */
  transcriptMaintenance: Promise<void> | null = null;

  private cachedWorkflowRollout: WorkflowResultRollout | null = null;

  /**
   * Falls back to the qualified defaults when no rollout is injected, so a
   * directly constructed service behaves like the shipped configuration.
   * Resolved lazily because parameter properties are assigned after class
   * field initializers run.
   */
  get workflowRollout(): WorkflowResultRollout {
    this.cachedWorkflowRollout ??=
      this.options.workflowResultRollout ?? new WorkflowResultRollout(async () => undefined);
    return this.cachedWorkflowRollout;
  }

  workflowResultKind(
    phase: ResumableBuildPhase,
    validationPlan = false,
  ): WorkflowResultKind | undefined {
    if (phase === "building" || phase === "fixing")
      return validationPlan ? "validation-plan" : "review-preparation";
    if (phase === "reviewing") return "review-report";
    // Address turns submit the typed report Verify reads
    // (`build-pipeline-address-report.ts`).
    if (phase === "addressing") return "fix-result";
    if (phase === "verifying") return "verification-result";
    return undefined;
  }

  async workflowAgentMcp(
    pipeline: BuildPipeline,
    resultKey: string,
    provider: StructuredOutputProvider | undefined,
    stage: string,
  ): Promise<AgentToolConnection | undefined> {
    if (!this.options.resolveAgentToolConnection) return undefined;
    if (pipeline.environmentType !== "local") {
      await this.options.assertAgentToolsReachable?.(pipeline.environmentId, stage);
    }
    return this.options.resolveAgentToolConnection(
      pipeline.environmentId,
      pipeline.projectId,
      pipeline.environmentType === "local" ? "host" : "container",
      resultKey,
      provider,
    );
  }

  /**
   * A stage turn's transcript-artifact authority, owned by the stage
   * session's own key in the pipeline's environment, or undefined when the
   * provider has no path for it (`workflow-artifact-turns.ts`).
   */
  beginArtifactTurn(
    pipeline: BuildPipeline,
    session: Pick<PipelineSession, "sessionKey" | "sdkSessionId"> | undefined,
    requestId: string,
    agent: string | undefined,
    agentMcp: AgentToolConnection | undefined,
  ): WorkflowArtifactTurnOptions | undefined {
    if (!session || !agent) return undefined;
    return beginWorkflowArtifactTurn(this.options.artifactDispatch, {
      environmentId: pipeline.environmentId,
      projectId: pipeline.projectId,
      conversationKey: session.sessionKey,
      turnId: requestId,
      providerSessionId: session.sdkSessionId,
      agent,
      ...(agentMcp ? { agentMcp } : {}),
    });
  }

  /** Ends a stage turn's artifact grant (turn settled, or its send refused). */
  settleArtifactTurn(
    pipeline: BuildPipeline,
    session: Pick<PipelineSession, "sessionKey"> | undefined,
    requestId: string | undefined,
  ): void {
    if (!session || !requestId) return;
    settleArtifactDispatchTurn(
      this.options.artifactDispatch,
      pipeline.environmentId,
      session.sessionKey,
      requestId,
    );
  }

  /**
   * Admission gate, evaluated once per attempt. The rollout snapshot is read
   * synchronously because several admission points sit inside storage mutation
   * callbacks; {@link refreshWorkflowRollout} refreshes it just before those.
   */
  workflowToolEnabled(agent: BuildPipelineAgent, kind: WorkflowResultKind): boolean {
    return (
      this.options.workflowResults !== undefined &&
      this.options.resolveAgentToolConnection !== undefined &&
      this.workflowRollout.allows(agent, kind)
    );
  }

  async refreshWorkflowRollout(): Promise<void> {
    await this.workflowRollout.refresh();
  }

  /** Background sessions receive the same trusted environment policy as native tabs. */
  async executionPolicy(
    pipeline: BuildPipeline,
    origin: "build-pipeline" | "automated-review" = "build-pipeline",
  ): Promise<NativeAgentExecutionPolicy> {
    const environment = await this.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    return resolveEnvironmentExecutionPolicy(environment, origin);
  }

  async consumeWorkflowResult(
    pipeline: BuildPipeline,
    session: PipelineSession,
    resultKey: string,
  ): Promise<void> {
    if (session.resultTransport === "tool-v1") {
      try {
        await this.options.workflowResults?.consume(resultKey);
        // Consumption ends the submission's own lifecycle. Completion is a
        // separate stage transition the supervisor still owns.
        delete session.resultSubmission;
        const pending = (pipeline.pendingResultConsumptions ?? []).filter(
          (candidate) => candidate !== resultKey,
        );
        if (pending.length > 0) pipeline.pendingResultConsumptions = pending;
        else delete pipeline.pendingResultConsumptions;
        await this.save(pipeline, pipeline.backendRevision);
      } catch (error) {
        // The already-saved outbox marker is authoritative. A later supervisor
        // pass retries cleanup without turning an applied domain transition
        // into a workflow failure.
        this.stageWorkflowResultConsumption(pipeline, session, resultKey);
        console.warn(
          `[build-pipeline] Deferred result consumption for ${pipeline.id}:`,
          errorMessage(error),
        );
      }
    }
  }

  stageWorkflowResultConsumption(
    pipeline: BuildPipeline,
    session: PipelineSession,
    resultKey: string,
  ): void {
    if (session.resultTransport !== "tool-v1") return;
    pipeline.pendingResultConsumptions = Array.from(
      new Set([...(pipeline.pendingResultConsumptions ?? []), resultKey]),
    );
  }

  async readWorkflowResult<T>(
    provider: BuildPipelineProvider,
    session: PipelineSession,
    resultKey: string,
  ): Promise<StructuredOutputResult<T> | null> {
    if (session.resultTransport === "tool-v1") {
      if (!this.options.workflowResults) throw new Error("Workflow result store is unavailable");
      // Refreshed on the same poll that reads the result, so the projected
      // status a renderer rehydrates from is written by the authoritative
      // controller rather than derived in the renderer.
      session.resultSubmission = await this.options.workflowResults.projection(resultKey);
      return this.options.workflowResults.structured<T>(resultKey);
    }
    return provider.structured<T>(session.sdkSessionId, resultKey);
  }

  /** Keeps the keyed index current after an authoritative read or durable write. */
  noteRecord(pipelineId: string, snapshot: unknown): void {
    this.supervisor?.note(
      pipelineId,
      buildPipelineObligation(snapshot),
      buildPipelineTarget(snapshot),
    );
  }

  /** Trigger of the pass now running for a pipeline; explicit when not keyed. */
  passTrigger(pipelineId: string): PollTrigger {
    return this.passTriggers.get(pipelineId) ?? "explicit";
  }

  async requireRecord(pipelineId: string): Promise<PersistedBuildPipeline> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    this.noteRecord(pipelineId, record?.snapshot);
    if (!record || !isBuildPipeline(record.snapshot)) {
      throw new Error(`Build pipeline not found: ${pipelineId}`);
    }
    return record;
  }

  async save(pipeline: BuildPipeline, expectedRevision: number): Promise<PersistedBuildPipeline> {
    pipeline.controller = "backend";
    // Transcript bodies commit first (chunks, then manifest) so the control
    // record below only ever references durable data. A checkpoint failure
    // keeps the previous reference and never blocks this control write.
    const checkpoint = await this.transcriptCheckpoints.prepare(pipeline);
    pipeline.backendRevision = expectedRevision + 1;
    // Storage validates only serializability and size, and `requireRecord`
    // rejects a snapshot that fails `isBuildPipeline` — so committing an
    // invariant violation would hide the pipeline from every later read,
    // including the supervisor tick, permanently. Fail the pass instead: the
    // last durable revision stays readable and the next tick can retry.
    const structurallyValid: boolean = isBuildPipeline(pipeline);
    if (!structurallyValid) {
      pipeline.backendRevision = expectedRevision;
      throw new Error(`Refusing to persist an invalid build pipeline snapshot: ${pipeline.id}`);
    }
    await this.storage.buildPipelineTranscriptFault("before-control-save", pipeline.id);
    const saved = await this.storage.saveBuildPipeline(
      pipeline.id,
      pipeline.projectId,
      pipeline.environmentId,
      BUILD_PIPELINE_VERSION,
      pipeline,
      expectedRevision,
    );
    await this.storage.buildPipelineTranscriptFault("after-control-save", pipeline.id);
    if (saved.id === pipeline.id) {
      checkpoint.settle();
    } else {
      // Admission returned an equivalent pipeline instead of creating this
      // one, so transcripts committed under this id have no owner.
      this.transcriptCheckpoints.forget(pipeline.sessions);
      await this.storage.deleteBuildPipelineTranscriptsFor(pipeline.id).catch(() => undefined);
    }
    pipeline.backendRevision = saved.revision;
    this.noteRecord(pipeline.id, pipeline);
    return saved;
  }

  async withCodeRewindReservation<T>(pipeline: BuildPipeline, run: () => Promise<T>): Promise<T> {
    const fence = this.options.environmentFence ?? this.rewindFence;
    return fence.withExclusiveMutation(pipeline.environmentId, [], async () => {
      // Resolve the path only after moves/replacements are excluded. A write
      // already in flight on that path makes binding refuse the reservation.
      const environment = await this.storage.getEnvironment(pipeline.environmentId);
      if (!environment) throw new Error("Environment not found");
      fence.bindMovePaths(
        pipeline.environmentId,
        environment.worktreePath ? [environment.worktreePath] : [],
      );
      for (const record of await this.storage.listAllBuildPipelines()) {
        const sibling = record.snapshot;
        if (
          record.id !== pipeline.id &&
          isBuildPipeline(sibling) &&
          sibling.environmentId === pipeline.environmentId &&
          (isActiveBuildPhase(sibling.phase) ||
            sibling.sessions.some((session) => session.status === "running"))
        ) {
          throw new Error(
            "Another pipeline may write to this environment. Pause it before rewinding code.",
          );
        }
      }
      await this.options.assertEnvironmentQuiescent?.(pipeline.environmentId);
      return run();
    });
  }

  /** Resume an admitted reset before any control or supervisor can start work. */
  async finishPendingCodeRewind(pipeline: BuildPipeline): Promise<void> {
    const code = pipeline.rewinds?.at(-1)?.code;
    if (!code?.pending) return;
    const git = this.options.environmentGit;
    if (!git) throw new Error("Rewinding code is not available on this backend.");
    await this.withCodeRewindReservation(pipeline, async () => {
      await resetWorktreeToCommit(git, pipeline.environmentId, code);
      delete code.pending;
      try {
        await this.save(pipeline, pipeline.backendRevision);
      } catch (error) {
        code.pending = true;
        throw error;
      }
    });
  }

  async mutate(
    pipelineId: string,
    mutation: (pipeline: BuildPipeline) => void | Promise<void>,
    reserveCodeRewind?: (pipeline: BuildPipeline) => boolean,
  ): Promise<BuildPipeline> {
    const previous = this.locks.get(pipelineId) ?? Promise.resolve();
    let result: BuildPipeline | undefined;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const record = await this.requireRecord(pipelineId);
        const pipeline = record.snapshot as BuildPipeline;
        pipeline.backendRevision = record.revision;
        await this.finishPendingCodeRewind(pipeline);
        const commit = async () => {
          await mutation(pipeline);
          await this.save(pipeline, pipeline.backendRevision);
          await this.finishPendingCodeRewind(pipeline);
          result = pipeline;
        };
        if (reserveCodeRewind?.(pipeline)) await this.withCodeRewindReservation(pipeline, commit);
        else await commit();
      })
      .finally(() => {
        if (this.locks.get(pipelineId) === next) this.locks.delete(pipelineId);
      });
    this.locks.set(pipelineId, next);
    await next;
    return result!;
  }
}

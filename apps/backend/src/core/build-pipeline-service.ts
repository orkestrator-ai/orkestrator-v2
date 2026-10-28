/**
 * Backend-owned build pipeline service.
 *
 * A facade over collaborators that share one `BuildPipelineContext`
 * (`build-pipeline-context.ts`: storage, command invoker, options, the
 * in-memory locks, provider caches and timers, and the control-record save):
 *
 * - `build-pipeline-service-agents.ts`: provider resolution per environment
 *   and harness, bridge connections, step settings, and stopping a
 *   multi-model review's provider turns.
 * - `build-pipeline-service-recovery.ts`: stage completion (structured
 *   results, verification, pull requests), terminal reconciliation, and the
 *   interaction-resolution journal.
 * - `build-pipeline-service-interactions.ts`: unattended interaction
 *   enforcement, stage failure, and reconnect attempts.
 * - `build-pipeline-service-supervisor.ts`: the tick, the per-pipeline lock and
 *   the stage state machine.
 * - `build-pipeline-service-lifecycle.ts`: init/shutdown, admission, and the
 *   user controls.
 *
 * Each part takes the context and the parts it calls; none extends another
 * (`tests/unit/inheritance-chains.test.ts`). The one call that runs back up
 * the graph, recovery opening the next stage, goes through the
 * `BuildPipelineStageDispatch` port wired here.
 */
import type {
  BuildPipelineCodeRewindPreview,
  BuildPipeline,
  BuildPipelineAgent,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  BuildPipelineContext,
  type BuildPipelineServiceOptions,
} from "./build-pipeline-context.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { BuildPipelineAgents } from "./build-pipeline-service-agents.js";
import type { CommandInvoker } from "./build-pipeline-service-helpers.js";
import { BuildPipelineInteractions } from "./build-pipeline-service-interactions.js";
import { BuildPipelineLifecycle } from "./build-pipeline-service-lifecycle.js";
import { BuildPipelineRecovery } from "./build-pipeline-service-recovery.js";
import { BuildPipelineSupervisor } from "./build-pipeline-service-supervisor.js";
import type { StorageService } from "./storage.js";
import { WorkflowTranscriptArtifacts } from "./workflow-transcript-artifacts.js";
import type {
  KeyedWorkflowOwner,
  WorkflowReconcileReport,
  WorkflowSupervisorStatus,
  WorkflowWakeReason,
} from "./workflow-supervisor.js";

export type { BuildPipelineServiceOptions } from "./build-pipeline-context.js";

export class BuildPipelineService implements KeyedWorkflowOwner {
  private readonly context: BuildPipelineContext;
  private readonly agents: BuildPipelineAgents;
  private readonly recovery: BuildPipelineRecovery;
  private readonly interactions: BuildPipelineInteractions;
  private readonly stageSupervisor: BuildPipelineSupervisor;
  private readonly lifecycle: BuildPipelineLifecycle;
  private readonly transcriptArtifacts: WorkflowTranscriptArtifacts;

  constructor(
    storage: StorageService,
    invoke: CommandInvoker,
    options: BuildPipelineServiceOptions = {},
  ) {
    this.context = new BuildPipelineContext(storage, invoke, options);
    this.transcriptArtifacts = new WorkflowTranscriptArtifacts(options.artifactLedger);
    this.agents = new BuildPipelineAgents(this.context);
    // Completing a stage opens the next one, so recovery calls back into the
    // supervisor that calls it. Bound late: the supervisor is built below.
    this.recovery = new BuildPipelineRecovery(this.context, {
      startStage: (...args) => this.stageSupervisor.startStage(...args),
      dispatchPending: (...args) => this.stageSupervisor.dispatchPending(...args),
      assertValidationWorktreeUnchanged: (...args) =>
        this.stageSupervisor.assertValidationWorktreeUnchanged(...args),
      remindMissingStageResult: (...args) => this.stageSupervisor.remindMissingStageResult(...args),
    });
    this.interactions = new BuildPipelineInteractions(this.context, this.agents, this.recovery);
    this.stageSupervisor = new BuildPipelineSupervisor(
      this.context,
      this.agents,
      this.recovery,
      this.interactions,
    );
    this.lifecycle = new BuildPipelineLifecycle(
      this.context,
      this.agents,
      this.recovery,
      this.stageSupervisor,
    );
    // Verification is certified against the worktree it started from. Asking
    // at submission lets the verifier undo a stray file within its turn.
    options.workflowResults?.setAcceptanceCheck("verification-result", (attempt) =>
      this.stageSupervisor.verificationResultRefusal(attempt),
    );
  }

  // -------------------------------------------------------------------------
  // Scheduling

  init(): Promise<void> {
    return this.lifecycle.init();
  }

  shutdown(): Promise<void> {
    return this.lifecycle.shutdown();
  }

  wakeEnvironment(environmentId: string, reason: WorkflowWakeReason): void {
    this.lifecycle.wakeEnvironment(environmentId, reason);
  }

  schedulingStatus(): WorkflowSupervisorStatus | null {
    return this.lifecycle.schedulingStatus();
  }

  reconcileScheduling(): Promise<WorkflowReconcileReport | null> {
    return this.lifecycle.reconcileScheduling();
  }

  /** Immediate supervisor pass, also useful for deterministic backend tests. */
  advanceNow(pipelineId: string): Promise<void> {
    return this.lifecycle.advanceNow(pipelineId);
  }

  // -------------------------------------------------------------------------
  // Admission and user controls

  start(input: StartBuildPipelineInput): Promise<BuildPipeline> {
    return this.lifecycle.start(input);
  }

  importLegacy(
    projectId: string,
    snapshots: unknown[],
  ): Promise<{ importedIds: string[]; skipped: number }> {
    return this.lifecycle.importLegacy(projectId, snapshots);
  }

  pause(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.pause(pipelineId);
  }

  resume(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.resume(pipelineId);
  }

  sendMessage(pipelineId: string, text: string): Promise<BuildPipeline> {
    return this.lifecycle.sendMessage(pipelineId, text);
  }

  steerMessage(
    pipelineId: string,
    text: string,
  ): Promise<{ pipeline: BuildPipeline; delivery: "steered" | "queued" }> {
    return this.lifecycle.steerMessage(pipelineId, text);
  }

  retryReview(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.retryReview(pipelineId);
  }

  restartStep(pipelineId: string, stageId: string): Promise<BuildPipeline> {
    return this.lifecycle.restartStep(pipelineId, stageId);
  }

  previewCodeRewind(pipelineId: string, stageId: string): Promise<BuildPipelineCodeRewindPreview> {
    return this.lifecycle.previewCodeRewind(pipelineId, stageId);
  }

  rewindCode(pipelineId: string, stageId: string, expectedHead: string): Promise<BuildPipeline> {
    return this.lifecycle.rewindCode(pipelineId, stageId, expectedHead);
  }

  skipStep(pipelineId: string, stageId: string): Promise<BuildPipeline> {
    return this.lifecycle.skipStep(pipelineId, stageId);
  }

  restartCurrentStep(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.restartCurrentStep(pipelineId);
  }

  retryStage(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.retryStage(pipelineId);
  }

  retryReviewer(pipelineId: string, reviewerId: string): Promise<BuildPipeline> {
    return this.lifecycle.retryReviewer(pipelineId, reviewerId);
  }

  retryInteractionFailure(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.retryInteractionFailure(pipelineId);
  }

  cancel(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.cancel(pipelineId);
  }

  remove(pipelineId: string): Promise<void> {
    return this.lifecycle.remove(pipelineId);
  }

  retryCompletionComment(pipelineId: string): Promise<BuildPipeline> {
    return this.lifecycle.retryCompletionComment(pipelineId);
  }

  // -------------------------------------------------------------------------
  // Transcript reads

  /**
   * A stage transcript's rows with each publication of that stage session's
   * conversation placed beside the call that published it
   * (`workflow-transcript-artifacts.ts`). The session key is the conversation.
   */
  placeStageArtifacts(environmentId: string, sessionKey: string, rows: unknown[]): unknown[] {
    return this.transcriptArtifacts.place(environmentId, sessionKey, rows);
  }

  // -------------------------------------------------------------------------
  // Internals that backend tests reach through casts or a test subclass. They
  // forward to the collaborator that owns them, so a test observes and drives
  // exactly the state and code paths production uses.

  protected get options(): BuildPipelineServiceOptions {
    return this.context.options;
  }

  protected get providers(): Map<string, BuildPipelineProvider> {
    return this.context.providers;
  }

  protected get lastProviderAgent(): Map<string, BuildPipelineAgent> {
    return this.context.lastProviderAgent;
  }

  protected provider(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent = pipeline.agentType,
  ): Promise<BuildPipelineProvider> {
    return this.agents.provider(pipeline, agent);
  }

  protected requestTick(): Promise<void> {
    return this.stageSupervisor.requestTick();
  }

  protected executionPolicy(
    pipeline: BuildPipeline,
    origin: "build-pipeline" | "looped-review" = "build-pipeline",
  ): Promise<NativeAgentExecutionPolicy> {
    return this.context.executionPolicy(pipeline, origin);
  }

  protected restartMissingStage(pipeline: BuildPipeline): Promise<void> {
    return this.stageSupervisor.restartMissingStage(pipeline);
  }
}

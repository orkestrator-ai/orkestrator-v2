import { randomUUID } from "node:crypto";
import type {
  BuildPipeline,
  BuildPipelineAgent,
  PipelineSession,
  PendingPipelineInteractionResolution,
  ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  BUILD_PIPELINE_VERSION,
  isBuildPipeline,
  isActiveBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  agentInteractionPolicyAction,
  type AgentInteractionOutcome,
} from "@orkestrator/protocol/agent-interactions";
import type { Environment, PersistedBuildPipeline } from "./models.js";
import {
  ProviderUnavailableError,
  type BridgeConnection,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import { BuildPipelineServiceRecovery } from "./build-pipeline-service-recovery.js";
import {
  errorMessage,
  PreSessionStageStartError,
  sessionForCurrentPhase,
  resumablePhase,
  sessionAgent,
  elapsedSince,
  interactionPresentation,
  logInteractionOutcome,
} from "./build-pipeline-service-helpers.js";

export abstract class BuildPipelineServiceInteractions extends BuildPipelineServiceRecovery {
  protected async recordInteractionOutcome(
    pipeline: BuildPipeline,
    _session: PipelineSession,
    pending: PendingPipelineInteractionResolution,
    outcome: AgentInteractionOutcome,
    resolvedAt: number,
  ): Promise<void> {
    this.applyInteractionOutcome(pipeline, pending, outcome, resolvedAt);
    const inputSucceeded = pending.action === "decline-and-continue" && outcome === "auto-declined";
    await this.saveInteractionOutcome(pipeline, pending, outcome, resolvedAt);
    // The workflow outcome is durable from here. Advancing the journal is a
    // bookkeeping step that `finishDurablyRecordedInteractionJournalEntries`
    // repairs on the next start, so a transient journal write failure must not
    // convert a correctly resolved interaction into a failed build.
    await this.markInteractionWorkflowRecorded(pending, Date.now()).catch(() => undefined);
    logInteractionOutcome(
      pending,
      outcome,
      resolvedAt,
      inputSucceeded ? (pipeline.autoDeclineCount ?? 0) : 1,
    );
  }

  /**
   * Apply one unattended interaction per supervisor pass.
   *
   * Serialising provider work through the pipeline lock keeps a request off the
   * stdout/event loop and lets concurrent monitors converge on the journal
   * claim. Returning after one request also bounds each pass; the next tick
   * handles the next member of an authoritative snapshot.
   */
  protected async enforcePendingInteraction(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<boolean> {
    if (!provider.interactions) return false;
    const snapshot = await provider.interactions.listPendingInteractions(session.sdkSessionId);
    const journal = await this.storage.getAgentInteractionResolutionJournal();
    let pending = pipeline.pendingInteractionResolution;
    let journalEntry = pending
      ? journal.entries.find((entry) => entry.id === pending!.journalId)
      : undefined;

    if (pending && pending.sessionKey !== session.sessionKey) {
      throw new ProviderUnavailableError(
        "A pending interaction belongs to an inactive pipeline generation",
      );
    }

    if (!pending) {
      journalEntry = journal.entries.find(
        (entry) =>
          entry.claim.workflowType === "build-pipeline" &&
          entry.claim.workflowId === pipeline.id &&
          entry.claim.fence === session.sessionKey &&
          entry.state !== "workflow-recorded",
      );
      if (journalEntry) {
        const request = snapshot.requests.find((item) => item.id === journalEntry!.interactionId);
        const policyAction = agentInteractionPolicyAction(
          session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
          journalEntry.kind,
        );
        pending = request
          ? interactionPresentation(
              request,
              session,
              journalEntry.id,
              journalEntry.claim.claimedAt,
              policyAction === "decline-and-continue" ? "decline-and-continue" : "deny-and-fail",
            )
          : this.recoveredPendingInteraction(journalEntry, session);
        pipeline.pendingInteractionResolution = pending;
        if (!(await this.savePendingInteractionResolution(pipeline, pending))) {
          return true;
        }
      }
    }

    if (!pending) {
      const request = snapshot.requests[0];
      if (!request) return false;
      const policyAction = agentInteractionPolicyAction(
        session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        request.kind,
      );
      if (policyAction === "await-user") return false;
      journalEntry = await this.claimInteraction(pipeline, session, request);
      if (journalEntry.state === "workflow-recorded") {
        throw new ProviderUnavailableError(
          "A terminal interaction unexpectedly reappeared at the provider",
        );
      }
      pending = interactionPresentation(
        request,
        session,
        journalEntry.id,
        journalEntry.claim.claimedAt,
        policyAction === "decline-and-continue" ? "decline-and-continue" : "deny-and-fail",
      );
      pipeline.pendingInteractionResolution = pending;
      if (!(await this.savePendingInteractionResolution(pipeline, pending))) {
        return true;
      }
    }

    journalEntry ??= (await this.storage.getAgentInteractionResolutionJournal()).entries.find(
      (entry) => entry.id === pending!.journalId,
    );
    if (!journalEntry) {
      // Journal retention drops entries outright once it saturates, so a
      // missing claim is expected rather than a transport problem. Throwing
      // `ProviderUnavailableError` here would route to `recordReconnect`, which
      // disposes the provider on every tick and eventually fails the build with
      // a bridge-unreachable message that has nothing to do with the cause.
      if (this.interactionOutcomeIsDurable(pipeline, pending)) {
        delete pipeline.pendingInteractionResolution;
        await this.saveInteractionOutcome(
          pipeline,
          pending,
          pending.action === "decline-and-continue" ? "auto-declined" : "denied",
          Date.now(),
        );
        return true;
      }
      // The claim is gone without evidence that the provider was ever
      // answered, so fail closed and visibly rather than leaving the agent
      // invisibly parked on a request nobody will resolve.
      await this.recordInteractionOutcome(pipeline, session, pending, "failed", Date.now());
      return true;
    }
    if (journalEntry.state === "workflow-recorded") {
      if (!this.interactionOutcomeIsDurable(pipeline, pending)) {
        // Journal pruning reclaims an over-age or over-capacity live claim as a
        // terminal stale record. That is not evidence that the provider was
        // answered, so surface a safe workflow failure instead of clearing the
        // pending envelope and letting the agent remain invisibly parked.
        await this.recordInteractionOutcome(
          pipeline,
          session,
          pending,
          "failed",
          Math.max(Date.now(), journalEntry.workflowRecordedAt ?? 0),
        );
        return true;
      }
      delete pipeline.pendingInteractionResolution;
      await this.saveInteractionOutcome(
        pipeline,
        pending,
        journalEntry.outcome!,
        journalEntry.providerResolvedAt!,
      );
      return true;
    }
    if (journalEntry.state === "provider-resolved") {
      await this.recordInteractionOutcome(
        pipeline,
        session,
        pending,
        journalEntry.outcome!,
        journalEntry.providerResolvedAt!,
      );
      return true;
    }

    const processingToken = await this.acquireInteractionProcessingLease(pending);
    // Another backend process owns the bounded provider-response window. Leave
    // the durable request parked; a later pass either observes its terminal
    // journal transition or steals the lease after expiry and reconciles first.
    if (!processingToken) return true;

    // Acquisition may have waited behind another backend. Re-read after the
    // lease fence so absence/reappearance is decided from current provider
    // state, not from the snapshot used to build the presentation.
    const resolutionSnapshot = await provider.interactions.listPendingInteractions(
      session.sdkSessionId,
    );
    const requestStillLive = resolutionSnapshot.requests.some(
      (request) => request.id === pending!.interactionId,
    );
    let outcome: AgentInteractionOutcome;
    const resolvedAt = Date.now();
    if (!requestStillLive) {
      // The crash boundary may be immediately after the provider accepted the
      // response. A full authoritative snapshot proving absence is sufficient
      // reconciliation; never re-dispatch an ambiguous response.
      outcome = pending.action === "decline-and-continue" ? "auto-declined" : "denied";
    } else {
      const applied = await provider.interactions.resolveInteraction(
        session.sdkSessionId,
        pending.interactionId,
        {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: pending.interactionId,
          sessionId: session.sdkSessionId,
          action: pending.action === "decline-and-continue" ? "decline" : "deny",
          resolvedAt,
        },
      );
      let terminal = applied.result === "applied";
      if (applied.result === "already-resolved" || applied.result === "stale") {
        const reconciled = await provider.interactions.listPendingInteractions(
          session.sdkSessionId,
        );
        terminal = !reconciled.requests.some((request) => request.id === pending!.interactionId);
      }
      outcome = terminal
        ? pending.action === "decline-and-continue"
          ? "auto-declined"
          : "denied"
        : "failed";
    }
    const recorded = await this.markInteractionProviderResolved(
      pending,
      outcome,
      resolvedAt,
      processingToken,
    );
    // A lease can be stolen only after its bounded expiry. If that happened
    // while this provider call was in flight, the current owner is responsible
    // for reconciling and recording the result; never write through its fence.
    if (!recorded) return true;
    await this.recordInteractionOutcome(pipeline, session, pending, outcome, resolvedAt);
    if (outcome !== "auto-declined") {
      // The terminal workflow failure is already durable. Stopping the turn is
      // best-effort cleanup; a failed abort cannot erase or downgrade the
      // fail-closed outcome the user will rehydrate.
      await provider.abort(session.sdkSessionId).catch(() => undefined);
    }
    return true;
  }

  protected async bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{
        port: number;
        authToken?: string;
      }>(`start_local_${suffix}_server_cmd`, {
        environmentId: environment.id,
      });
      if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
      };
    }
    if (!environment.containerId) throw new Error("Build container is unavailable");
    const result = await this.invoke<{
      hostPort: number;
      authToken?: string;
    }>(`start_${suffix}_server`, {
      containerId: environment.containerId,
    });
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }

  protected async fail(pipelineId: string, error: unknown): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return;
    const pipeline = record.snapshot;
    if (!isActiveBuildPhase(pipeline.phase)) return;
    pipeline.backendRevision = record.revision;
    const abortErrors = await this.abandonReviewFanout(pipeline, "error");
    pipeline.error = abortErrors.length
      ? `${errorMessage(error)} Stopping every review agent could not be confirmed: ${abortErrors.map(errorMessage).join("; ")}`
      : errorMessage(error);
    pipeline.failureContext = {
      phase:
        error instanceof PreSessionStageStartError
          ? error.phase
          : (pipeline.phase as ResumableBuildPhase),
      kind: "stage-transition",
      sessionId:
        pipeline.reviewFanout || error instanceof PreSessionStageStartError
          ? undefined
          : sessionForCurrentPhase(pipeline)?.sdkSessionId,
    };
    const failedSession =
      pipeline.reviewFanout || error instanceof PreSessionStageStartError
        ? undefined
        : sessionForCurrentPhase(pipeline);
    if (failedSession) failedSession.status = "error";
    pipeline.phase = "failed";
    delete pipeline.pendingPromptAttempt;
    delete pipeline.stageRetryRequested;
    delete pipeline.stallWarning;
    this.provisioningPrompts.delete(pipeline.id);
    this.lastProviderAgent.delete(pipeline.id);
    await this.save(pipeline, record.revision);
    await this.reconcileTerminalState(pipeline);
  }

  protected async recordReconnect(
    pipelineId: string,
    error: ProviderUnavailableError,
  ): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return;
    const pipeline = record.snapshot;
    const phase = resumablePhase(pipeline.phase);
    if (!phase) return;
    // Evict the harness that actually failed. The stored snapshot cannot answer
    // that on its own: a stage transition resolves the next step's provider
    // before it records that step's session, so a `createSession` failure on the
    // review harness would look like a failure on the build harness here — and
    // dropping the healthy one would leave the unreachable one cached forever.
    const session = sessionForCurrentPhase(pipeline);
    const agent =
      this.lastProviderAgent.get(pipelineId) ??
      (session ? sessionAgent(pipeline, session) : pipeline.agentType);
    const providerKey = `${pipeline.environmentId}:${agent}`;
    const provider = this.providers.get(providerKey);
    this.providers.delete(providerKey);
    await provider?.dispose?.();
    // Only an attempt for this same harness carries its start time forward. A
    // different harness failing is a new outage and gets its own deadline,
    // rather than inheriting an elapsed time it did not accumulate.
    const previous = pipeline.reconnectAttempt;
    const continues =
      previous !== undefined && (previous.agent === undefined || previous.agent === agent);
    const startedAt = (continues ? previous.startedAt : undefined) ?? new Date().toISOString();
    const elapsed = elapsedSince(startedAt);
    if (elapsed !== null && elapsed >= this.reconnectDeadlineMs) {
      // Retrying forever is indistinguishable from working, from the outside.
      // Once the bridge has stayed unreachable past the deadline, say so rather
      // than leaving the user watching a stage that will never advance.
      await this.fail(
        pipelineId,
        new Error(
          `${agent} stayed unreachable for ${Math.round(elapsed / 1000)}s: ${error.message}`,
        ),
      );
      return;
    }
    pipeline.backendRevision = record.revision;
    pipeline.reconnectAttempt = {
      id: (continues ? previous.id : undefined) ?? randomUUID(),
      phase,
      kind: "stage-transition",
      // Only when this harness owns the current session. A stage transition
      // fails before its own session exists, and naming the previous stage's
      // session there would point recovery at a session on a healthy bridge.
      sessionId:
        session && sessionAgent(pipeline, session) === agent ? session.sdkSessionId : undefined,
      startedAt,
      agent,
    };
    pipeline.error = `Reconnecting to ${agent}: ${error.message}`;
    await this.save(pipeline, record.revision);
  }

  protected async mutate(
    pipelineId: string,
    mutation: (pipeline: BuildPipeline) => void | Promise<void>,
  ): Promise<BuildPipeline> {
    const previous = this.locks.get(pipelineId) ?? Promise.resolve();
    let result: BuildPipeline | undefined;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const record = await this.requireRecord(pipelineId);
        const pipeline = record.snapshot as BuildPipeline;
        pipeline.backendRevision = record.revision;
        await mutation(pipeline);
        await this.save(pipeline, record.revision);
        result = pipeline;
      })
      .finally(() => {
        if (this.locks.get(pipelineId) === next) this.locks.delete(pipelineId);
      });
    this.locks.set(pipelineId, next);
    await next;
    return result!;
  }

  protected async requireRecord(pipelineId: string): Promise<PersistedBuildPipeline> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) {
      throw new Error(`Build pipeline not found: ${pipelineId}`);
    }
    return record;
  }

  protected async save(
    pipeline: BuildPipeline,
    expectedRevision: number,
  ): Promise<PersistedBuildPipeline> {
    pipeline.controller = "backend";
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
    const saved = await this.storage.saveBuildPipeline(
      pipeline.id,
      pipeline.projectId,
      pipeline.environmentId,
      BUILD_PIPELINE_VERSION,
      pipeline,
      expectedRevision,
    );
    pipeline.backendRevision = saved.revision;
    return saved;
  }
}

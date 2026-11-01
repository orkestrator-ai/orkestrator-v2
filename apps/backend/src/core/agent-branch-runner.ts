/**
 * The shared agent branch runner (plan P2.4, report §8.3), extracted from the
 * reviewer fan-out so Multi Review reviewers, the pipeline's review panel and
 * graph agent activations run on the same hardened machinery.
 *
 * One `advance` moves one branch as far as it can go now:
 *
 * 1. **Admission and session creation** with the owner's explicit execution
 *    policy, journaled before anything is sent.
 * 2. **The dispatch journal**: the prompt is built and every fallible argument
 *    resolved while the branch is `prepared`; `dispatching` is made durable in
 *    the branch's own serialized write; `send` is the next fallible call; `sent`
 *    is recorded after. A recovered `dispatching` request is resolved only by
 *    proof (`provider-dispatch-recovery.ts`): `dispatched` (or a result for this
 *    exact request) promotes it, `absent` re-sends it under the same id, `lost`
 *    fails it, anything else parks it within the idle bound.
 * 3. **Observation**: unattended interactions are declined or denied, status is
 *    read, the owner's transcript mirror is refreshed, and a running turn's
 *    progress is measured against the stall thresholds.
 * 4. **Results**: the tool-transport slot or structured output is read and
 *    parsed by the owner; a contract failure becomes a bounded repair turn (3),
 *    a turn that settled without a result gets one reminder after the idle-poll
 *    bound, and a turn a provider restart cut short gets one continuation.
 * 5. **Acceptance**: the owner keeps the result, the branch is committed
 *    `completed`, and the slot is consumed through the owner's outbox.
 *
 * Token usage is metered throughout. The runner holds no state of its own
 * beyond its write queue and its host (`agent-branch-types.ts`).
 */
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS } from "@orkestrator/protocol/review-fanout";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { randomUUID } from "node:crypto";
import {
  ProviderUnreachableError,
  type ProviderDispatchStatus,
} from "./agent-provider-contract.js";
import {
  AgentBranchCommitQueue,
  isAgentBranchFenceError,
  type AgentBranchContext,
} from "./agent-branch-commits.js";
import { AgentBranchObserver } from "./agent-branch-observation.js";
import {
  agentBranchPollScope,
  clearAgentBranchStall,
  failAgentBranch,
  recordAgentBranchStall,
  recordAgentBranchUnavailable,
} from "./agent-branch-stall.js";
import {
  agentBranchResultTransport,
  prepareAgentBranchContinuation,
  prepareAgentBranchReminder,
  prepareAgentBranchRepair,
  prepareAgentBranchRestartContinuation,
  prepareAgentBranchUsageLimitContinuation,
} from "./agent-branch-turns.js";
import {
  AgentBranchDispatchSetupError,
  AgentBranchPolicyUnavailableError,
  AgentBranchResultError,
  agentBranchErrorMessage,
  agentBranchModel,
  agentBranchNowIso,
  type AgentBranchHost,
  type AgentBranchRecord,
  AGENT_BRANCH_LOG_PREFIX,
} from "./agent-branch-types.js";
import type { AgentToolConnection } from "./agent-tools.js";
import {
  AmbiguousPromptDispatchError,
  ProviderDispatchPreparationError,
  readProviderStatus,
  type BuildPipelineProvider,
  type ProviderPrepareDispatchOptions,
} from "./build-pipeline-provider.js";
import {
  efficiencyPlatform,
  recordEfficiency,
  type EfficiencyEvent,
} from "./multi-review-efficiency.js";
import { recoveredDispatchAcceptance } from "./provider-dispatch-recovery.js";
import { retainProvider } from "./provider-retirement.js";
import { PassTranscriptReader } from "./review-fanout-transcript.js";
import {
  beginWorkflowArtifactTurn,
  settleArtifactDispatchTurn,
  type WorkflowArtifactTurnOptions,
} from "./workflow-artifact-turns.js";
import {
  LAST_ASSISTANT_TEXT_READ_LIMIT,
  lastAssistantText,
  missingWorkflowResultMessage,
} from "./workflow-result-missing.js";

/**
 * Attach the provider's agent process before a prompt is written.
 *
 * Best-effort by contract: the prompt request performs the same work and is the
 * one that answers authoritatively, so a failure here is left for it to report
 * rather than pre-empting it.
 */
export async function attachAgentBeforeDispatch(
  provider: BuildPipelineProvider,
  providerSessionId: string,
  options?: ProviderPrepareDispatchOptions,
  logPrefix: string = AGENT_BRANCH_LOG_PREFIX,
): Promise<void> {
  try {
    await provider.prepareDispatch?.(providerSessionId, options);
  } catch (error) {
    console.warn(
      `${logPrefix} Attaching the agent before dispatch failed:`,
      agentBranchErrorMessage(error),
    );
  }
}

/**
 * Answers every interaction an unattended session is parked on.
 *
 * Nobody is watching an unattended branch, so a request that would block the
 * turn is declined, and one that would grant access is denied. Both are
 * fail-closed: an unanswered request wedges the branch, and its owner does not
 * advance while the branch is still running.
 *
 * Deliberately *not* the build pipeline's own `enforcePendingInteraction`,
 * which journals through a single `pendingInteractionResolution` slot on the
 * pipeline. That slot has one owner; N concurrent branches would contend for
 * it and the guard would reject every session but one.
 */
export async function resolveUnattendedReviewerInteractions(
  provider: BuildPipelineProvider,
  providerSessionId: string,
  assertFence: () => Promise<void>,
): Promise<void> {
  if (!provider.interactions) return;
  const snapshot = await provider.interactions.listPendingInteractions(providerSessionId);
  await assertFence();
  for (const request of snapshot.requests) {
    const action =
      request.kind === "question" ||
      request.kind === "mcp-form" ||
      request.kind === "elicitation" ||
      request.kind === "terminal-selection"
        ? ("decline" as const)
        : ("deny" as const);
    await provider.interactions.resolveInteraction(providerSessionId, request.id, {
      version: 1,
      interactionId: request.id,
      sessionId: providerSessionId,
      action,
      resolvedAt: Date.now(),
    });
    await assertFence();
  }
}

/** The interaction registration of an unattended branch session. */
export function unattendedBranchInteraction(input: {
  origin: "automated-review" | "build-pipeline";
  phase: string;
  workflowId: string;
  provider: AgentBranchRecord["agent"];
  fence: string | undefined;
  reviewerSession?: boolean;
}) {
  return {
    origin: input.origin,
    interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
    ...(input.reviewerSession ? { reviewerSession: true } : {}),
    phase: input.phase,
    workflowId: input.workflowId,
    provider: input.provider,
    fence: input.fence,
  };
}

/** The prompt with the turn's result instruction appended, when it has one. */
function withResultInstruction(prompt: string, instruction: string): string {
  return instruction ? `${prompt}\n\n${instruction}` : prompt;
}

export class AgentBranchRunner<B extends AgentBranchRecord> {
  private readonly commits: AgentBranchCommitQueue;
  private readonly context: AgentBranchContext<B>;
  private readonly observer: AgentBranchObserver<B>;
  private passStartedAt = Date.now();

  constructor(private readonly host: AgentBranchHost<B>) {
    const record = (event: Omit<EfficiencyEvent, "owner">) => this.record(event);
    this.commits = new AgentBranchCommitQueue(
      () => host.save(),
      record,
      host.logPrefix ?? AGENT_BRANCH_LOG_PREFIX,
    );
    this.context = { host, commits: this.commits, record };
    this.observer = new AgentBranchObserver(this.context);
  }

  /** Content-free measurement; a no-op without an observer. */
  record(event: Omit<EfficiencyEvent, "owner">): void {
    recordEfficiency(this.host.efficiency, {
      owner: this.host.efficiencyOwner ?? "multi-review",
      phase: this.host.efficiencyPhase ?? "reviewing",
      ...event,
    });
  }

  /** Starts a pass: dispatch skew is measured from here. */
  beginPass(): number {
    this.passStartedAt = Date.now();
    return this.passStartedAt;
  }

  /** See {@link AgentBranchCommitQueue.commit}. */
  commit(transition?: { apply(): void; revert(): void }): Promise<void> {
    return this.commits.commit(transition);
  }

  stageObservation(): void {
    this.commits.stageObservation();
  }

  flushObservations(): Promise<void> {
    return this.commits.flushObservations();
  }

  /** Errors that must not be absorbed into one branch's `error` field. */
  isFatal(error: unknown): boolean {
    return isAgentBranchFenceError(error);
  }

  /**
   * Aborts branch turns the owner is about to stop supervising. The session
   * ids are kept so the read-only transcripts stay reachable.
   */
  async abandonLive(branches: readonly B[]): Promise<void> {
    await Promise.all(
      branches
        .filter((branch) => branch.status === "running" && branch.providerSessionId)
        .map((branch) => this.host.abandonSession(branch, branch.providerSessionId!)),
    );
  }

  /**
   * Queues an owner's own continuation turn in the branch's session (see
   * `prepareAgentBranchContinuation`); the next advance sends it.
   */
  prepareContinuation(branch: B, prompt: string): Promise<void> {
    return prepareAgentBranchContinuation(this.context, branch, prompt);
  }

  /**
   * One branch's advance inside its own failure boundary. Rethrows only what
   * must end the pass: the host's pass-fatal errors and a lost fence.
   */
  async advanceIsolated(branch: B, index: number, count: number): Promise<void> {
    try {
      await this.advance(branch, index, count);
    } catch (error) {
      if (this.host.isPassFatal?.(error)) throw error;
      if (this.isFatal(error)) {
        this.record({ operation: "reviewer.task", outcome: "fenced" });
        throw error;
      }
      if (
        error instanceof AgentBranchPolicyUnavailableError ||
        error instanceof AgentBranchDispatchSetupError
      ) {
        // The branch is still durably prepared. Leave it retryable instead
        // of converting a pre-prompt failure into a terminal result; its peers
        // carry on regardless.
        this.record({ operation: "reviewer.task", outcome: "retryable" });
        return;
      }
      // The failure may have been raised while the provider turn was still
      // executing. Abort the session best-effort so that turn cannot keep
      // running; the session id is kept so the read-only transcript stays
      // reachable and a later retry can abort again without harm.
      if (branch.providerSessionId) {
        await this.host.abandonSession(branch, branch.providerSessionId);
        this.host.progress.forget(branch.providerSessionId);
      }
      branch.status = "failed";
      branch.error = agentBranchErrorMessage(error).slice(0, 4_096);
      branch.completedAt = agentBranchNowIso();
      this.host.clearAdmission?.(branch);
      delete branch.idleResultPolls;
      delete branch.stalledSince;
      this.host.branchFailed?.(
        branch,
        error instanceof AgentBranchResultError
          ? "result"
          : error instanceof ProviderUnreachableError ||
              (error instanceof Error && error.name === "ProviderSessionFailedError")
            ? "provider"
            : "system",
      );
      this.record({ operation: "reviewer.task", outcome: "failed" });
      await this.commits.commit();
    }
  }

  /**
   * Advances one branch. `stop` means this branch has nothing more to do this
   * pass (a parked dispatch, a queued follow-up turn); its peers are unaffected.
   */
  async advance(branch: B, index: number, count: number): Promise<"continue" | "stop"> {
    const host = this.host;
    let provider: BuildPipelineProvider;
    try {
      provider = await host.provider(branch);
    } catch (error) {
      // Reconnection is observation of an existing turn, not a new dispatch.
      // Startup backoff must share the same bound as an unreachable transport.
      if (
        branch.status === "running" &&
        branch.providerSessionId &&
        (branch.dispatchState === "sent" || branch.dispatchState === "dispatching") &&
        (error instanceof ProviderUnreachableError ||
          (typeof error === "object" &&
            error !== null &&
            "retryable" in error &&
            error.retryable === true))
      ) {
        return recordAgentBranchUnavailable(this.context, branch, error);
      }
      throw error;
    }
    const release = retainProvider(provider);
    try {
      return await this.advanceWithProvider(branch, index, count, provider);
    } finally {
      release();
    }
  }

  /** See `ReviewFanoutHost.artifactTurns`. Best-effort; never blocks a dispatch. */
  private beginArtifactTurn(
    branch: B,
    index: number,
    agentMcp: AgentToolConnection | undefined,
  ): WorkflowArtifactTurnOptions | undefined {
    const turns = this.host.artifactTurns;
    if (!turns || !branch.providerSessionId || !branch.requestId) return undefined;
    return beginWorkflowArtifactTurn(turns.dispatch, {
      environmentId: turns.environmentId,
      projectId: turns.projectId,
      conversationKey: branch.sessionKey ?? this.host.sessionKeyFor(branch, index),
      turnId: branch.requestId,
      providerSessionId: branch.providerSessionId,
      agent: branch.agent,
      ...(agentMcp ? { agentMcp } : {}),
    });
  }

  private settleArtifactTurn(branch: B, index: number): void {
    const turns = this.host.artifactTurns;
    if (!turns || !branch.requestId) return;
    settleArtifactDispatchTurn(
      turns.dispatch,
      turns.environmentId,
      branch.sessionKey ?? this.host.sessionKeyFor(branch, index),
      branch.requestId,
    );
  }

  private async advanceWithProvider(
    branch: B,
    index: number,
    count: number,
    provider: BuildPipelineProvider,
  ): Promise<"continue" | "stop"> {
    const host = this.host;
    await host.assertFence();
    if (branch.status === "pending") {
      const sessionKey = host.sessionKeyFor(branch, index);
      const createStarted = Date.now();
      const providerSessionId = await provider.createSession(
        host.sessionPhase as never,
        host.sessionLabelFor(branch, index),
        {
          clientSessionKey: sessionKey,
          mode: host.mode ?? "build",
          ...(host.mode === "plan" ? { readOnly: true } : {}),
          ...(host.reviewerSession?.(branch) !== false ? { reviewerSession: true } : {}),
          model: agentBranchModel(branch),
          effort: branch.reasoningEffort,
          ...(typeof branch.fastMode === "boolean" ? { fastMode: branch.fastMode } : {}),
          policy: await host.executionPolicy(branch),
          interaction: host.interactionContext(branch, sessionKey),
        },
      );
      this.record({
        operation: "reviewer.create",
        platform: efficiencyPlatform(branch.agent),
        elapsedMs: Date.now() - createStarted,
      });
      await host.assertFence();
      branch.sessionKey = sessionKey;
      branch.providerSessionId = providerSessionId;
      branch.requestId = randomUUID();
      branch.dispatchState = "prepared";
      branch.resultTransport = agentBranchResultTransport(this.context, branch);
      branch.resultSubmission = branch.resultTransport === "tool-v1" ? "preparing" : undefined;
      branch.status = "running";
      branch.startedAt = agentBranchNowIso();
      host.clearAdmission?.(branch);
      delete branch.tokenCount;
      delete branch.cacheReadTokens;
      delete branch.usageFinalizationPolls;
      // A new session reports its own boundary.
      delete branch.commandSandboxOff;
      host.pollGate?.clear(agentBranchPollScope(this.context, branch, "usage"));
      delete branch.progressAt;
      delete branch.progressDigest;
      delete branch.stalledSince;
      delete branch.continuationPrompt;
      await this.commits.commit();
    }
    if (!branch.providerSessionId || !branch.requestId) return "continue";
    provider.registerSession?.(
      branch.providerSessionId,
      host.interactionContext(branch, branch.sessionKey),
    );
    if (branch.dispatchState === "prepared") {
      const sent = await this.dispatch(branch, index, count, provider);
      if (sent === "stop") return "stop";
    }
    if (branch.dispatchState === "dispatching") {
      // A durable intent is not acceptance. In particular, session status may
      // still describe the request replaced by this continuation. Providers
      // without request-scoped proof stay parked within the idle-poll bound;
      // neither unknown nor a retired (lost) ID is safe to resend.
      const acceptance = await this.recoveredDispatchAcceptance(provider, branch);
      await host.assertFence();
      if (acceptance === "lost") {
        // Retired for good: the provider refuses this id, and a new one could
        // run the same turn twice. Waiting out the idle bound changes nothing.
        return failAgentBranch(
          this.context,
          branch,
          `The ${host.wording.subject} dispatch was lost in a provider restart and cannot be resent safely`,
        );
      }
      if (acceptance === "absent") {
        // The provider proves the id never reached it: a send that never
        // happened, so back to `prepared` exactly as a send refused before the
        // prompt was written. The next pass re-runs admission and sends it again
        // under the same id; a late delivery of the first attempt is then the
        // provider's duplicate.
        branch.dispatchState = "prepared";
        delete branch.idleResultPolls;
        host.pollGate?.clear(agentBranchPollScope(this.context, branch, "idle"));
        await this.commits.commit();
        return "continue";
      }
      if (acceptance !== "dispatched") {
        return recordAgentBranchStall(
          this.context,
          branch,
          `The ${host.wording.subject} dispatch acceptance could not be confirmed`,
        );
      }
      branch.dispatchState = "sent";
      delete branch.continuationPrompt;
      delete branch.idleResultPolls;
      host.pollGate?.clear(agentBranchPollScope(this.context, branch, "idle"));
      await this.commits.commit();
    }
    if (branch.status !== "running") return "continue";
    return this.observe(branch, index, provider);
  }

  /** The `prepared → dispatching → send → sent` step of one request. */
  private async dispatch(
    branch: B,
    index: number,
    count: number,
    provider: BuildPipelineProvider,
  ): Promise<"continue" | "stop"> {
    const host = this.host;
    const providerSessionId = branch.providerSessionId!;
    const requestId = branch.requestId!;
    // Built before the dispatch is journaled: evidence for the prompt may be a
    // command round trip that can be slow or fail, and nothing about it is
    // ambiguous while `dispatchState` is still `prepared`.
    //
    // A schema repair re-sends a prompt this branch already answered, so it
    // needs no evidence. Gating it would turn an already-handled formatting
    // retry into a whole-owner failure over drift the branch's own authorised
    // validation writes caused.
    let prompt = branch.schemaRepairPrompt ?? branch.continuationPrompt;
    if (!prompt) {
      prompt = await host.branchPrompt(branch, index, count);
      this.record({ operation: "reviewer.prompt", bytes: Buffer.byteLength(prompt, "utf8") });
    }
    await host.assertFence();
    const toolTransport = branch.resultTransport === "tool-v1";
    const agentMcp = toolTransport ? await host.agentMcp?.(branch, requestId) : undefined;
    if (toolTransport && host.prepareResult) {
      await host.prepareResult(branch, requestId, host.resultSchema(branch));
    }
    let reviewShellPolicy: NativeAgentExecutionPolicy | undefined;
    if (host.mode === "plan" && branch.agent === "opencode") {
      try {
        // Resolve every fallible argument before opening the at-most-once
        // window. Once `dispatching` is saved, the next await must be send.
        reviewShellPolicy = await host.executionPolicy(branch);
      } catch (error) {
        throw new AgentBranchPolicyUnavailableError(error);
      }
    }
    const resultTurn = host.resultTurn(branch, requestId);
    const artifactTurn = this.beginArtifactTurn(branch, index, agentMcp);
    const turnAgentMcp = artifactTurn?.agentMcp ?? agentMcp;
    try {
      // Attach after the connection is resolved so broker registration happens
      // outside the at-most-once window.
      await attachAgentBeforeDispatch(
        provider,
        providerSessionId,
        turnAgentMcp ? { agentMcp: turnAgentMcp, ...resultTurn.prepare } : undefined,
        host.logPrefix,
      );
      // Other branches may be committing concurrently; this branch's own
      // journal is what matters. Its `dispatching` write is durable once this
      // await resolves, and `send` is the next branch-local fallible call.
      // Set inside the write, so no peer's save can make it durable first.
      await this.commits.commit({
        apply: () => {
          branch.dispatchState = "dispatching";
        },
        revert: () => {
          branch.dispatchState = "prepared";
        },
      });
    } catch (error) {
      this.settleArtifactTurn(branch, index);
      throw error;
    }
    const sendStarted = Date.now();
    try {
      await provider.send(
        providerSessionId,
        withResultInstruction(
          prompt,
          toolTransport ? host.resultInstruction(branch, requestId, agentMcp) : "",
        ),
        {
          requestId,
          schema: toolTransport ? undefined : host.resultSchema(branch),
          mode: host.mode ?? "build",
          ...(host.mode === "plan" ? { readOnly: true } : {}),
          ...(reviewShellPolicy ? { reviewShellPolicy } : {}),
          model: agentBranchModel(branch),
          effort: branch.reasoningEffort,
          ...(typeof branch.fastMode === "boolean" ? { fastMode: branch.fastMode } : {}),
          ...(turnAgentMcp ? { agentMcp: turnAgentMcp } : {}),
          ...(artifactTurn?.artifactGrant ? { artifactGrant: artifactTurn.artifactGrant } : {}),
          ...(agentMcp ? resultTurn.send : {}),
        },
      );
    } catch (error) {
      // An ambiguous send may still be running; its grant settles with the
      // turn. A refused one never ran, so its grant must not outlive it.
      if (!(error instanceof AmbiguousPromptDispatchError)) {
        this.settleArtifactTurn(branch, index);
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        this.record({
          operation: "reviewer.send",
          outcome: "ambiguous",
          platform: efficiencyPlatform(branch.agent),
          elapsedMs: Date.now() - sendStarted,
        });
        return "stop";
      }
      branch.dispatchState = "prepared";
      await this.commits.commit();
      if (error instanceof ProviderDispatchPreparationError) {
        throw new AgentBranchDispatchSetupError(error);
      }
      throw error;
    }
    const sentAt = Date.now();
    this.record({
      operation: "reviewer.send",
      outcome: "success",
      platform: efficiencyPlatform(branch.agent),
      elapsedMs: sentAt - sendStarted,
    });
    this.record({
      operation: "reviewer.dispatch_skew",
      reviewers: count,
      elapsedMs: sentAt - this.passStartedAt,
    });
    await host.assertFence();
    branch.dispatchState = "sent";
    delete branch.continuationPrompt;
    await this.commits.commit();
    return "continue";
  }

  /** Status, transcript, progress and result of a dispatched request. */
  private async observe(
    branch: B,
    index: number,
    provider: BuildPipelineProvider,
  ): Promise<"continue" | "stop"> {
    const host = this.host;
    const providerSessionId = branch.providerSessionId!;
    const requestId = branch.requestId!;
    // Read as data so the terminal-failure branch below fires whether or not
    // the provider explained itself, and can report the explanation when it did.
    const statusStarted = Date.now();
    let observation: Awaited<ReturnType<typeof readProviderStatus>>;
    try {
      await host.resolveUnattendedInteractions(provider, providerSessionId);
      observation = await readProviderStatus(provider, providerSessionId, requestId);
    } catch (error) {
      if (!(error instanceof ProviderUnreachableError)) throw error;
      // A bridge that cannot be reached is an observation fault, not the
      // branch's: keep its state and look again when due. The host drops its
      // cached provider so the next pass reconnects, which restarts a local
      // bridge that died; the idle-poll bound still fails a branch whose
      // bridge never comes back.
      await host.providerUnavailable?.(branch, provider);
      return recordAgentBranchUnavailable(this.context, branch, error);
    }
    this.record({
      operation: "reviewer.status",
      platform: efficiencyPlatform(branch.agent),
      elapsedMs: Date.now() - statusStarted,
    });
    const { status, error: statusDetail } = observation;
    await host.assertFence();
    // Kept once seen: the turn's commands ran without the sandbox even if a
    // later read no longer says so. The owner names the boundary.
    if (
      observation.commandSandboxOff !== undefined &&
      branch.commandSandboxOff !== observation.commandSandboxOff
    ) {
      branch.commandSandboxOff = observation.commandSandboxOff;
      await this.commits.commit();
    }
    if ((status === "idle" || status === "error") && observation.turnSettled === false)
      return "continue";
    const transcript = new PassTranscriptReader(provider, providerSessionId, {
      observer: host.efficiency,
      owner: host.efficiencyOwner ?? "multi-review",
    });
    const settling = status !== "running" && observation.backgroundWorkLive !== true;
    await this.observer.mirrorTranscript(branch, index, provider, transcript, settling);
    // The turn ended: its artifact grant ends with it. A reminder, repair or
    // continuation turn is dispatched under a new request id with its own.
    if (settling) this.settleArtifactTurn(branch, index);
    if (status === "running") {
      await clearAgentBranchStall(this.context, branch);
      await this.observer.nudgeUncommittedResult(provider, branch);
      return this.observer.observeProgress(provider, branch, transcript, observation.contextUsage);
    }
    // Outside the running path the turn is settling, so this read is bounded
    // by the stall and usage-finalization budgets rather than once per pass.
    const finalUsage = () =>
      this.observer.refreshUsage(
        branch,
        provider,
        observation.contextUsage,
        this.observer.usageNeedsTranscript(provider, observation.contextUsage)
          ? transcript.read(provider.usageMessageLimit)
          : undefined,
      );
    if (status === "blocked") {
      await finalUsage();
      // Every unattended interaction was already resolved above, and a provider
      // without an interaction surface can never be unblocked from here. Bound
      // the wait the same way the idle path is bounded rather than polling a
      // stalled branch forever.
      return recordAgentBranchStall(
        this.context,
        branch,
        `The ${host.wording.subject} stayed blocked without a resolvable interaction`,
      );
    }
    const failSession = async (): Promise<"continue"> => {
      await finalUsage();
      branch.status = "failed";
      branch.completedAt = agentBranchNowIso();
      branch.error =
        status === "missing"
          ? `The ${host.wording.subject} session no longer exists`
          : statusDetail
            ? `The ${host.wording.subject} session failed: ${statusDetail}`
            : `The ${host.wording.subject} session failed`;
      host.branchFailed?.(branch, "provider");
      await this.commits.commit();
      return "continue";
    };
    // A provider restart that cut the turn short is not the branch's
    // failure: a result it already submitted is still accepted below, and
    // otherwise the same session continues the work once.
    const restartInterrupted = status === "error" && observation.interruption === "restart";
    // Nor is the weekly limit, once automatic switching moved this machine: a
    // result it submitted is still accepted, and otherwise the session continues
    // on the new account.
    let usageLimitResend = false;
    if (status === "error" && !restartInterrupted && host.environmentId) {
      const verdict = await provider.usageLimitStop?.({
        environmentId: host.environmentId,
        requestId,
        error: statusDetail,
        resends: branch.usageLimitResends ?? 0,
        ...(branch.startedAt ? { turnStartedAt: branch.startedAt } : {}),
      });
      await host.assertFence();
      if (verdict === "wait") return "continue";
      usageLimitResend = verdict === "resend";
    }
    if ((status === "error" && !restartInterrupted && !usageLimitResend) || status === "missing") {
      return failSession();
    }
    if (branch.resultTransport === "tool-v1") {
      branch.resultSubmission = await host.projectResult?.(requestId);
    }
    const result =
      branch.resultTransport === "tool-v1"
        ? ((await host.readResult?.<unknown>(requestId)) ?? null)
        : await provider.structured<unknown>(providerSessionId, requestId);
    await host.assertFence();
    const resultTurn = host.resultTurn(branch, requestId);
    if (usageLimitResend && result?.ok !== true) {
      await finalUsage();
      await prepareAgentBranchUsageLimitContinuation(this.context, branch, resultTurn.toolName);
      // The next pass reconnects, which is what moves the bridge to the new account.
      await host.providerUnavailable?.(branch, provider);
      return "stop";
    }
    // An interrupted structured-output turn records a provider failure, not a
    // result; only an accepted result outlives the restart.
    if (restartInterrupted && result?.ok !== true) {
      await finalUsage();
      if (await prepareAgentBranchRestartContinuation(this.context, branch, resultTurn.toolName)) {
        return "stop";
      }
      return failSession();
    }
    if (!result) {
      if (observation.backgroundWorkLive) {
        // The branch ended its turn to wait on background agents it launched;
        // the provider resumes it when they settle. That is progress, not an
        // idle branch, so it stays bounded by the transcript stall clock —
        // and its usage by the probe throttle, not by every pass.
        await clearAgentBranchStall(this.context, branch);
        return this.observer.observeProgress(
          provider,
          branch,
          transcript,
          observation.contextUsage,
        );
      }
      await finalUsage();
      const finalText = async () =>
        lastAssistantText(
          await transcript
            .read(
              Math.min(
                LAST_ASSISTANT_TEXT_READ_LIMIT,
                provider.messageReadLimit ?? LAST_ASSISTANT_TEXT_READ_LIMIT,
              ),
            )
            .catch(() => undefined),
        );
      return recordAgentBranchStall(
        this.context,
        branch,
        async () =>
          branch.resultTransport === "tool-v1"
            ? missingWorkflowResultMessage({
                subject: `The ${host.wording.subject}`,
                resultLabel: host.wording.resultLabel,
                toolName: resultTurn.toolName,
                submission: branch.resultSubmission,
                finalText: await finalText(),
              })
            : `The ${host.wording.subject} became idle without returning its ${host.wording.resultLabel}`,
        () => prepareAgentBranchReminder(this.context, branch, resultTurn.toolName, finalText),
        "result",
      );
    }
    await finalUsage();
    const parsed = host.parseResult(branch, result);
    if (!parsed.success) {
      return prepareAgentBranchRepair(this.context, branch, parsed.error);
    }
    const usageScope = agentBranchPollScope(this.context, branch, "usage");
    if (
      host.captureUsage &&
      observation.usagePending === true &&
      (branch.usageFinalizationPolls ?? 0) < REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS &&
      !host.pollGate?.exhausted(
        usageScope,
        branch.usageFinalizationPolls ?? 0,
        REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS,
      )
    ) {
      // A probe that does not count (a wakeup burst) simply looks again later.
      if (host.pollGate && !host.pollGate.count(usageScope)) return "continue";
      branch.usageFinalizationPolls = (branch.usageFinalizationPolls ?? 0) + 1;
      await this.commits.commit();
      return "continue";
    }
    return this.accept(branch, requestId, providerSessionId, parsed.data);
  }

  /** Keeps an accepted result, commits the branch `completed`, consumes the slot. */
  private async accept(
    branch: B,
    requestId: string,
    providerSessionId: string,
    data: unknown,
  ): Promise<"continue"> {
    const host = this.host;
    const accepted = host.acceptResult(branch, data);
    if (accepted) await accepted;
    branch.status = "completed";
    branch.completedAt = agentBranchNowIso();
    delete branch.schemaRepairPrompt;
    delete branch.continuationPrompt;
    delete branch.idleResultPolls;
    delete branch.usageFinalizationPolls;
    delete branch.stalledSince;
    host.progress.forget(providerSessionId);
    delete branch.progressDigest;
    if (branch.resultTransport === "tool-v1") {
      host.stageResultConsumption?.(requestId);
    }
    await this.commits.commit();
    if (branch.resultTransport === "tool-v1") {
      try {
        await host.consumeResult?.(requestId);
        delete branch.resultSubmission;
        host.finishResultConsumption?.(requestId);
        await this.commits.commit();
      } catch (error) {
        // A lost fence is not a deferred consumption: the owner that took over
        // consumes the result, and this pass must stop.
        if (this.isFatal(error)) throw error;
        host.stageResultConsumption?.(requestId);
        console.warn(
          `${host.logPrefix ?? AGENT_BRANCH_LOG_PREFIX} Deferred result consumption: ${agentBranchErrorMessage(error)}`,
        );
      }
    }
    return "continue";
  }

  /**
   * What can be proven about a recovered `dispatching` request.
   *
   * The provider's dispatch journal answers first. A result for this exact
   * request id is proof too, from the one place it could only have come from
   * its own turn: the tool-transport slot is keyed by the request and written
   * with that attempt's capability, and a structured result names its request.
   * A result submitted before a provider restart retired the id is used rather
   * than discarded with the turn it came from, and outranks an `absent` answer.
   */
  private async recoveredDispatchAcceptance(
    provider: BuildPipelineProvider,
    branch: B,
  ): Promise<ProviderDispatchStatus> {
    return recoveredDispatchAcceptance(
      provider,
      branch.providerSessionId!,
      branch.requestId!,
      branch.resultTransport === "tool-v1"
        ? () =>
            this.host.dispatchProof
              ? this.host.dispatchProof<unknown>(branch.requestId!)
              : this.host.readResult?.<unknown>(branch.requestId!)
        : undefined,
    );
  }
}

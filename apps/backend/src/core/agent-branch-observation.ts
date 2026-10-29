/**
 * Observation of a running agent branch: token metering, transcript progress
 * against the stall thresholds, the owner's transcript mirror, and the one
 * nudge that asks a live turn to commit a result it already validated.
 *
 * Usage and progress are observations: they are staged for the pass's single
 * checkpoint, never a write of their own, except where they end the branch.
 */
import { randomUUID } from "node:crypto";
import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import type { AgentBranchContext } from "./agent-branch-commits.js";
import { isAgentBranchFenceError } from "./agent-branch-commits.js";
import {
  agentBranchErrorMessage,
  agentBranchNowIso,
  type AgentBranchRecord,
} from "./agent-branch-types.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { EfficiencyEvent } from "./multi-review-efficiency.js";
import {
  DEFAULT_STALL_ABANDON_MS,
  DEFAULT_STALL_WARNING_MS,
  noProgressElapsedMs,
  stalledMinutes,
  type ProgressObservation,
} from "./multi-review-progress.js";
import type { PassTranscriptReader } from "./review-fanout-transcript.js";
import {
  hasProgressSnapshot,
  readTranscriptProgressSample,
  type ProgressReadKind,
} from "./transcript-progress.js";

/**
 * How long a validated, uncommitted result may sit before the live turn is
 * nudged to commit it. Long enough that a model finishing its last read is not
 * interrupted, short enough that a model fighting its own tool calls is not
 * left to spin for minutes.
 */
export const AGENT_BRANCH_RESULT_COMMIT_NUDGE_MS = 90_000;

/** Content-free measurement of how each due progress probe was answered. */
const PROGRESS_READ_OPERATIONS = {
  unchanged: "transcript.progress_unchanged",
  snapshot: "transcript.progress_snapshot",
  fallback: "transcript.progress_fallback",
} as const satisfies Record<ProgressReadKind, EfficiencyEvent["operation"]>;

/** The usage counters a branch keeps from a provider observation. */
export type AgentBranchObservedUsage = Pick<
  NativeAgentContextUsage,
  "sessionTokens" | "cacheReadTokens"
>;

function usageCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Apply a probe to the durable progress clocks.
 *
 * `reset` — the transcript moved; the stall clock starts from now.
 * `hold` — first comparable sample of a session that has no clock yet; the
 * caller must not treat it as "unchanged" or a `stallAbandonMs: 0` test would
 * fail a branch on its first successful read.
 * `evaluate` — unchanged, failed, throttled, or a restart of a session that
 * already has a durable clock. The caller then applies the stall thresholds.
 */
export function commitProgressObservation(
  target: { progressAt?: string; stalledSince?: string; progressDigest?: string },
  observation: ProgressObservation,
): "reset" | "hold" | "evaluate" {
  if (observation.probed && observation.digest) {
    target.progressDigest = observation.digest;
  }
  if (observation.changed) {
    target.progressAt = agentBranchNowIso();
    delete target.stalledSince;
    return "reset";
  }
  if (observation.baselineEstablished && target.progressAt === undefined) {
    target.progressAt = agentBranchNowIso();
    return "hold";
  }
  return "evaluate";
}

export class AgentBranchObserver<B extends AgentBranchRecord> {
  constructor(private readonly context: AgentBranchContext<B>) {}

  private get host() {
    return this.context.host;
  }

  private stallWarningMs(): number {
    return this.host.stallWarningMs ?? DEFAULT_STALL_WARNING_MS;
  }

  private stallAbandonMs(): number {
    return this.host.stallAbandonMs ?? DEFAULT_STALL_ABANDON_MS;
  }

  /**
   * A host that renders branch transcripts is refreshed here rather than on
   * its own schedule, so a branch that finishes between ticks still leaves a
   * complete transcript behind. A read failure is not the branch's failure.
   */
  async mirrorTranscript(
    branch: B,
    index: number,
    provider: BuildPipelineProvider,
    transcript: PassTranscriptReader,
    settling: boolean,
  ): Promise<void> {
    if (!this.host.onObserved) return;
    try {
      await this.host.onObserved(
        branch,
        index,
        provider,
        () => transcript.read(undefined),
        settling,
      );
    } catch (error) {
      console.warn(
        "[review-fanout] Mirroring a reviewer transcript failed:",
        agentBranchErrorMessage(error),
      );
    }
  }

  /**
   * Usage comes from the authoritative status observation whenever the
   * provider supplies it; only a provider that meters from messages, and only
   * when the observation carried none, needs a transcript read for it.
   */
  usageNeedsTranscript(
    provider: BuildPipelineProvider,
    observedUsage: AgentBranchObservedUsage | undefined,
  ): boolean {
    return (
      this.host.captureUsage === true &&
      observedUsage === undefined &&
      provider.usageFromMessages !== undefined
    );
  }

  /**
   * Copies the provider's cumulative token counter onto the durable branch.
   * Usage is presentation metadata: an unavailable meter must never fail an
   * otherwise healthy turn.
   */
  async refreshUsage(
    branch: B,
    provider: BuildPipelineProvider,
    observedUsage: AgentBranchObservedUsage | undefined,
    messages: Promise<unknown[]> | undefined,
  ): Promise<boolean> {
    if (!this.host.captureUsage || !branch.providerSessionId) return false;
    try {
      const usage =
        observedUsage ??
        (provider.usageFromMessages && messages
          ? provider.usageFromMessages(await messages)
          : undefined);
      const reported = usageCount(usage?.sessionTokens);
      const cacheReads = usageCount(usage?.cacheReadTokens);
      if (reported === undefined && cacheReads === undefined) return false;
      await this.host.assertFence();
      const tokenCount =
        reported === undefined ? branch.tokenCount : Math.max(branch.tokenCount ?? 0, reported);
      // Pi and Cursor report cache reads for their latest turn only, so the
      // largest value seen is kept rather than the latest.
      const cacheReadTokens =
        cacheReads === undefined
          ? branch.cacheReadTokens
          : Math.max(branch.cacheReadTokens ?? 0, cacheReads);
      if (branch.tokenCount === tokenCount && branch.cacheReadTokens === cacheReadTokens) {
        return false;
      }
      if (tokenCount !== undefined) branch.tokenCount = tokenCount;
      if (cacheReadTokens !== undefined) branch.cacheReadTokens = cacheReadTokens;
      return true;
    } catch (error) {
      if (isAgentBranchFenceError(error)) throw error;
      console.warn(
        "[review-fanout] Reading reviewer token usage failed:",
        agentBranchErrorMessage(error),
      );
      return false;
    }
  }

  /**
   * Bounds a branch that reports `running` without producing anything.
   *
   * Provider status alone cannot distinguish a long turn from a wedged one — a
   * Cursor parent holding its turn open for a background child whose transcript
   * stopped moving reports `running` indefinitely. Transcript movement is the
   * signal that separates the two, because bridges stream sub-agent activity
   * into the parent transcript as it happens.
   *
   * The transcript is read only when the tracker says a probe is due: a
   * throttled pass starts no provider request at all. A due probe asks for a
   * bounded, conditional one-message snapshot (`transcript-progress.ts`); an
   * unchanged branch answers without any transcript body. A provider without
   * that surface falls back to its newest message, and one that meters usage
   * from messages shares that one due read.
   *
   * The warning is durable so the owner can show it; the abandon is what stops
   * one stuck branch from halting its owner for good.
   *
   * A failed or throttled probe is not a fingerprint comparison, but it is not
   * a pause of the stall clock either: `progressAt` / `startedAt` still decide
   * whether the session has been silent too long. A restart compares against
   * the persisted digest so it cannot invent a new baseline or move the clock
   * forward.
   */
  async observeProgress(
    provider: BuildPipelineProvider,
    branch: B,
    transcript: PassTranscriptReader,
    observedUsage: AgentBranchObservedUsage | undefined,
  ): Promise<"continue"> {
    const providerSessionId = branch.providerSessionId;
    if (!providerSessionId) return "continue";
    const previousDigest = branch.progressDigest;
    let usageChanged = await this.refreshUsage(branch, provider, observedUsage, undefined);
    const usageFromTranscript = this.usageNeedsTranscript(provider, observedUsage);
    this.context.record({
      operation: this.host.progress.isProbeDue(providerSessionId)
        ? "transcript.probe_due"
        : "transcript.probe_throttled",
    });
    const observation = await this.host.progress.observe(
      providerSessionId,
      (known) => {
        // The progress sample comes from the bounded snapshot when the
        // provider has one; usage metering then needs its own (bounded,
        // `usageMessageLimit`) read, started only because a probe is due.
        if (usageFromTranscript && hasProgressSnapshot(provider)) {
          void transcript.read(provider.usageMessageLimit);
        }
        return readTranscriptProgressSample({
          provider,
          sessionId: providerSessionId,
          known,
          // Usage metering peeks this read later, so it keeps the usage shape
          // whenever that still covers the window the sample asked for.
          fallbackRead: (limit) =>
            transcript.read(
              usageFromTranscript && (provider.usageMessageLimit ?? Infinity) >= limit
                ? provider.usageMessageLimit
                : limit,
            ),
          onRead: (kind) => this.context.record({ operation: PROGRESS_READ_OPERATIONS[kind] }),
        });
      },
      branch.progressDigest,
    );
    if (usageFromTranscript) {
      // Only a read someone already paid for this pass — the due probe or the
      // owner's mirror. Usage metering never starts a read of its own here.
      const shared = transcript.peek(provider.usageMessageLimit);
      if (shared) {
        usageChanged =
          (await this.refreshUsage(branch, provider, undefined, shared)) || usageChanged;
      }
    }
    await this.host.assertFence();
    const decision = commitProgressObservation(branch, observation);
    if (decision === "reset" || decision === "hold") {
      this.context.commits.stageObservation();
      return "continue";
    }
    const elapsedMs = noProgressElapsedMs(branch.progressAt, branch.startedAt);
    if (elapsedMs === null) {
      if (this.shouldPersistUsageOrProgress(usageChanged, previousDigest, branch)) {
        this.context.commits.stageObservation();
      }
      return "continue";
    }
    if (elapsedMs >= this.stallAbandonMs()) {
      // Best-effort, like every other abandon: the session is unresponsive, so
      // waiting for it to confirm the abort would reproduce the stall.
      await this.host.abandonSession(branch, providerSessionId);
      this.host.progress.forget(providerSessionId);
      branch.status = "failed";
      branch.error = `The ${this.host.wording.subject} produced no activity for ${stalledMinutes(elapsedMs)} minutes and was stopped ${this.host.wording.stallStopReason}`;
      branch.completedAt = agentBranchNowIso();
      delete branch.stalledSince;
      delete branch.idleResultPolls;
      await this.context.commits.commit();
      return "continue";
    }
    if (elapsedMs >= this.stallWarningMs() && branch.stalledSince === undefined) {
      branch.stalledSince = agentBranchNowIso();
      this.context.commits.stageObservation();
      return "continue";
    }
    if (this.shouldPersistUsageOrProgress(usageChanged, previousDigest, branch)) {
      this.context.commits.stageObservation();
    }
    return "continue";
  }

  /**
   * Steers a running branch that holds a validated result it has not
   * committed. Best-effort and at most once per slot: the nudge only restates
   * what the model already has, and a steer that cannot be delivered must not
   * disturb the turn.
   */
  async nudgeUncommittedResult(provider: BuildPipelineProvider, branch: B): Promise<void> {
    const sessionId = branch.providerSessionId;
    const requestId = branch.requestId;
    if (branch.resultTransport !== "tool-v1" || !sessionId || !requestId) return;
    const held = this.host.heldResult?.(requestId);
    if (!held || held.ageMs < AGENT_BRANCH_RESULT_COMMIT_NUDGE_MS) return;
    if (!provider.steerSupported || !provider.activeSteerRun || !provider.performSessionAction) {
      return;
    }
    if (!this.host.claimResultNudge?.(requestId)) return;
    try {
      if (!(await provider.steerSupported(sessionId))) return;
      const active = await provider.activeSteerRun(sessionId);
      if (active?.state !== "running") return;
      await provider.performSessionAction(sessionId, {
        kind: "steer",
        text: this.host.commitNudgeText(branch, requestId, held.digest),
        requestId: randomUUID(),
        expectedRunId: active.runId,
      });
    } catch (error) {
      console.warn(
        `[review-fanout] Could not nudge an uncommitted result: ${agentBranchErrorMessage(error)}`,
      );
    }
  }

  private shouldPersistUsageOrProgress(
    usageChanged: boolean,
    previousDigest: string | undefined,
    branch: B,
  ): boolean {
    if (branch.progressDigest !== previousDigest) return true;
    return usageChanged && this.host.persistUsageImmediately !== false;
  }
}

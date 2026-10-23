/**
 * Bounded, conditional reads of a Multi Review step's session transcript, for
 * the flow graph's inspector.
 *
 * Preparation, consolidation and Fix run in backend-owned provider sessions.
 * The inspector shows a glance at what the selected step is doing, so this has
 * the reviewer transcript's contract (`multi-review-reviewer-transcript.ts`): a
 * count- and byte-bounded tail, an opaque token scoped to the provider session,
 * and an `unchanged` answer with no messages while that token is current. The
 * bounds are tighter than the reviewer tab's, because the inspector shows a
 * few dozen lines rather than a whole transcript.
 *
 * A session several steps share (older workflows ran all three in one) is
 * only read for the step using it now: its transcript would otherwise show one
 * step's work under another's name.
 */
import {
  MULTI_REVIEW_STEP_TRANSCRIPT_MAX_BYTES,
  MULTI_REVIEW_STEP_TRANSCRIPT_MAX_MESSAGES,
  multiReviewStepSessionAccess,
  type MultiReviewSession,
  type MultiReviewStepKind,
  type MultiReviewStepTranscript,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  readReviewerTranscript,
  readReviewerToolDetails,
  type ReviewerTranscriptRead,
} from "./multi-review-reviewer-transcript.js";

export interface StepTranscriptHost {
  /** The current authoritative workflow; throws when it no longer exists. */
  loadWorkflow(workflowId: string): Promise<MultiReviewWorkflow>;
  /** Runs `read` with the provider serving `session`, held open for the read. */
  withProvider<T>(
    workflow: MultiReviewWorkflow,
    session: MultiReviewSession,
    read: (provider: BuildPipelineProvider) => Promise<T>,
  ): Promise<T>;
  /** Content-free measurement of one provider read. */
  recordRead?(read: ReviewerTranscriptRead, elapsedMs: number): void;
}

export async function readMultiReviewStepTranscript(
  host: StepTranscriptHost,
  workflowId: string,
  step: MultiReviewStepKind,
  knownSourceToken: string | undefined,
): Promise<MultiReviewStepTranscript> {
  let workflow = await host.loadWorkflow(workflowId);
  let access = multiReviewStepSessionAccess(workflow, step);
  let read: ReviewerTranscriptRead | undefined;
  if (access.kind === "own") {
    const { providerSessionId } = access.session;
    const started = Date.now();
    read = await host.withProvider(workflow, access.session, (provider) =>
      readReviewerTranscript(provider, providerSessionId, knownSourceToken, undefined, {
        maxMessages: MULTI_REVIEW_STEP_TRANSCRIPT_MAX_MESSAGES,
        maxBytes: MULTI_REVIEW_STEP_TRANSCRIPT_MAX_BYTES,
      }),
    );
    host.recordRead?.(read, Date.now() - started);
    // The step may have been restarted in a new session, or handed its shared
    // session to the next step, while the read was in flight. Its answer then
    // describes a session this step no longer shows, so it is dropped and the
    // next read starts over.
    workflow = await host.loadWorkflow(workflowId);
    access = multiReviewStepSessionAccess(workflow, step);
    if (access.kind !== "own" || access.session.providerSessionId !== providerSessionId) {
      read = undefined;
    }
  }
  const session = access.kind === "none" ? undefined : access.session;
  return {
    workflowId: workflow.id,
    step,
    workflowPhase: workflow.phase,
    session: access.kind,
    ...(access.kind === "other-step" && access.step ? { sessionStep: access.step } : {}),
    ...(session
      ? {
          agent: session.agent,
          model: session.model,
          sessionStatus: session.status,
          startedAt: session.startedAt,
        }
      : {}),
    messages: read?.kind === "snapshot" ? read.messages : [],
    transcript: read?.kind === "unchanged" ? "unchanged" : "snapshot",
    ...(read?.sourceToken ? { sourceToken: read.sourceToken } : {}),
    ...(read?.kind === "snapshot" && read.truncated ? { truncated: true } : {}),
  };
}

/** Resolve a deferred body only while this step still owns the authoritative session. */
export async function readMultiReviewStepToolDetails(
  host: StepTranscriptHost,
  workflowId: string,
  step: MultiReviewStepKind,
  detailRef: string,
): Promise<NativeAgentToolDetails> {
  const workflow = await host.loadWorkflow(workflowId);
  const access = multiReviewStepSessionAccess(workflow, step);
  if (access.kind !== "own") throw new Error("Step tool details are no longer available");
  const sessionId = access.session.providerSessionId;
  const details = await host.withProvider(workflow, access.session, (provider) =>
    readReviewerToolDetails(provider, sessionId, detailRef),
  );
  const current = multiReviewStepSessionAccess(await host.loadWorkflow(workflowId), step);
  if (current.kind !== "own" || current.session.providerSessionId !== sessionId) {
    throw new Error("Step tool details are no longer available");
  }
  return details;
}

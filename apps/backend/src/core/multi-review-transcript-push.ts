/**
 * What the push layer's `review-transcript` topic compares for one Multi
 * Review reviewer or step (docs/architecture/push-events.md, "The
 * `review-transcript` topic"): the provider session the view shows and a
 * digest of the record fields it shows besides the transcript. Built from the
 * workflow record alone, so a record save costs a storage read, never a
 * bridge read. The digest is compared in memory, never logged or sent.
 */
import { createHash } from "node:crypto";
import {
  multiReviewStepSessionAccess,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { ReviewTranscriptPushKey } from "@orkestrator/protocol/push-events";
import type { ReviewTranscriptTarget } from "./push/review-transcript-push-topic.js";

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

/** The key's target in `workflow`, or `null` when the reviewer is gone. */
export function multiReviewTranscriptPushTarget(
  workflow: MultiReviewWorkflow,
  key: ReviewTranscriptPushKey,
): ReviewTranscriptTarget | null {
  if (key.step === undefined) {
    const reviewer = workflow.reviewers.find((entry) => entry.id === key.reviewerId);
    if (!reviewer) return null;
    return {
      environmentId: workflow.environmentId,
      agent: reviewer.agent,
      ...(reviewer.providerSessionId ? { providerSessionId: reviewer.providerSessionId } : {}),
      live: reviewer.status === "running" || reviewer.status === "pending",
      // Everything the reviewer tab shows that is not the transcript itself.
      digest: digestOf([
        workflow.phase,
        reviewer.status,
        reviewer.dispatchState ?? null,
        reviewer.model,
        reviewer.reasoningEffort ?? null,
        reviewer.report ?? null,
        reviewer.error ?? null,
        reviewer.progressAt ?? null,
        reviewer.stalledSince ?? null,
        reviewer.startedAt ?? null,
        reviewer.completedAt ?? null,
      ]),
    };
  }
  const access = multiReviewStepSessionAccess(workflow, key.step);
  const session = access.kind === "none" ? undefined : access.session;
  return {
    environmentId: workflow.environmentId,
    agent: session?.agent ?? "",
    // Only a session this step owns shows a transcript.
    ...(access.kind === "own" ? { providerSessionId: access.session.providerSessionId } : {}),
    live: access.kind === "own" && access.session.status === "running",
    digest: digestOf([
      workflow.phase,
      access.kind,
      access.kind === "other-step" ? access.step : null,
      session?.agent ?? null,
      session?.model ?? null,
      session?.status ?? null,
      session?.startedAt ?? null,
    ]),
  };
}

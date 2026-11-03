/**
 * Which build pipeline worker a backend-issued turn credential belongs to.
 *
 * A stage turn in tool mode connects with its workflow-result capability
 * alone, so that capability is also the worker's mail identity: the result
 * key names one attempt, and the pipeline record says which session (and so
 * which worker mailbox) that attempt belongs to. The answer comes from the
 * backend's own record, never from anything the agent supplies, so one
 * worker's credential can never act as another worker's mailbox.
 */
import { isRecord } from "./storage-shared.js";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import type { StorageService } from "./storage.js";

/** The worker mailbox tab id the attempt `resultKey` belongs to, or null. */
export async function pipelineWorkerTabForResultKey(
  storage: Pick<StorageService, "listBuildPipelinesForEnvironment">,
  scope: { environmentId: string; projectId: string },
  resultKey: string,
): Promise<string | null> {
  const records = await storage.listBuildPipelinesForEnvironment(
    scope.projectId,
    scope.environmentId,
  );
  for (const record of records) {
    const snapshot = record.snapshot;
    if (!isRecord(snapshot) || !Array.isArray(snapshot.sessions)) continue;
    const sessions = snapshot.sessions.filter(isRecord);
    const bySessionId = (sessionId: unknown) =>
      sessions.find((session) => session.sdkSessionId === sessionId);
    const owner =
      sessions.find((session) => session.structuredRequestId === resultKey) ??
      (isRecord(snapshot.pendingPromptAttempt) &&
      snapshot.pendingPromptAttempt.requestId === resultKey
        ? bySessionId(snapshot.pendingPromptAttempt.sessionId)
        : undefined) ??
      (isRecord(snapshot.activePromptContext) &&
      snapshot.activePromptContext.requestId === resultKey
        ? bySessionId(snapshot.activePromptContext.sessionId)
        : undefined);
    if (owner && typeof owner.sessionKey === "string") return pipelineWorkerTabId(owner.sessionKey);
    const fanout = isRecord(snapshot.reviewFanout) ? snapshot.reviewFanout : undefined;
    const reviewers = Array.isArray(fanout?.reviewers) ? fanout.reviewers.filter(isRecord) : [];
    const reviewer = reviewers.find((candidate) => candidate.requestId === resultKey);
    if (reviewer && typeof reviewer.sessionKey === "string")
      return pipelineWorkerTabId(reviewer.sessionKey);
    const consolidation = isRecord(fanout?.consolidation) ? fanout.consolidation : undefined;
    if (consolidation?.requestId === resultKey && typeof consolidation.sessionKey === "string")
      return pipelineWorkerTabId(consolidation.sessionKey);
  }
  return null;
}

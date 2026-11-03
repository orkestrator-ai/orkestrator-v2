/**
 * A build pipeline worker's own transcript, read by its mailbox address
 * (`get_tab_transcript` with a `pipeline-worker:` tab id).
 *
 * The source is the stage session's committed transcript in the pipeline's
 * transcript store: checkpointed on the persist cadence while the turn runs
 * and kept once it ends, so a finished worker reads the same as a running
 * one. Nothing here touches the provider, so reading never re-attaches or
 * keeps alive an idle session.
 */
import { isBuildPipeline, type BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  pipelineWorker,
  pipelineWorkerSessionKey,
} from "@orkestrator/protocol/pipeline-worker-mail";
import type { StorageService } from "./storage.js";

/** The most messages one read returns, as for a native tab. */
export const MAX_PIPELINE_WORKER_TRANSCRIPT_MESSAGES = 100;
/** The serialized size one read stops before. */
const MAX_PIPELINE_WORKER_TRANSCRIPT_BYTES = 256 * 1024;

export async function readPipelineWorkerTranscript(
  storage: Pick<StorageService, "getBuildPipeline" | "readBuildPipelineTranscript">,
  input: { environmentId: string; tabId: string; limit?: number },
): Promise<Record<string, unknown>> {
  const sessionKey = pipelineWorkerSessionKey(input.tabId);
  if (!sessionKey) throw new Error(`Not a build pipeline worker address: ${input.tabId}`);
  // A session key starts with its pipeline's id, which holds no colon.
  const pipelineId = sessionKey.slice(0, sessionKey.indexOf(":"));
  const record = pipelineId ? await storage.getBuildPipeline(pipelineId) : null;
  const snapshot = record?.snapshot;
  if (!record || record.environmentId !== input.environmentId || !isBuildPipeline(snapshot)) {
    throw new Error(
      `No build pipeline worker ${input.tabId} in environment ${input.environmentId}`,
    );
  }
  const pipeline: BuildPipeline = {
    ...snapshot,
    id: record.id,
    environmentId: record.environmentId,
  };
  const worker = pipelineWorker(pipeline, input.tabId);
  if (!worker) {
    throw new Error(
      `No build pipeline worker ${input.tabId} in environment ${input.environmentId}`,
    );
  }
  const limit = Math.min(
    MAX_PIPELINE_WORKER_TRANSCRIPT_MESSAGES,
    Math.max(1, Math.trunc(input.limit ?? 50)),
  );
  const session = pipeline.sessions.find((candidate) => candidate.sessionKey === sessionKey);
  const base = {
    environmentId: input.environmentId,
    tabId: input.tabId,
    pipelineId: pipeline.id,
    worker,
    agent: worker.agent,
  };
  if (!session) {
    // A reviewer whose session row the fan-out has not mirrored yet.
    return { ...base, messages: [], messageWindow: { startIndex: 0, messageCount: 0 } };
  }
  const total = session.transcript?.messageCount ?? session.messages?.length ?? 0;
  const fromIndex = Math.max(0, total - limit);
  const read = await storage.readBuildPipelineTranscript(pipeline.id, session, {
    fromIndex,
    maxBytes: MAX_PIPELINE_WORKER_TRANSCRIPT_BYTES,
  });
  if (read.status !== "found") {
    return {
      ...base,
      messages: [],
      error: "The worker's transcript is unavailable right now",
      messageWindow: { startIndex: 0, messageCount: total },
    };
  }
  return {
    ...base,
    messages: read.messages,
    messageWindow: {
      startIndex: read.startIndex,
      messageCount: read.messageCount,
      complete: read.complete,
    },
    revision: read.revision,
    ...(session.messagesPersistedAt ? { checkpointedAt: session.messagesPersistedAt } : {}),
  };
}

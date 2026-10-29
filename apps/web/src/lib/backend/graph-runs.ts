import type { BuildPipelineCodeRewindPreview } from "@orkestrator/protocol/build-pipeline";
import type {
  GraphAgentAnswerKind,
  GraphAgentQuestion,
  GraphRun,
} from "@orkestrator/protocol/graphs/run";
import type {
  GraphRunArtifactView,
  GraphRunGetResult,
  GraphRunSummary,
  GraphRunTranscriptView,
} from "@orkestrator/protocol/graphs/run-view";
import { invoke } from "@/lib/native/backend";

/**
 * Graph runs (item 211): list, read and control a run, read its artifacts and
 * its agent transcripts, and answer an agent's `ask_human` question (item
 * 204). Shapes are in `@orkestrator/protocol/graphs/run-view`. Every read is
 * a snapshot of the backend's run record, which stays the authority; a
 * refused call rejects with the backend's message.
 */

export function listGraphRuns(environmentId: string): Promise<GraphRunSummary[]> {
  return invoke<GraphRunSummary[]>("graph_runs_list", { environmentId });
}

/** The run, or `unchanged` when `knownRevision` is still current. */
export function getGraphRun(runId: string, knownRevision?: number): Promise<GraphRunGetResult> {
  return invoke<GraphRunGetResult>("graph_run_get", {
    runId,
    ...(knownRevision !== undefined ? { knownRevision } : {}),
  });
}

async function changedRun(command: string, args: Record<string, unknown>): Promise<GraphRun> {
  const result = await invoke<GraphRunGetResult>(command, args);
  if (result.status !== "changed") throw new Error("The backend returned no run snapshot");
  return result.run;
}

export function cancelGraphRun(runId: string): Promise<GraphRun> {
  return changedRun("graph_run_cancel", { runId });
}

export function pauseGraphRun(runId: string): Promise<GraphRun> {
  return changedRun("graph_run_pause", { runId });
}

export function resumeGraphRun(runId: string): Promise<GraphRun> {
  return changedRun("graph_run_resume", { runId });
}

/** Reruns one failed node position as a new attempt (a live run only). */
export function retryGraphActivation(runId: string, activationKey: string): Promise<GraphRun> {
  return changedRun("graph_run_retry", { runId, activationKey });
}

/** Skips a position that has not been admitted yet (`waiting` or `ready`). */
export function skipGraphActivation(runId: string, activationKey: string): Promise<GraphRun> {
  return changedRun("graph_run_skip", { runId, activationKey });
}

export function getGraphRunArtifact(
  runId: string,
  artifactId: string,
): Promise<GraphRunArtifactView> {
  return invoke<GraphRunArtifactView>("graph_run_artifact", { runId, artifactId });
}

export function getGraphRunTranscript(
  runId: string,
  activationKey: string,
  window: { fromIndex?: number; maxBytes?: number } = {},
): Promise<GraphRunTranscriptView> {
  return invoke<GraphRunTranscriptView>("graph_run_transcript", {
    runId,
    activationKey,
    ...window,
  });
}

export interface GraphRunAnswerInput {
  runId: string;
  activationKey: string;
  questionId: string;
  kind: GraphAgentAnswerKind;
  text?: string;
  choice?: string;
}

/** Answers (or declines) an agent's `ask_human` question; a stale question is refused. */
export function answerGraphRunQuestion(
  input: GraphRunAnswerInput,
): Promise<{ activationKey: string; question: GraphAgentQuestion | null }> {
  return invoke("graph_run_answer", { ...input });
}

// ---------------------------------------------------------------- restart and rewind

/**
 * Restart and code rewind (item 210). The run view is built against this
 * interface. {@link graphRunRewindBackend} calls 210's commands
 * (`graph_run_restart {runId, activationKey, requestId?}` and
 * `graph_run_rewind_code {…, expectedHead}`, both answering
 * `{run, rewind, repeated}`; `graph_run_rewind_code_preview`) directly, so a
 * backend without them refuses the call and the view reports it. Once 210's
 * wrappers (`lib/backend/graph-run-rewind.ts`) are on this branch, point it
 * at them.
 */
export interface GraphRunRewindBackend {
  /** Supersedes the activation and its lineage descendants and reruns it with the same inputs. */
  restart(runId: string, activationKey: string): Promise<GraphRun>;
  /** What resetting the branch to the activation's input commit would drop. */
  previewCodeRewind(runId: string, activationKey: string): Promise<GraphRunCodeRewindPreview>;
  /** Resets the branch (refused when HEAD moved past `expectedHead`), then restarts. */
  rewindCode(runId: string, activationKey: string, expectedHead: string): Promise<GraphRun>;
}

/**
 * A code rewind preview. Item 210 reuses `build-pipeline-code-rewind.ts`, so
 * the pipeline's preview shape is the expected one.
 */
export type GraphRunCodeRewindPreview = BuildPipelineCodeRewindPreview;

/** The run out of a `{run, …}` answer (210's `GraphRunRestartResult`, or a `changed` snapshot). */
async function runFrom(command: string, args: Record<string, unknown>): Promise<GraphRun> {
  const result = await invoke<{ run?: GraphRun }>(command, args);
  if (!result?.run) throw new Error("The backend returned no run snapshot");
  return result.run;
}

/** One id per user action, so a retried call is a no-op (`repeated`) on 210's backend. */
function requestId(): string {
  return globalThis.crypto.randomUUID();
}

export const graphRunRewindBackend: GraphRunRewindBackend = {
  restart: (runId, activationKey) =>
    runFrom("graph_run_restart", { runId, activationKey, requestId: requestId() }),
  previewCodeRewind: (runId, activationKey) =>
    invoke<GraphRunCodeRewindPreview>("graph_run_rewind_code_preview", { runId, activationKey }),
  rewindCode: (runId, activationKey, expectedHead) =>
    runFrom("graph_run_rewind_code", {
      runId,
      activationKey,
      expectedHead,
      requestId: requestId(),
    }),
};

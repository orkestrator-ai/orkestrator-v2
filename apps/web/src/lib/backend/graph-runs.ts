import type {
  GraphAgentAnswerKind,
  GraphAgentQuestion,
  GraphHumanAnswerInput,
  GraphHumanWait,
  GraphRun,
} from "@orkestrator/protocol/graphs/run";
import type { GraphRunCodeRewindPreview } from "@orkestrator/protocol/graphs/run-rewind";
import type {
  GraphRunArtifactView,
  GraphRunGetResult,
  GraphRunSummary,
  GraphRunTranscriptView,
} from "@orkestrator/protocol/graphs/run-view";
import { graphs } from "@/lib/node-scope/domains/graphs";
import { createGraphRunRewindApi } from "./graph-run-rewind";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * Graph runs (item 211): list, read and control a run, read its artifacts and
 * its agent transcripts, answer an agent's `ask_human` question (item 204)
 * or a human node (item 208), and list what a run waits on a person for. Shapes are in `@orkestrator/protocol/graphs/run-view`. Every read is
 * a snapshot of the backend's run record, which stays the authority; a
 * refused call rejects with the backend's message. Every call goes through
 * the `graphs` domain client (plan item 7007).
 */

export interface GraphRunAnswerInput {
  runId: string;
  activationKey: string;
  questionId: string;
  kind: GraphAgentAnswerKind;
  text?: string;
  choice?: string;
}

export interface GraphRunHumanAnswerInput extends GraphHumanAnswerInput {
  runId: string;
  activationKey: string;
}

// ---------------------------------------------------------------- restart and rewind

/**
 * Restart and code rewind (item 210). The run view is built against this
 * interface so tests can pass their own; {@link graphRunRewindBackend} calls
 * 210's wrappers in `graph-run-rewind.ts`, one request id per user action so
 * a retried call is a no-op (`repeated`).
 */
export interface GraphRunRewindBackend {
  /** Supersedes the activation and its lineage descendants and reruns it with the same inputs. */
  restart(runId: string, activationKey: string): Promise<GraphRun>;
  /** What resetting the branch to the activation's input commit would drop. */
  previewCodeRewind(runId: string, activationKey: string): Promise<GraphRunCodeRewindPreview>;
  /** Resets the branch (refused when HEAD moved past `expectedHead`), then restarts. */
  rewindCode(runId: string, activationKey: string, expectedHead: string): Promise<GraphRun>;
}

export type { GraphRunCodeRewindPreview };

/** One id per user action, so a retried call is a no-op (`repeated`) on 210's backend. */
function requestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createGraphRunsApi(client: BackendClient) {
  const api = () => graphs(client);
  const { previewGraphRunCodeRewind, restartGraphRunActivation, rewindGraphRunCode } =
    createGraphRunRewindApi(client);

  function listGraphRuns(environmentId: string): Promise<GraphRunSummary[]> {
    return api().graph_runs_list({ environmentId });
  }

  /** The run, or `unchanged` when `knownRevision` is still current. */
  function getGraphRun(runId: string, knownRevision?: number): Promise<GraphRunGetResult> {
    return api().graph_run_get({
      runId,
      ...(knownRevision !== undefined ? { knownRevision } : {}),
    });
  }

  async function changedRun(answer: Promise<GraphRunGetResult>): Promise<GraphRun> {
    const result = await answer;
    if (result.status !== "changed") throw new Error("The backend returned no run snapshot");
    return result.run;
  }

  function cancelGraphRun(runId: string): Promise<GraphRun> {
    return changedRun(api().graph_run_cancel({ runId }));
  }

  function pauseGraphRun(runId: string): Promise<GraphRun> {
    return changedRun(api().graph_run_pause({ runId }));
  }

  function resumeGraphRun(runId: string): Promise<GraphRun> {
    return changedRun(api().graph_run_resume({ runId }));
  }

  /** Reruns one failed node position as a new attempt (a live run only). */
  function retryGraphActivation(runId: string, activationKey: string): Promise<GraphRun> {
    return changedRun(api().graph_run_retry({ runId, activationKey }));
  }

  /** Skips a position that has not been admitted yet (`waiting` or `ready`). */
  function skipGraphActivation(runId: string, activationKey: string): Promise<GraphRun> {
    return changedRun(api().graph_run_skip({ runId, activationKey }));
  }

  function getGraphRunArtifact(runId: string, artifactId: string): Promise<GraphRunArtifactView> {
    return api().graph_run_artifact({ runId, artifactId });
  }

  function getGraphRunTranscript(
    runId: string,
    activationKey: string,
    window: { fromIndex?: number; maxBytes?: number } = {},
  ): Promise<GraphRunTranscriptView> {
    return api().graph_run_transcript({
      runId,
      activationKey,
      ...window,
    });
  }

  /** Answers (or declines) an agent's `ask_human` question; a stale question is refused. */
  function answerGraphRunQuestion(
    input: GraphRunAnswerInput,
  ): Promise<{ activationKey: string; question: GraphAgentQuestion | null }> {
    // The answer has the form that was sent: the question form here.
    return api().graph_run_answer({ ...input }) as Promise<{
      activationKey: string;
      question: GraphAgentQuestion | null;
    }>;
  }

  /**
   * Answers a waiting human node (item 208): approve or reject (an `edit` form's
   * approval may carry the edited `value`), or choose an option's `outlet`. A
   * stale wait (another attempt, already answered), a value that fails its type
   * or a mismatched decision is refused with the backend's message.
   */
  function answerGraphRunHumanNode(
    input: GraphRunHumanAnswerInput,
  ): Promise<{ activationKey: string; human: GraphHumanWait | null }> {
    const { value, ...rest } = input;
    return api().graph_run_answer({
      ...rest,
      ...(Object.hasOwn(input, "value") ? { value } : {}),
      // The human node form's answer.
    }) as Promise<{ activationKey: string; human: GraphHumanWait | null }>;
  }

  const graphRunRewindBackend: GraphRunRewindBackend = {
    restart: async (runId, activationKey) =>
      (await restartGraphRunActivation({ runId, activationKey, requestId: requestId() })).run,
    previewCodeRewind: (runId, activationKey) =>
      previewGraphRunCodeRewind({ runId, activationKey }),
    rewindCode: async (runId, activationKey, expectedHead) =>
      (
        await rewindGraphRunCode({
          runId,
          activationKey,
          expectedHead,
          requestId: requestId(),
        })
      ).run,
  };

  return {
    listGraphRuns,
    getGraphRun,
    cancelGraphRun,
    pauseGraphRun,
    resumeGraphRun,
    retryGraphActivation,
    skipGraphActivation,
    getGraphRunArtifact,
    getGraphRunTranscript,
    answerGraphRunQuestion,
    answerGraphRunHumanNode,
    graphRunRewindBackend,
  };
}

export type GraphRunsApi = ReturnType<typeof createGraphRunsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listGraphRuns,
  getGraphRun,
  cancelGraphRun,
  pauseGraphRun,
  resumeGraphRun,
  retryGraphActivation,
  skipGraphActivation,
  getGraphRunArtifact,
  getGraphRunTranscript,
  answerGraphRunQuestion,
  answerGraphRunHumanNode,
  graphRunRewindBackend,
} = createGraphRunsApi(commandBackendClient);

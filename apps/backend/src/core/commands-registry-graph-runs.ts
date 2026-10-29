import {
  GRAPH_AGENT_ANSWER_KINDS,
  GRAPH_AGENT_QUESTION_BOUNDS,
  GRAPH_COMMIT_PATTERN,
  GRAPH_RUN_BOUNDS,
  GRAPH_RUN_ID_PATTERN,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import {
  GRAPH_RUN_VIEW_BOUNDS,
  compareGraphRunsNewestFirst,
  graphRunSummary,
  graphRunViewSnapshot,
  type GraphRunArtifactView,
  type GraphRunGetResult,
  type GraphRunTranscriptView,
} from "@orkestrator/protocol/graphs/run-view";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { GraphAgentQuestionError, type GraphAgentQuestions } from "./graph-agent-questions.js";
import { GraphRunRewindError } from "./graph-run-rewind.js";
import { GraphRunServiceError, type GraphRunService } from "./graph-run-service.js";

/**
 * Graph run commands. The run view's reads and controls (item 211; shapes in
 * `@orkestrator/protocol/graphs/run-view`): `graph_runs_list`,
 * `graph_run_get` (the revisioned snapshot, `unchanged` when `knownRevision`
 * is current), `graph_run_cancel`, `graph_run_pause`, `graph_run_resume`,
 * `graph_run_retry`, `graph_run_skip`, and the bounded reads
 * `graph_run_artifact` and `graph_run_transcript`. A refused request throws
 * a `GraphRunServiceError` whose `code` the gateway forwards
 * (`invalid-request`, `not-found`, `invalid-state`, `disabled`).
 *
 * The commands that act on one waiting activation (item 204; the human
 * nodes of item 208 share the answer surface): `graph_run_answer` answers an
 * agent's `ask_human` question:
 *
 * `{ runId, activationKey, questionId, kind: "answered" | "declined", text?, choice? }`
 *
 * It returns the activation's stored question. A stale (another or an
 * already answered question), malformed or oversized answer is refused with
 * a `GraphAgentQuestionError` (`invalid-answer`) and never reaches the agent.
 *
 * Restart and rewind (item 210; shapes in `@orkestrator/protocol/graphs/run-rewind`):
 *
 * - `graph_run_restart {runId, activationKey, requestId?}` →
 *   `GraphRunRestartResult {run, rewind, repeated}`;
 * - `graph_run_rewind_code_preview {runId, activationKey}` →
 *   `GraphRunCodeRewindPreview` (reads only; `blocked` says why not now);
 * - `graph_run_rewind_code {runId, activationKey, expectedHead, requestId?}` →
 *   `GraphRunRestartResult`.
 *
 * A refusal throws a `GraphRunRewindError` whose `code` is `not-found`,
 * `invalid-request`, `invalid-state`, `limit` or `unavailable`.
 */

function questions(context: CommandContext): GraphAgentQuestions {
  if (!context.graphQuestions) {
    throw new GraphAgentQuestionError("not-found", "Graph runs are unavailable");
  }
  return context.graphQuestions;
}

function invalid(message: string): never {
  throw new GraphAgentQuestionError("invalid-answer", message);
}

function stringArg(
  value: unknown,
  name: string,
  max: number,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    invalid(`${name} must be a string of 1 to ${max} characters`);
  }
  return value;
}

function runs(context: CommandContext): GraphRunService {
  if (!context.graphRuns) throw new GraphRunServiceError("disabled", "Graph runs are unavailable");
  return context.graphRuns;
}

function badRequest(message: string): never {
  throw new GraphRunServiceError("invalid-request", message);
}

function onlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) badRequest(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    badRequest(`${name} must be a string of 1 to ${max} characters`);
  }
  return value;
}

function optionalCount(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    badRequest(`${name} must be an integer from 0 to ${max}`);
  }
  return value as number;
}

function runIdArg(args: Record<string, unknown>): string {
  return requiredString(args.runId, "runId", GRAPH_RUN_BOUNDS.maxIdChars);
}

function activationKeyArg(args: Record<string, unknown>): string {
  return requiredString(
    args.activationKey,
    "activationKey",
    GRAPH_RUN_BOUNDS.maxActivationKeyChars,
  );
}

async function readRun(context: CommandContext, runId: string): Promise<GraphRun> {
  const run = await runs(context).get(runId);
  if (!run) throw new GraphRunServiceError("not-found", "The graph run does not exist");
  return run;
}

function changed(run: GraphRun): GraphRunGetResult {
  return { status: "changed", run: graphRunViewSnapshot(run) };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The artifact read: value inline within the view bound, a sealed file's metadata only. */
async function readArtifact(
  context: CommandContext,
  runId: string,
  artifactId: string,
): Promise<GraphRunArtifactView> {
  await readRun(context, runId);
  const artifact = await context.storage.graphRuns.getGraphArtifact(runId, artifactId);
  if (!artifact || artifact.runId !== runId) {
    throw new GraphRunServiceError("not-found", "The run has no such artifact");
  }
  const { body, ...envelope } = artifact;
  const view: GraphRunArtifactView = { artifact: envelope };
  if ("file" in body) view.file = { ...body.file };
  if (body.value === undefined) return view;
  let size: number;
  try {
    size = utf8Bytes(canonicalJson(body.value, 128));
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  if (size <= GRAPH_RUN_VIEW_BOUNDS.maxArtifactViewBytes) view.value = body.value;
  else view.valueOmitted = "too-large";
  return view;
}

async function readTranscript(
  context: CommandContext,
  args: { runId: string; activationKey: string; fromIndex?: number; maxBytes?: number },
): Promise<GraphRunTranscriptView> {
  const run = await readRun(context, args.runId);
  const activation = run.activations.find((entry) => entry.key === args.activationKey);
  if (!activation) throw new GraphRunServiceError("not-found", "The run has no such activation");
  const reference = activation.session?.transcript;
  if (!reference) return { status: "none" };
  const read = await context.storage.readGraphRunTranscript(run.id, activation.key, reference, {
    ...(args.fromIndex !== undefined ? { fromIndex: args.fromIndex } : {}),
    maxBytes: args.maxBytes ?? GRAPH_RUN_VIEW_BOUNDS.defaultTranscriptReadBytes,
  });
  if (read.status !== "found") return read;
  return {
    status: "found",
    messages: read.messages,
    startIndex: read.startIndex,
    messageCount: read.messageCount,
    revision: read.revision,
    complete: read.complete,
    ...(read.truncated ? { truncated: true as const } : {}),
  };
}

export function registerGraphRunCommands(register: CommandRegistrar): void {
  register("graph_runs_list", async (args, context) => {
    onlyKeys(args, ["environmentId"]);
    const environmentId = requiredString(args.environmentId, "environmentId", 200);
    const listed = await runs(context).list(environmentId);
    return listed
      .sort(compareGraphRunsNewestFirst)
      .slice(0, GRAPH_RUN_VIEW_BOUNDS.maxListedRuns)
      .map(graphRunSummary);
  });

  register("graph_run_get", async (args, context): Promise<GraphRunGetResult> => {
    onlyKeys(args, ["runId", "knownRevision"]);
    const runId = runIdArg(args);
    const knownRevision = optionalCount(
      args.knownRevision,
      "knownRevision",
      Number.MAX_SAFE_INTEGER,
    );
    const run = await readRun(context, runId);
    if (knownRevision !== undefined && run.revision === knownRevision) {
      return { status: "unchanged", revision: run.revision };
    }
    return changed(run);
  });

  for (const action of ["cancel", "pause", "resume"] as const) {
    register(`graph_run_${action}`, async (args, context): Promise<GraphRunGetResult> => {
      onlyKeys(args, ["runId"]);
      return changed(await runs(context)[action](runIdArg(args)));
    });
  }

  for (const action of ["retry", "skip"] as const) {
    register(`graph_run_${action}`, async (args, context): Promise<GraphRunGetResult> => {
      onlyKeys(args, ["runId", "activationKey"]);
      const runId = runIdArg(args);
      const activationKey = activationKeyArg(args);
      return changed(await runs(context)[action](runId, activationKey));
    });
  }

  register("graph_run_artifact", async (args, context) => {
    onlyKeys(args, ["runId", "artifactId"]);
    return readArtifact(
      context,
      runIdArg(args),
      requiredString(args.artifactId, "artifactId", GRAPH_RUN_BOUNDS.maxIdChars),
    );
  });

  register("graph_run_transcript", async (args, context) => {
    onlyKeys(args, ["runId", "activationKey", "fromIndex", "maxBytes"]);
    const runId = runIdArg(args);
    const activationKey = activationKeyArg(args);
    const fromIndex = optionalCount(args.fromIndex, "fromIndex", Number.MAX_SAFE_INTEGER);
    // Larger windows are clamped to the bound rather than refused.
    const requested = optionalCount(args.maxBytes, "maxBytes", Number.MAX_SAFE_INTEGER);
    const maxBytes =
      requested === undefined
        ? undefined
        : Math.min(requested, GRAPH_RUN_VIEW_BOUNDS.maxTranscriptReadBytes);
    return readTranscript(context, {
      runId,
      activationKey,
      ...(fromIndex !== undefined ? { fromIndex } : {}),
      ...(maxBytes !== undefined ? { maxBytes: Math.max(1, maxBytes) } : {}),
    });
  });

  register("graph_run_answer", async (args, context) => {
    const allowed = ["runId", "activationKey", "questionId", "kind", "text", "choice"];
    const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) invalid(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
    const runId = stringArg(args.runId, "runId", 128, true)!;
    const activationKey = stringArg(args.activationKey, "activationKey", 256, true)!;
    const questionId = stringArg(args.questionId, "questionId", 64, true)!;
    const kind = args.kind;
    if (
      typeof kind !== "string" ||
      !(GRAPH_AGENT_ANSWER_KINDS as readonly string[]).includes(kind)
    ) {
      invalid(`kind must be one of ${GRAPH_AGENT_ANSWER_KINDS.join(", ")}`);
    }
    const text = stringArg(args.text, "text", GRAPH_AGENT_QUESTION_BOUNDS.maxAnswerChars, false);
    const choice = stringArg(
      args.choice,
      "choice",
      GRAPH_AGENT_QUESTION_BOUNDS.maxChoiceChars,
      false,
    );
    try {
      const activation = await questions(context).answer(
        { runId, activationKey },
        {
          questionId,
          kind: kind as (typeof GRAPH_AGENT_ANSWER_KINDS)[number],
          ...(text !== undefined ? { text } : {}),
          ...(choice !== undefined ? { choice } : {}),
        },
        "user",
      );
      return { activationKey: activation.key, question: activation.session?.question ?? null };
    } catch (error) {
      if (error instanceof GraphRunServiceError) {
        throw new GraphAgentQuestionError(
          error.code === "not-found" ? "not-found" : "invalid-answer",
          error.message,
        );
      }
      throw error;
    }
  });
}

function rewindInvalid(message: string): never {
  throw new GraphRunRewindError("invalid-request", message);
}

function graphRuns(context: CommandContext): GraphRunService {
  if (!context.graphRuns)
    throw new GraphRunRewindError("unavailable", "Graph runs are unavailable");
  return context.graphRuns;
}

function rewindArgs(
  args: Record<string, unknown>,
  allowed: readonly string[],
): { runId: string; activationKey: string; requestId?: string } {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) rewindInvalid(`Unknown arguments: ${unknown.slice(0, 5).join(", ")}`);
  const runId = args.runId;
  if (typeof runId !== "string" || !GRAPH_RUN_ID_PATTERN.test(runId)) {
    rewindInvalid("runId must be a run id");
  }
  const activationKey = args.activationKey;
  if (
    typeof activationKey !== "string" ||
    activationKey.length === 0 ||
    activationKey.length > GRAPH_RUN_BOUNDS.maxActivationKeyChars
  ) {
    rewindInvalid("activationKey must be an activation key");
  }
  const requestId = args.requestId;
  if (requestId !== undefined && requestId !== null) {
    if (typeof requestId !== "string" || !GRAPH_RUN_ID_PATTERN.test(requestId)) {
      rewindInvalid("requestId must be 1 to 128 letters, digits, '-' or '_'");
    }
    return { runId, activationKey, requestId };
  }
  return { runId, activationKey };
}

export function registerGraphRunRewindCommands(register: CommandRegistrar): void {
  register("graph_run_restart", async (args, context) => {
    const { runId, activationKey, requestId } = rewindArgs(args, [
      "runId",
      "activationKey",
      "requestId",
    ]);
    return graphRuns(context).restart(runId, activationKey, {
      ...(requestId !== undefined ? { requestId } : {}),
      requestedBy: "user",
    });
  });
  register("graph_run_rewind_code_preview", async (args, context) => {
    const { runId, activationKey } = rewindArgs(args, ["runId", "activationKey"]);
    return graphRuns(context).previewCodeRewind(runId, activationKey);
  });
  register("graph_run_rewind_code", async (args, context) => {
    const { runId, activationKey, requestId } = rewindArgs(args, [
      "runId",
      "activationKey",
      "expectedHead",
      "requestId",
    ]);
    const expectedHead = args.expectedHead;
    if (typeof expectedHead !== "string" || !GRAPH_COMMIT_PATTERN.test(expectedHead)) {
      rewindInvalid("expectedHead must be the full commit SHA the preview showed");
    }
    return graphRuns(context).rewindCode(runId, activationKey, expectedHead, {
      ...(requestId !== undefined ? { requestId } : {}),
      requestedBy: "user",
    });
  });
}

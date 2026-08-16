import { createHash } from "node:crypto";
import type { BuildPhase, BuildPipeline, BuildPipelineAgent, BuildPipelineSource, BuildStepConfigs, PipelineSession, PendingPipelineInteractionResolution, PipelineSessionPhase, ResumableBuildPhase, StartBuildPipelineInput } from "@orkestrator/protocol/build-pipeline";
import { BUILD_STEP_KEYS, isActiveBuildPhase, VERIFICATION_VERDICT_SCHEMA } from "@orkestrator/protocol/build-pipeline";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { AGENT_INTERACTION_LIMITS, AGENT_INTERACTION_SUMMARY_VERSION, type AgentInteractionOutcome, type AgentInteractionRequest, type AgentInteractionWorkflowSummary } from "@orkestrator/protocol/agent-interactions";
import type { AppConfig } from "./models.js";
import { type BuildPipelineProvider, type ProviderExecutionMode } from "./build-pipeline-provider.js";

/**
 * How many times the worktree probe is attempted before its result is treated
 * as unknown. One command round trip into a container can fail transiently, and
 * an unknown result is terminal for the stage, so a single failure should not
 * decide it.
 */
export const WORKTREE_PROBE_ATTEMPTS = 3;

/** Stage names used in the certification errors a user reads on a failure. */
export const VALIDATION_STAGE_LABELS = {
  review: "Review",
  verify: "Verification",
} as const;

export type CommandInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

// The transcript renderer recognizes a verification answer by the same contract
// the turn is constrained to, and the protocol package derives both that schema
// and its type guard from one field list, so neither can drift from the other.
export const VERIFICATION_SCHEMA: JsonSchema = VERIFICATION_VERDICT_SCHEMA;

export const SESSION_LABELS: Record<PipelineSessionPhase, string> = {
  build: "Build Session",
  review: "Review Session",
  address: "Address Issues Session",
  verify: "Verification Session",
  fix: "Fix Session",
  pr: "PR Creation Session",
  "resolve-conflicts": "Conflict Resolution Session",
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A stage failed before its new session was durably recorded.
 *
 * The durable current session still belongs to the preceding stage in this
 * case, so the terminal failure handler must not attribute the error to it.
 */
export class PreSessionStageStartError extends Error {
  constructor(error: unknown, readonly phase: ResumableBuildPhase) {
    super(errorMessage(error));
    this.name = "PreSessionStageStartError";
  }
}

export function canonicalAdmissionSource(
  source: BuildPipelineSource | undefined,
): Record<string, unknown> | null {
  if (!source) return null;
  if (source.type === "kanban") {
    return {
      type: source.type,
      taskId: source.taskId.trim(),
    };
  }
  if (source.type === "linear") {
    return {
      type: source.type,
      issueId: source.issueId.trim(),
    };
  }
  return {
    type: source.type,
    repositoryOwner: source.repositoryOwner.trim().toLowerCase(),
    repositoryName: source.repositoryName.trim().toLowerCase(),
    issueNumber: source.issueNumber,
  };
}

export function buildAdmissionKey(input: StartBuildPipelineInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: input.projectId.trim(),
      taskId: input.taskId.trim(),
      source: canonicalAdmissionSource(input.source),
      existingEnvironmentId: input.existingEnvironmentId?.trim() || null,
      featurePlanId: input.featurePlanId?.trim() || null,
    }))
    .digest("hex");
}

export function sessionForCurrentPhase(pipeline: BuildPipeline): PipelineSession | undefined {
  return pipeline.sessions[pipeline.currentSessionIndex];
}

export function resumablePhase(phase: BuildPhase): ResumableBuildPhase | null {
  return isActiveBuildPhase(phase) ? phase as ResumableBuildPhase : null;
}

/**
 * The agent a repository's `defaultModel` and `defaultEffort` were chosen for.
 *
 * Both are stored as a single value per repository rather than one per agent, so
 * they only describe the repository's own default agent. Since steps may now run
 * a harness the repository was never configured for, every read of them has to
 * be gated on this.
 */
export function repositoryAgent(
  global: { defaultAgent?: BuildPipelineAgent },
  repository: { defaultAgent?: BuildPipelineAgent },
): BuildPipelineAgent {
  return repository.defaultAgent ?? global.defaultAgent ?? "claude";
}

/**
 * The default model for one harness.
 *
 * `repositoryDefault` is only passed when the caller has established that
 * `agent` is the repository's default agent; handing a Codex model id to the
 * Claude bridge is what happens otherwise.
 */
export function modelFor(
  agent: BuildPipelineAgent,
  global: {
    claudeModel?: string;
    codexModel: string;
    opencodeModel: string;
  },
  repositoryDefault?: string,
): string | undefined {
  if (repositoryDefault && repositoryDefault !== "default") return repositoryDefault;
  const model = agent === "claude"
    ? global.claudeModel
    : agent === "codex"
      ? global.codexModel
      : global.opencodeModel;
  return model && model !== "default" ? model : undefined;
}

/**
 * The connection-level model and reasoning effort for one harness.
 *
 * The repository defaults apply only to the repository's own default agent. A
 * step that pinned a different harness falls back to that harness's global
 * default instead, which is exactly what the launcher displayed for it.
 */
export function connectionDefaultsFor(
  agent: BuildPipelineAgent,
  config: Pick<AppConfig, "global">,
  repository: {
    defaultAgent?: BuildPipelineAgent;
    defaultModel?: string;
    defaultEffort?: string;
  },
): { model?: string; effort?: string } {
  const owns = agent === repositoryAgent(config.global, repository);
  return {
    model: modelFor(
      agent,
      config.global,
      owns ? repository.defaultModel : undefined,
    ),
    effort: (owns ? repository.defaultEffort : undefined)
      ?? (agent === "codex" ? config.global.codexReasoningEffort : undefined),
  };
}

/**
 * The harness a session runs on.
 *
 * Falls back to the pipeline agent for sessions recorded before steps could
 * choose their own, which all ran on that one agent.
 */
export function sessionAgent(
  pipeline: BuildPipeline,
  session: PipelineSession,
): BuildPipelineAgent {
  return session.agent ?? pipeline.agentType;
}

/** Every harness a pipeline may hold a provider for. */
export function pipelineAgents(pipeline: BuildPipeline): Set<BuildPipelineAgent> {
  const agents = new Set<BuildPipelineAgent>([pipeline.agentType]);
  for (const key of BUILD_STEP_KEYS) {
    const agent = pipeline.steps?.[key]?.agent;
    if (agent) agents.add(agent);
  }
  for (const session of pipeline.sessions) {
    agents.add(sessionAgent(pipeline, session));
  }
  return agents;
}

/**
 * The model a step actually pinned, or `undefined` for "no selection".
 *
 * `"default"` is a **real Claude catalog id** — the bridge resolves it to Opus
 * with a 1M context — so discarding it there silently downgrades the run to the
 * global default and contradicts the model the launcher displayed. For Codex and
 * OpenCode the same string is only ever the placeholder the launcher shows when
 * that harness has no catalog yet, and no server would recognise it, so there it
 * does mean "unset". The same asymmetry is documented at the other consumer,
 * `CreateEnvironmentDialog`.
 */
export function stepModel(
  agent: BuildPipelineAgent,
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "default" && agent !== "claude") return undefined;
  return trimmed;
}

/**
 * Drops empty selections so a step that only pinned a harness does not also pin
 * a placeholder as a model id or the string "default" as a reasoning effort.
 */
export function normalizeSteps(
  steps: BuildStepConfigs | undefined,
): BuildStepConfigs | undefined {
  if (!steps) return undefined;
  const normalized: BuildStepConfigs = {};
  for (const key of BUILD_STEP_KEYS) {
    const step = steps[key];
    if (!step) continue;
    const model = stepModel(step.agent, step.model);
    const reasoningEffort = step.reasoningEffort?.trim();
    normalized[key] = {
      agent: step.agent,
      ...(model ? { model } : {}),
      ...(reasoningEffort && reasoningEffort !== "default"
        ? { reasoningEffort }
        : {}),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function sessionPhaseFor(
  phase: ResumableBuildPhase,
): PipelineSessionPhase | null {
  switch (phase) {
    case "building":
      return "build";
    case "reviewing":
      return "review";
    case "addressing":
      return "address";
    case "verifying":
      return "verify";
    case "fixing":
      return "fix";
    case "creating-pr":
      return "pr";
    case "resolving-conflicts":
      return "resolve-conflicts";
    case "creating-environment":
    case "starting-environment":
    case "waiting-for-setup":
      return null;
  }
}

export function executionModeOverrideForPhase(
  phase: ResumableBuildPhase,
): ProviderExecutionMode | undefined {
  return phase === "addressing" ? "build" : undefined;
}

export function resumePromptFor(phase: ResumableBuildPhase): string | null {
  switch (phase) {
    case "building":
      return "Resume the build pipeline from where you left off. Continue implementing the original ticket, incorporate any messages sent while the pipeline was paused, validate the work as appropriate, and stop when the implementation is ready for review. Do not ask questions; make sensible assumptions.";
    case "reviewing":
      return "Resume the build pipeline review from where you left off. Continue reviewing the current changes against the original ticket and target branch, incorporate any messages sent while the pipeline was paused, and finish with the required structured review result. Use ordinary prose for interim progress and make the final assistant message the only structured report. Do not ask questions; make sensible assumptions.";
    case "addressing":
      return "Resume addressing the review findings from where you left off. Incorporate any messages sent while the pipeline was paused, make the required code and test changes, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "verifying":
      return "Resume verification from where you left off. Re-check the current codebase against the original ticket and incorporate any messages sent while the pipeline was paused. Use ordinary prose for interim progress, never emit a provisional verdict, and make the final assistant message the only JSON object required by the verification instructions.";
    case "fixing":
      return "Resume fixing the verification failures from where you left off. Incorporate any messages sent while the pipeline was paused, finish the requested fixes, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "creating-pr":
      return "Resume creating the pull request from where you left off. Incorporate any messages sent while the pipeline was paused, push or prepare the branch as needed, and create the PR against the target branch if it is not already created. Do not ask questions; make sensible assumptions.";
    case "resolving-conflicts":
      return "Resume resolving PR merge conflicts from where you left off. Incorporate any messages sent while the pipeline was paused, finish the conflict resolution, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "creating-environment":
    case "starting-environment":
    case "waiting-for-setup":
      return null;
  }
}

export type PullRequestDetection = {
  url: string;
  state: "open" | "merged" | "closed";
  hasMergeConflicts: boolean | null;
};

/**
 * How long a pipeline may stay in reconnect before it is failed.
 *
 * Without a bound, a bridge that starts but never answers keeps the pipeline in
 * "Reconnecting…" for the life of the process: every tick evicts the provider,
 * rebuilds it, fails again, and nothing ever escalates to the user.
 */
export const DEFAULT_RECONNECT_DEADLINE_MS = 5 * 60_000;

/**
 * How long a finished turn may withhold its structured result before the
 * pipeline fails.
 *
 * `provider.structured()` returning null means "not available yet", which is
 * normal for a tick or two. It is also what a bridge returns after it has
 * forgotten an in-memory result (a restart mid-turn), and there the session is
 * idle forever — so polling it without a deadline is a silent livelock.
 */
export const DEFAULT_STRUCTURED_RESULT_DEADLINE_MS = 2 * 60_000;

/**
 * How many times a review session may be asked to re-emit a report that failed
 * contract validation before the stage fails.
 *
 * A rejected report is not a rejected review: the analysis behind it took a full
 * turn and is usually sound, and only its shape is wrong. Asking the same
 * session for a corrected report is far cheaper than restarting the stage, and
 * the reviewer is told exactly which rules it broke. The count is bounded
 * because a model that cannot satisfy the contract will not start doing so on
 * the tenth attempt, and an unbounded loop is indistinguishable from a hang.
 */
export const MAX_STRUCTURED_REPORT_REPAIR_ATTEMPTS = 3;

/**
 * Minimum spacing between transcript-only snapshot writes for a running turn.
 *
 * Persisting the pipeline rewrites the whole build-pipelines file, so following
 * a streaming transcript at the tick rate turns every active build into a
 * continuous full-file rewrite. Status changes and phase transitions still
 * persist immediately; only a pure transcript delta is throttled.
 */
export const DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS = 5_000;
export const DEFAULT_STALL_WARNING_MS = 2 * 5 * 60_000;
export const DEFAULT_INTERACTION_PROCESSING_LEASE_MS = 2 * 60_000;
export const UNATTENDED_POLICY_INSTRUCTION =
  "This is a non-interactive build session: no user can answer a provider input request. "
  + "If input is unavailable or declined, choose the safest likely assumption yourself, "
  + "state that assumption, and continue. Never treat the absence of a person as authorization.";

export function withUnattendedPolicy(prompt: string): string {
  return `${prompt}\n\n${UNATTENDED_POLICY_INSTRUCTION}`;
}

/**
 * Change detector for a transcript snapshot.
 *
 * Serializing both sides in full on every tick costs O(transcript) twice per
 * pass, per pipeline, and transcripts reach megabytes. Provider transcripts
 * grow by appending and by rewriting the entry currently streaming, so the
 * length plus the tail entry captures every change they actually make.
 */
export function transcriptFingerprint(messages: unknown[]): string {
  if (messages.length === 0) return "0:";
  let tail: string;
  try {
    tail = JSON.stringify(messages[messages.length - 1]) ?? "";
  } catch {
    // A transcript that cannot be serialized cannot be persisted either; treat
    // every observation as a change so the save path reports the real error.
    tail = String(Date.now());
  }
  return `${messages.length}:${tail}`;
}

/**
 * Attach the provider's agent process before a prompt is written.
 *
 * A cold agent process is the slowest thing a dispatch can wait on, and time
 * spent on it inside the request is time the outcome is unknowable if the
 * connection drops. The pipeline recovers from that — it keeps
 * `pendingPromptAttempt` and retries the same request id — but recovery is a
 * whole tick, and one that reports the stage as reconnecting on the way. Paying
 * the cold start here instead keeps the send short.
 *
 * Best-effort by contract: the prompt request performs the same work, so a
 * failure is left for it to report rather than pre-empting it here.
 */
export async function attachBeforeDispatch(
  provider: BuildPipelineProvider,
  sessionId: string,
): Promise<void> {
  try {
    await provider.prepareDispatch?.(sessionId);
  } catch (error) {
    console.warn(
      "[build-pipeline] Attaching the agent before dispatch failed:",
      errorMessage(error),
    );
  }
}

export function elapsedSince(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Date.now() - parsed : null;
}

export function elapsedSinceLatest(...timestamps: Array<string | undefined>): number | null {
  const parsed = timestamps
    .map((timestamp) => timestamp ? Date.parse(timestamp) : Number.NaN)
    .filter(Number.isFinite);
  return parsed.length > 0 ? Date.now() - Math.max(...parsed) : null;
}

export function interactionPresentation(
  request: AgentInteractionRequest,
  session: PipelineSession,
  journalId: string,
  claimedAt: number,
  action: PendingPipelineInteractionResolution["action"],
): PendingPipelineInteractionResolution {
  const visible = action === "decline-and-continue";
  const truncate = (value: string, maximum: number): string =>
    value.length <= maximum
      ? value
      : `${value.slice(0, Math.max(0, maximum - 1))}…`;
  return {
    journalId,
    sessionKey: session.sessionKey,
    sessionId: session.sdkSessionId,
    interactionId: request.id,
    provider: request.provider,
    kind: request.kind,
    phase: session.phase,
    // A provider's `createdAt` is not durable: OpenCode and the bridges fall
    // back to `Date.now()` on a first-seen miss, so a restart re-dates a live
    // request to *after* the claim that recovery is rebuilding from. The
    // persisted envelope must satisfy `claimedAt >= requestedAt`, so anchor the
    // request to the claim whenever the provider reports a later time.
    requestedAt: Math.min(request.createdAt, claimedAt),
    claimedAt,
    action,
    title: visible
      ? truncate(request.presentation.title, 512)
      : `Unexpected ${request.provider} ${request.kind} authorization`,
    ...(visible && request.presentation.body
      ? { body: truncate(request.presentation.body, 1_024) }
      : {}),
    questions: visible ? request.presentation.questions.slice(0, 4).map((question) => ({
      prompt: truncate(question.prompt, 512),
      // Labels are sufficient for review. Provider values may carry secrets or
      // executable content and never belong in workflow-owned persistence.
      options: question.options.slice(0, 8).map((option) =>
        truncate(option.label, 128)
      ),
    })) : [],
  };
}

export function appendInteractionSummary(
  summary: AgentInteractionWorkflowSummary | undefined,
  pending: PendingPipelineInteractionResolution,
  outcome: AgentInteractionOutcome,
  rawResolvedAt: number,
): AgentInteractionWorkflowSummary {
  // The summary validator enforces `lastResolvedAt >= firstSeenAt`. A clock that
  // stepped backwards between the request and its resolution must degrade to an
  // equal timestamp, never to an unparseable snapshot.
  const resolvedAt = Math.max(rawResolvedAt, pending.requestedAt);
  const next: AgentInteractionWorkflowSummary = summary
    ? structuredClone(summary)
    : { version: AGENT_INTERACTION_SUMMARY_VERSION, entries: [] };
  const existing = next.entries.find((entry) =>
    entry.provider === pending.provider
    && entry.kind === pending.kind
    && entry.phase === pending.phase
    && entry.sessionId === pending.sessionId
    && entry.outcome === outcome
  );
  if (existing) {
    existing.count += 1;
    existing.firstSeenAt = Math.min(existing.firstSeenAt, pending.requestedAt);
    existing.lastResolvedAt = Math.max(existing.lastResolvedAt ?? 0, resolvedAt);
    return next;
  }
  if (next.entries.length >= AGENT_INTERACTION_LIMITS.maxWorkflowSummaries) {
    // Summary capacity is metadata-only and must not make resolution fail. Fold
    // into the oldest same-outcome entry when possible; transcript records stay
    // independently bounded and exact.
    const folded = next.entries.find((entry) => entry.outcome === outcome);
    if (folded) {
      folded.count += 1;
      folded.lastResolvedAt = Math.max(folded.lastResolvedAt ?? 0, resolvedAt);
    }
    return next;
  }
  next.entries.push({
    provider: pending.provider,
    kind: pending.kind,
    phase: pending.phase,
    sessionId: pending.sessionId,
    firstSeenAt: pending.requestedAt,
    lastResolvedAt: resolvedAt,
    outcome,
    count: 1,
  });
  return next;
}

export function logInteractionOutcome(
  pending: PendingPipelineInteractionResolution,
  outcome: AgentInteractionOutcome,
  resolvedAt: number,
  count: number,
): void {
  // Deliberately metadata-only. Never add title/body/options, provider values,
  // URLs, commands, paths, answers, session IDs or workflow IDs here.
  console.info("[build-pipeline] interaction resolved", {
    provider: pending.provider,
    kind: pending.kind,
    phase: pending.phase,
    outcome,
    latencyMs: Math.max(0, resolvedAt - pending.requestedAt),
    count,
  });
}



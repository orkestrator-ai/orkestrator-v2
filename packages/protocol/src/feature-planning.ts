/**
 * Feature-planning workflow contract.
 *
 * The planning conversation — create environment, start the Codex bridge,
 * create a session, dispatch the prompt, wait for the reply, parse it, apply it
 * to the plan — is owned by the backend. This module holds the durable record
 * it advances plus the pure prompt/parse helpers both sides need, so the guard
 * the renderer projects through cannot drift from the one the backend writes.
 *
 * Everything here is pure. No I/O, no clocks, no randomness: the backend stamps
 * timestamps and ids, and the renderer only reads.
 */

/* ------------------------------------------------------------------ *
 * Structural plan shapes
 *
 * Declared here rather than imported so the prompt builders can be shared by
 * the renderer's `FeaturePlan` and the backend's, which are separate
 * declarations of the same persisted record.
 * ------------------------------------------------------------------ */

export interface FeaturePlannerMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  modelId?: string;
  stateApplication?: "pending" | "applied" | "superseded";
}

export interface FeaturePlannerStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  messages: FeaturePlannerMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface FeaturePlannerFeature {
  id: string;
  title: string;
  summary: string;
  messages: FeaturePlannerMessage[];
  stories: FeaturePlannerStory[];
}

/* ------------------------------------------------------------------ *
 * Prompt construction and state-block parsing
 * ------------------------------------------------------------------ */

const FEATURE_STATE_BLOCK_RE =
  /<feature_planner_state>\s*([\s\S]*?)\s*<\/feature_planner_state>/i;
const STORY_STATE_BLOCK_RE =
  /<story_refinement>\s*([\s\S]*?)\s*<\/story_refinement>/i;

export interface ParsedFeaturePlannerState {
  phase?: "collecting" | "confirming" | "stories";
  title?: string;
  summary?: string;
  stories?: Array<{
    id?: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
  }>;
}

export interface ParsedStoryRefinement {
  storyId?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
}

export const FEATURE_PLANNER_SYSTEM_PROMPT = `You are the Orkestrator feature discovery agent.

Your job is to collect enough information to create implementable user stories.

Rules:
- Start from the user's feature description and ask concise follow-up questions until the feature is clear enough to split into user stories.
- Ask no more than 3 questions in one response.
- Use read-only codebase inspection tools when existing implementation details would clarify the feature, such as searching or reading files.
- When you have enough information, describe the feature exactly as the user has described it and ask for confirmation before generating user stories.
- When the user confirms, generate user story cards with a title, one-paragraph description, and acceptance criteria.
- Do not write code, edit files, or run mutating commands in this planning chat.
- When you regenerate or revise stories that already appeared in an earlier state block, reuse that story's exact "id" value. Only omit "id" for brand-new stories you are introducing for the first time.
- Every assistant response must end with exactly one machine-readable state block.

State block format:
<feature_planner_state>
{"phase":"collecting","title":"short feature name","summary":""}
</feature_planner_state>

When asking for confirmation, use:
<feature_planner_state>
{"phase":"confirming","title":"short feature name","summary":"confirmed feature summary"}
</feature_planner_state>

When generating cards, use (include "id" only when reusing a story from a previous state block):
<feature_planner_state>
{"phase":"stories","title":"short feature name","summary":"confirmed feature summary","stories":[{"id":"existing-story-id-if-any","title":"story title","description":"one paragraph","acceptanceCriteria":["criterion"]}]}
</feature_planner_state>`;

export function createFeaturePlannerInitialPrompt(userMessage: string): string {
  return `${FEATURE_PLANNER_SYSTEM_PROMPT}

The user has started describing a new feature. Continue the discovery conversation.

User message:
${userMessage}`;
}

export function createFeaturePlannerResumePrompt(
  feature: FeaturePlannerFeature,
  userMessage: string,
): string {
  const transcript = feature.messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${stripFeaturePlannerStateBlocks(message.content)}`
    )
    .join("\n\n");

  const existingStories = feature.stories.length
    ? `\n\nExisting stories (reuse the exact id when you regenerate or revise any of these):\n${
      feature.stories
        .map((story) => `- id: ${story.id} | title: ${story.title}`)
        .join("\n")
    }`
    : "";

  return `${FEATURE_PLANNER_SYSTEM_PROMPT}

This is a resumed planning session. Use the persisted transcript below as the full source of conversation history, then respond to the latest user message.${existingStories}

Persisted transcript:
${transcript}

Latest user message:
${userMessage}`;
}

/**
 * Decides which planner prompt to send. When the Codex session is the same one
 * already in use we rely on its retained context and send only the raw message.
 * Otherwise we either bootstrap (first user message) or rebuild the
 * conversation from the persisted transcript (resumed/recreated session).
 */
export function selectFeaturePlannerPrompt(params: {
  feature: FeaturePlannerFeature;
  userMessage: string;
  previousSessionId: string | null | undefined;
  sessionId: string;
}): string {
  const { feature, userMessage, previousSessionId, sessionId } = params;
  const isContinuingSameSession = !!previousSessionId
    && previousSessionId === sessionId;
  if (isContinuingSameSession) return userMessage;

  const userMessageCount =
    feature.messages.filter((message) => message.role === "user").length;
  return userMessageCount <= 1
    ? createFeaturePlannerInitialPrompt(userMessage)
    : createFeaturePlannerResumePrompt(feature, userMessage);
}

export function createStoryRefinementPrompt(
  story: FeaturePlannerStory,
  userMessage: string,
): string {
  const transcript = story.messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${stripStoryRefinementStateBlocks(message.content)}`
    )
    .join("\n\n");

  return `You are refining one user story for an Orkestrator feature plan.

Current story:
Title: ${story.title}
Description: ${story.description}
Acceptance criteria:
${story.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n") || "- None yet"}

Refinement chat so far:
${transcript || "No refinement messages yet."}

Apply the user's requested refinement. Respond conversationally, then end with exactly one updated story block:

<story_refinement>
{"storyId":"${story.id}","title":"updated title","description":"updated one paragraph description","acceptanceCriteria":["updated criterion"]}
</story_refinement>

User message:
${userMessage}`;
}

export function parseFeaturePlannerState(
  content: string,
): ParsedFeaturePlannerState | null {
  const match = content.match(FEATURE_STATE_BLOCK_RE);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (
      parsed.phase !== undefined
      && parsed.phase !== "collecting"
      && parsed.phase !== "confirming"
      && parsed.phase !== "stories"
    ) {
      return null;
    }
    if (parsed.title !== undefined && typeof parsed.title !== "string") {
      return null;
    }
    if (parsed.summary !== undefined && typeof parsed.summary !== "string") {
      return null;
    }
    if (parsed.phase === "stories" && !Array.isArray(parsed.stories)) {
      return null;
    }
    if (parsed.stories !== undefined) {
      if (!Array.isArray(parsed.stories)) return null;
      for (const story of parsed.stories) {
        if (!story || typeof story !== "object" || Array.isArray(story)) {
          return null;
        }
        const candidate = story as Record<string, unknown>;
        if (candidate.id !== undefined && typeof candidate.id !== "string") {
          return null;
        }
        if (
          typeof candidate.title !== "string"
          || typeof candidate.description !== "string"
        ) {
          return null;
        }
        if (
          !Array.isArray(candidate.acceptanceCriteria)
          || !candidate.acceptanceCriteria.every(
            (criterion) => typeof criterion === "string",
          )
        ) {
          return null;
        }
      }
    }
    return parsed as ParsedFeaturePlannerState;
  } catch {
    return null;
  }
}

export function parseStoryRefinement(
  content: string,
): ParsedStoryRefinement | null {
  const match = content.match(STORY_STATE_BLOCK_RE);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (parsed.storyId !== undefined && typeof parsed.storyId !== "string") {
      return null;
    }
    if (parsed.title !== undefined && typeof parsed.title !== "string") {
      return null;
    }
    if (
      parsed.description !== undefined
      && typeof parsed.description !== "string"
    ) {
      return null;
    }
    if (
      parsed.acceptanceCriteria !== undefined
      && (
        !Array.isArray(parsed.acceptanceCriteria)
        || !parsed.acceptanceCriteria.every(
          (criterion) => typeof criterion === "string",
        )
      )
    ) {
      return null;
    }
    return parsed as ParsedStoryRefinement;
  } catch {
    return null;
  }
}

export function stripFeaturePlannerStateBlocks(content: string): string {
  return content.replace(FEATURE_STATE_BLOCK_RE, "").trim();
}

export function stripStoryRefinementStateBlocks(content: string): string {
  return content.replace(STORY_STATE_BLOCK_RE, "").trim();
}

/**
 * Reconciles a parsed state block against the stories already on the plan.
 *
 * `newStoryId` supplies ids for brand-new cards. The backend passes a UUID
 * factory; keeping it a parameter is what lets this stay pure and therefore
 * shared.
 */
export function createStoryCardsFromParsedState(
  parsed: ParsedFeaturePlannerState,
  existingStories: FeaturePlannerStory[],
  options: { now: string; newStoryId: () => string },
): FeaturePlannerStory[] {
  const { now, newStoryId } = options;
  const existingById = new Map(existingStories.map((story) => [story.id, story]));
  const existingByTitle = new Map(
    existingStories.map((story) => [story.title.toLowerCase(), story]),
  );

  return (parsed.stories ?? []).map((story) => {
    // Prefer matching by the round-tripped id so a renamed story keeps its
    // refinement history; fall back to title for stories the model emits
    // without an id (e.g. brand-new cards or models that drop the id).
    const existing = (story.id ? existingById.get(story.id) : undefined)
      ?? existingByTitle.get(story.title.toLowerCase());
    return {
      id: existing?.id ?? story.id ?? newStoryId(),
      title: story.title,
      description: story.description,
      acceptanceCriteria: Array.isArray(story.acceptanceCriteria)
        ? story.acceptanceCriteria
        : [],
      messages: existing?.messages ?? [{
        id: newStoryId(),
        role: "assistant" as const,
        content: "What would you like to refine on this user story?",
        createdAt: now,
      }],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  });
}

export function formatFeatureStoriesForBuild(
  feature: FeaturePlannerFeature,
): { title: string; description: string } {
  const title = feature.title.trim() || "Feature plan";
  const storySections = feature.stories.map((story, index) =>
    [
      `### ${index + 1}. ${story.title}`,
      story.description,
      "Acceptance criteria:",
      ...story.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ].filter(Boolean).join("\n")
  );

  return {
    title,
    description: [
      feature.summary ? `Feature summary:\n${feature.summary}` : "",
      "Implementation instruction: Build all user stories below. Use Codex threads or sub-agents in parallel wherever the stories are independent, then integrate the work and validate the complete result.",
      "User stories:",
      storySections.join("\n\n"),
    ].filter(Boolean).join("\n\n"),
  };
}

/* ------------------------------------------------------------------ *
 * Durable planning record
 * ------------------------------------------------------------------ */

/**
 * Version 1 is the first backend-owned planning record. Conversations driven by
 * the previous React controller carried no record at all; they are adopted from
 * their unanswered persisted message on startup (see the backend service).
 */
export const FEATURE_PLANNING_RECORD_VERSION = 1 as const;

/**
 * Explicit bounds for every field a provider or a user can grow (invariant 11).
 * The record is stored inline on the plan, which storage rejects above 32 MB —
 * so an unbounded raw reply would make the plan unwritable rather than trimmed.
 */
export const FEATURE_PLANNING_LIMITS = {
  maxIdLength: 512,
  maxUserMessageLength: 100_000,
  maxRawResponseLength: 512 * 1024,
  maxBaselineAssistantIds: 512,
  maxFailureMessageLength: 2_048,
} as const;

export const FEATURE_PLANNING_PHASES = [
  "dispatching",
  "running",
  "persisting",
  "complete",
  "failed",
] as const;
export type FeaturePlanningPhase = (typeof FEATURE_PLANNING_PHASES)[number];

/** Phases the backend advances on its own. */
export const FEATURE_PLANNING_ACTIVE_PHASES = [
  "dispatching",
  "running",
  "persisting",
] as const;
export type ActiveFeaturePlanningPhase =
  (typeof FEATURE_PLANNING_ACTIVE_PHASES)[number];

export const FEATURE_PLANNING_FAILURE_CODES = [
  "environment",
  "bridge",
  "dispatch",
  "provider",
  "parse",
  "persistence",
] as const;
export type FeaturePlanningFailureCode =
  (typeof FEATURE_PLANNING_FAILURE_CODES)[number];

export interface FeaturePlanningFailure {
  code: FeaturePlanningFailureCode;
  message: string;
  occurredAt: string;
  /** Phase a retry re-enters. */
  retryPhase: ActiveFeaturePlanningPhase;
}

export type FeaturePlanningKind = "feature" | "story";

export interface FeaturePlanningRecord {
  version: typeof FEATURE_PLANNING_RECORD_VERSION;
  /** Identity of this one request/response exchange. */
  operationId: string;
  featureId: string;
  projectId: string;
  kind: FeaturePlanningKind;
  /** Set when `kind` is `story`. */
  storyId?: string;
  /**
   * The user's text, retained verbatim so a retry can re-dispatch without a
   * renderer being present to supply it again.
   */
  userMessage: string;
  /** Persisted user message this exchange answers. */
  userMessageId?: string;
  environmentId?: string;
  providerSessionId?: string;
  /**
   * Stamped before the prompt is handed to the bridge. Its presence means the
   * turn may already be running, so the same exchange must never re-send under
   * a new id — an ambiguous dispatch reconciles by reading the transcript.
   */
  dispatchId?: string;
  requestId?: string;
  dispatchState?: "prepared" | "sent";
  /**
   * Assistant message ids present before dispatch. The reply is the newest
   * assistant message not in this set, which is what makes "which message
   * answered me" survive a reload.
   */
  baselineAssistantIds?: string[];
  phase: FeaturePlanningPhase;
  /**
   * The assistant's answer, written to the record before anything is applied to
   * the plan. This is the field that stops a reload or a parse failure from
   * destroying the reply.
   */
  rawResponse?: string;
  responseModelId?: string;
  /** Set once the reply has been appended to the plan, before it is applied. */
  responseMessageId?: string;
  failure?: FeaturePlanningFailure;
  startedAt: string;
  updatedAt: string;
  /** Monotonic per-record revision; the renderer projection rejects stale writes. */
  backendRevision: number;
}

export interface StartFeaturePlanningInput {
  featureId: string;
  kind: FeaturePlanningKind;
  storyId?: string;
  userMessage: string;
}

export function isFeaturePlanningPhase(
  value: unknown,
): value is FeaturePlanningPhase {
  return FEATURE_PLANNING_PHASES.includes(value as FeaturePlanningPhase);
}

export function isActiveFeaturePlanningPhase(
  value: unknown,
): value is ActiveFeaturePlanningPhase {
  return FEATURE_PLANNING_ACTIVE_PHASES.includes(
    value as ActiveFeaturePlanningPhase,
  );
}

export function isTerminalFeaturePlanningPhase(
  phase: FeaturePlanningPhase,
): boolean {
  return phase === "complete" || phase === "failed";
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || isBoundedString(value, max);
}

function isFeaturePlanningFailure(
  value: unknown,
): value is FeaturePlanningFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    FEATURE_PLANNING_FAILURE_CODES.includes(
      candidate.code as FeaturePlanningFailureCode,
    )
    && isBoundedString(
      candidate.message,
      FEATURE_PLANNING_LIMITS.maxFailureMessageLength,
    )
    && typeof candidate.occurredAt === "string"
    && isActiveFeaturePlanningPhase(candidate.retryPhase)
  );
}

/**
 * Validates a record before it is trusted.
 *
 * The renderer drops a record it rejects, so this must accept exactly what the
 * backend writes — that is the whole reason it lives here rather than being
 * restated on each side.
 */
export function isFeaturePlanningRecord(
  value: unknown,
): value is FeaturePlanningRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const { maxIdLength } = FEATURE_PLANNING_LIMITS;
  if (candidate.version !== FEATURE_PLANNING_RECORD_VERSION) return false;
  if (
    !isBoundedString(candidate.operationId, maxIdLength)
    || !isBoundedString(candidate.featureId, maxIdLength)
    || !isBoundedString(candidate.projectId, maxIdLength)
  ) {
    return false;
  }
  if (candidate.kind !== "feature" && candidate.kind !== "story") return false;
  if (candidate.kind === "story" && !isBoundedString(candidate.storyId, maxIdLength)) {
    return false;
  }
  if (candidate.kind === "feature" && candidate.storyId !== undefined) return false;
  if (
    !isBoundedString(
      candidate.userMessage,
      FEATURE_PLANNING_LIMITS.maxUserMessageLength,
    )
  ) {
    return false;
  }
  if (
    !isOptionalBoundedString(candidate.userMessageId, maxIdLength)
    || !isOptionalBoundedString(candidate.environmentId, maxIdLength)
    || !isOptionalBoundedString(candidate.providerSessionId, maxIdLength)
    || !isOptionalBoundedString(candidate.dispatchId, maxIdLength)
    || !isOptionalBoundedString(candidate.requestId, maxIdLength)
    || !isOptionalBoundedString(candidate.responseMessageId, maxIdLength)
    || !isOptionalBoundedString(candidate.responseModelId, maxIdLength)
  ) {
    return false;
  }
  if (
    candidate.dispatchState !== undefined
    && candidate.dispatchState !== "prepared"
    && candidate.dispatchState !== "sent"
  ) {
    return false;
  }
  if (candidate.baselineAssistantIds !== undefined) {
    const ids = candidate.baselineAssistantIds;
    if (
      !Array.isArray(ids)
      || ids.length > FEATURE_PLANNING_LIMITS.maxBaselineAssistantIds
      || !ids.every((id) => isBoundedString(id, maxIdLength))
    ) {
      return false;
    }
  }
  if (!isFeaturePlanningPhase(candidate.phase)) return false;
  if (
    !isOptionalBoundedString(
      candidate.rawResponse,
      FEATURE_PLANNING_LIMITS.maxRawResponseLength,
    )
  ) {
    return false;
  }
  if (
    candidate.failure !== undefined
    && !isFeaturePlanningFailure(candidate.failure)
  ) {
    return false;
  }
  return (
    typeof candidate.startedAt === "string"
    && typeof candidate.updatedAt === "string"
    && typeof candidate.backendRevision === "number"
    && Number.isSafeInteger(candidate.backendRevision)
    && candidate.backendRevision >= 0
  );
}

export function isStartFeaturePlanningInput(
  value: unknown,
): value is StartFeaturePlanningInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const { maxIdLength, maxUserMessageLength } = FEATURE_PLANNING_LIMITS;
  if (!isBoundedString(candidate.featureId, maxIdLength)) return false;
  if (candidate.kind !== "feature" && candidate.kind !== "story") return false;
  if (candidate.kind === "story" && !isBoundedString(candidate.storyId, maxIdLength)) {
    return false;
  }
  if (candidate.kind === "feature" && candidate.storyId !== undefined) return false;
  return (
    isBoundedString(candidate.userMessage, maxUserMessageLength)
    && candidate.userMessage.trim().length > 0
  );
}

/**
 * Truncates a provider-supplied reply to the persisted bound.
 *
 * Truncation is preferable to rejection: a reply too large to store is still
 * the user's answer, and dropping it entirely is the failure mode this whole
 * workstream exists to remove.
 */
export function boundRawResponse(content: string): string {
  const { maxRawResponseLength } = FEATURE_PLANNING_LIMITS;
  if (content.length <= maxRawResponseLength) return content;
  return `${content.slice(0, maxRawResponseLength - 1)}…`;
}

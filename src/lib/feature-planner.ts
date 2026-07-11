import type { FeaturePlan, FeatureStoryCard } from "@/lib/backend";
import { createUuid } from "@/lib/uuid";

const FEATURE_STATE_BLOCK_RE = /<feature_planner_state>\s*([\s\S]*?)\s*<\/feature_planner_state>/i;
const STORY_STATE_BLOCK_RE = /<story_refinement>\s*([\s\S]*?)\s*<\/story_refinement>/i;

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

export function createFeaturePlannerResumePrompt(feature: FeaturePlan, userMessage: string): string {
  const transcript = feature.messages
    .map((message) => `${message.role.toUpperCase()}: ${stripFeaturePlannerStateBlocks(message.content)}`)
    .join("\n\n");

  const existingStories = feature.stories.length
    ? `\n\nExisting stories (reuse the exact id when you regenerate or revise any of these):\n${feature.stories
        .map((story) => `- id: ${story.id} | title: ${story.title}`)
        .join("\n")}`
    : "";

  return `${FEATURE_PLANNER_SYSTEM_PROMPT}

This is a resumed planning session. Use the persisted transcript below as the full source of conversation history, then respond to the latest user message.${existingStories}

Persisted transcript:
${transcript}

Latest user message:
${userMessage}`;
}

// Decides which planner prompt to send. When the Codex session is the same one
// already in use we rely on its retained context and send only the raw message.
// Otherwise we either bootstrap (first user message) or rebuild the conversation
// from the persisted transcript (resumed/recreated session).
export function selectFeaturePlannerPrompt(params: {
  feature: FeaturePlan;
  userMessage: string;
  previousSessionId: string | null | undefined;
  sessionId: string;
}): string {
  const { feature, userMessage, previousSessionId, sessionId } = params;
  const isContinuingSameSession = !!previousSessionId && previousSessionId === sessionId;
  if (isContinuingSameSession) return userMessage;

  const userMessageCount = feature.messages.filter((message) => message.role === "user").length;
  return userMessageCount <= 1
    ? createFeaturePlannerInitialPrompt(userMessage)
    : createFeaturePlannerResumePrompt(feature, userMessage);
}

export function createStoryRefinementPrompt(story: FeatureStoryCard, userMessage: string): string {
  const transcript = story.messages
    .map((message) => `${message.role.toUpperCase()}: ${stripStoryRefinementStateBlocks(message.content)}`)
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

export function parseFeaturePlannerState(content: string): ParsedFeaturePlannerState | null {
  const match = content.match(FEATURE_STATE_BLOCK_RE);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as ParsedFeaturePlannerState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function parseStoryRefinement(content: string): ParsedStoryRefinement | null {
  const match = content.match(STORY_STATE_BLOCK_RE);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as ParsedStoryRefinement;
    return parsed && typeof parsed === "object" ? parsed : null;
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

export function createStoryCardsFromParsedState(
  parsed: ParsedFeaturePlannerState,
  existingStories: FeatureStoryCard[] = [],
): FeatureStoryCard[] {
  const now = new Date().toISOString();
  const existingById = new Map(existingStories.map((story) => [story.id, story]));
  const existingByTitle = new Map(existingStories.map((story) => [story.title.toLowerCase(), story]));

  return (parsed.stories ?? []).map((story) => {
    // Prefer matching by the round-tripped id so a renamed story keeps its
    // refinement history; fall back to title for stories the model emits
    // without an id (e.g. brand-new cards or models that drop the id).
    const existing = (story.id ? existingById.get(story.id) : undefined)
      ?? existingByTitle.get(story.title.toLowerCase());
    return {
      id: existing?.id ?? story.id ?? createUuid(),
      title: story.title,
      description: story.description,
      acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
      messages: existing?.messages ?? [{
        id: createUuid(),
        role: "assistant" as const,
        content: "What would you like to refine on this user story?",
        createdAt: now,
      }],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  });
}

export function formatFeatureStoriesForBuild(feature: FeaturePlan): {
  title: string;
  description: string;
} {
  const title = feature.title.trim() || "Feature plan";
  const storySections = feature.stories.map((story, index) => [
    `### ${index + 1}. ${story.title}`,
    story.description,
    "Acceptance criteria:",
    ...story.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ].filter(Boolean).join("\n"));

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

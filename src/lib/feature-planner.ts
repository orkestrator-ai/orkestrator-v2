import type { FeaturePlan, FeatureStoryCard } from "@/lib/backend";

const FEATURE_STATE_BLOCK_RE = /<feature_planner_state>\s*([\s\S]*?)\s*<\/feature_planner_state>/i;
const STORY_STATE_BLOCK_RE = /<story_refinement>\s*([\s\S]*?)\s*<\/story_refinement>/i;

export interface ParsedFeaturePlannerState {
  phase?: "collecting" | "confirming" | "stories";
  title?: string;
  summary?: string;
  stories?: Array<{
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
- When you have enough information, describe the feature exactly as the user has described it and ask for confirmation before generating user stories.
- When the user confirms, generate user story cards with a title, one-paragraph description, and acceptance criteria.
- Do not write code in this planning chat.
- Every assistant response must end with exactly one machine-readable state block.

State block format:
<feature_planner_state>
{"phase":"collecting","title":"short feature name","summary":""}
</feature_planner_state>

When asking for confirmation, use:
<feature_planner_state>
{"phase":"confirming","title":"short feature name","summary":"confirmed feature summary"}
</feature_planner_state>

When generating cards, use:
<feature_planner_state>
{"phase":"stories","title":"short feature name","summary":"confirmed feature summary","stories":[{"title":"story title","description":"one paragraph","acceptanceCriteria":["criterion"]}]}
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

  return `${FEATURE_PLANNER_SYSTEM_PROMPT}

This is a resumed planning session. Use the persisted transcript below as the full source of conversation history, then respond to the latest user message.

Persisted transcript:
${transcript}

Latest user message:
${userMessage}`;
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
  const existingByTitle = new Map(existingStories.map((story) => [story.title.toLowerCase(), story]));

  return (parsed.stories ?? []).map((story) => {
    const existing = existingByTitle.get(story.title.toLowerCase());
    return {
      id: existing?.id ?? crypto.randomUUID(),
      title: story.title,
      description: story.description,
      acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
      messages: existing?.messages ?? [{
        id: crypto.randomUUID(),
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
  acceptanceCriteria: string;
} {
  const title = feature.title.trim() || "Feature plan";
  const storySections = feature.stories.map((story, index) => [
    `${index + 1}. ${story.title}`,
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
    acceptanceCriteria: feature.stories
      .flatMap((story) => story.acceptanceCriteria.map((criterion) => `- ${story.title}: ${criterion}`))
      .join("\n"),
  };
}

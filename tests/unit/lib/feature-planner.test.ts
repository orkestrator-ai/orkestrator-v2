import { describe, expect, test } from "bun:test";
import {
  createFeaturePlannerInitialPrompt,
  createFeaturePlannerResumePrompt,
  createStoryCardsFromParsedState,
  createStoryRefinementPrompt,
  FEATURE_PLANNER_SYSTEM_PROMPT,
  formatFeatureStoriesForBuild,
  parseFeaturePlannerState,
  parseStoryRefinement,
  selectFeaturePlannerPrompt,
  stripFeaturePlannerStateBlocks,
  stripStoryRefinementStateBlocks,
} from "../../../src/lib/feature-planner";
import type { FeaturePlan, FeatureStoryCard } from "../../../src/lib/backend";

function makeStory(overrides: Partial<FeatureStoryCard> = {}): FeatureStoryCard {
  return {
    id: "story-1",
    title: "Save a filtered view",
    description: "A user can save the current filters.",
    acceptanceCriteria: ["Saved filters can be named"],
    messages: [{ id: "m1", role: "assistant", content: "refine?", createdAt: "2026-01-01T00:00:00.000Z" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFeature(overrides: Partial<FeaturePlan> = {}): FeaturePlan {
  return {
    id: "feature-1",
    projectId: "project-1",
    title: "Saved views",
    status: "stories",
    summary: "Users can save and reuse filtered views.",
    messages: [
      { id: "m1", role: "assistant", content: "Tell me about the new feature", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "m2", role: "user", content: "Users can save filters.", createdAt: "2026-01-01T00:00:01.000Z" },
    ],
    stories: [makeStory()],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    order: 0,
    ...overrides,
  };
}

describe("parseFeaturePlannerState", () => {
  test("parses a valid state block", () => {
    const content = `Here is the plan.
<feature_planner_state>
{"phase":"stories","title":"Saved views","summary":"sum","stories":[{"id":"s1","title":"t","description":"d","acceptanceCriteria":["a"]}]}
</feature_planner_state>`;
    expect(parseFeaturePlannerState(content)).toEqual({
      phase: "stories",
      title: "Saved views",
      summary: "sum",
      stories: [{ id: "s1", title: "t", description: "d", acceptanceCriteria: ["a"] }],
    });
  });

  test("returns null when there is no state block", () => {
    expect(parseFeaturePlannerState("just a normal reply")).toBeNull();
  });

  test("returns null for malformed JSON inside the block", () => {
    const content = `<feature_planner_state>
{phase:"collecting"}
</feature_planner_state>`;
    expect(parseFeaturePlannerState(content)).toBeNull();
  });

  test("uses the first block when several are present", () => {
    const content = `<feature_planner_state>
{"phase":"collecting","title":"first"}
</feature_planner_state>
<feature_planner_state>
{"phase":"stories","title":"second"}
</feature_planner_state>`;
    expect(parseFeaturePlannerState(content)?.title).toBe("first");
  });
});

describe("parseStoryRefinement", () => {
  test("parses a valid refinement block", () => {
    const content = `Updated.
<story_refinement>
{"storyId":"s1","title":"new","description":"desc","acceptanceCriteria":["a","b"]}
</story_refinement>`;
    expect(parseStoryRefinement(content)).toEqual({
      storyId: "s1",
      title: "new",
      description: "desc",
      acceptanceCriteria: ["a", "b"],
    });
  });

  test("returns null for missing or malformed blocks", () => {
    expect(parseStoryRefinement("no block here")).toBeNull();
    expect(parseStoryRefinement("<story_refinement>oops</story_refinement>")).toBeNull();
  });
});

describe("strip helpers", () => {
  test("stripFeaturePlannerStateBlocks removes the block and trims", () => {
    const content = `Reply text.
<feature_planner_state>
{"phase":"collecting"}
</feature_planner_state>`;
    expect(stripFeaturePlannerStateBlocks(content)).toBe("Reply text.");
  });

  test("stripStoryRefinementStateBlocks removes the block and trims", () => {
    const content = `Refined story.
<story_refinement>
{"storyId":"s1"}
</story_refinement>`;
    expect(stripStoryRefinementStateBlocks(content)).toBe("Refined story.");
  });

  test("leaves content without a block unchanged (trimmed)", () => {
    expect(stripFeaturePlannerStateBlocks("  hello  ")).toBe("hello");
  });
});

describe("createStoryCardsFromParsedState", () => {
  test("returns an empty array when no stories are present", () => {
    expect(createStoryCardsFromParsedState({ phase: "stories" })).toEqual([]);
  });

  test("creates new cards with a default refinement prompt and generated id", () => {
    const cards = createStoryCardsFromParsedState({
      phase: "stories",
      stories: [{ title: "New story", description: "d", acceptanceCriteria: ["a"] }],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "New story", description: "d", acceptanceCriteria: ["a"] });
    expect(cards[0]?.id).toBeTruthy();
    expect(cards[0]?.messages[0]).toMatchObject({ role: "assistant" });
  });

  test("coerces a non-array acceptanceCriteria to an empty array", () => {
    const cards = createStoryCardsFromParsedState({
      phase: "stories",
      stories: [{ title: "t", description: "d", acceptanceCriteria: "oops" as unknown as string[] }],
    });
    expect(cards[0]?.acceptanceCriteria).toEqual([]);
  });

  test("reuses an existing story by id even when the title changed, preserving history", () => {
    const existing = makeStory({ id: "story-1", title: "Old title" });
    const cards = createStoryCardsFromParsedState(
      {
        phase: "stories",
        stories: [{ id: "story-1", title: "Renamed title", description: "d2", acceptanceCriteria: ["a2"] }],
      },
      [existing],
    );
    expect(cards[0]?.id).toBe("story-1");
    expect(cards[0]?.title).toBe("Renamed title");
    expect(cards[0]?.messages).toEqual(existing.messages);
    expect(cards[0]?.createdAt).toBe(existing.createdAt);
  });

  test("falls back to title matching when the model omits the id", () => {
    const existing = makeStory({ id: "story-1", title: "Save a filtered view" });
    const cards = createStoryCardsFromParsedState(
      {
        phase: "stories",
        stories: [{ title: "save a filtered view", description: "d2", acceptanceCriteria: ["a2"] }],
      },
      [existing],
    );
    expect(cards[0]?.id).toBe("story-1");
    expect(cards[0]?.messages).toEqual(existing.messages);
  });
});

describe("prompt builders", () => {
  test("createFeaturePlannerInitialPrompt embeds the system prompt and user message", () => {
    const prompt = createFeaturePlannerInitialPrompt("Add saved filters");
    expect(prompt).toContain(FEATURE_PLANNER_SYSTEM_PROMPT);
    expect(prompt).toContain("Add saved filters");
  });

  test("createFeaturePlannerResumePrompt strips state blocks and lists existing story ids", () => {
    const feature = makeFeature({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: `Question?
<feature_planner_state>
{"phase":"collecting"}
</feature_planner_state>`,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const prompt = createFeaturePlannerResumePrompt(feature, "more detail");
    expect(prompt).toContain("ASSISTANT: Question?");
    // The persisted assistant state block must be stripped from the transcript
    // (the literal tag still appears in the embedded system-prompt instructions).
    expect(prompt).not.toContain('{"phase":"collecting"}');
    expect(prompt).toContain("id: story-1");
    expect(prompt).toContain("more detail");
  });

  test("createFeaturePlannerResumePrompt omits the existing-stories section when there are none", () => {
    const feature = makeFeature({ stories: [] });
    const prompt = createFeaturePlannerResumePrompt(feature, "hi");
    expect(prompt).not.toContain("Existing stories");
  });

  test("createStoryRefinementPrompt includes the story details and round-trips the story id", () => {
    const prompt = createStoryRefinementPrompt(makeStory({ id: "story-9" }), "make it shorter");
    expect(prompt).toContain("Save a filtered view");
    expect(prompt).toContain("Saved filters can be named");
    expect(prompt).toContain('"storyId":"story-9"');
    expect(prompt).toContain("make it shorter");
  });
});

describe("selectFeaturePlannerPrompt", () => {
  test("sends only the raw message when continuing the same session", () => {
    const feature = makeFeature();
    const prompt = selectFeaturePlannerPrompt({
      feature,
      userMessage: "next answer",
      previousSessionId: "session-1",
      sessionId: "session-1",
    });
    expect(prompt).toBe("next answer");
  });

  test("uses the initial prompt for the first user message on a new session", () => {
    const feature = makeFeature({
      messages: [
        { id: "m1", role: "assistant", content: "Tell me about the new feature", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "m2", role: "user", content: "first", createdAt: "2026-01-01T00:00:01.000Z" },
      ],
    });
    const prompt = selectFeaturePlannerPrompt({
      feature,
      userMessage: "first",
      previousSessionId: undefined,
      sessionId: "session-new",
    });
    expect(prompt).toContain(FEATURE_PLANNER_SYSTEM_PROMPT);
    expect(prompt).toContain("The user has started describing a new feature");
  });

  test("uses the resume prompt when the session changed mid-conversation", () => {
    const feature = makeFeature({
      messages: [
        { id: "m1", role: "assistant", content: "q1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "m2", role: "user", content: "a1", createdAt: "2026-01-01T00:00:01.000Z" },
        { id: "m3", role: "user", content: "a2", createdAt: "2026-01-01T00:00:02.000Z" },
      ],
    });
    const prompt = selectFeaturePlannerPrompt({
      feature,
      userMessage: "a3",
      previousSessionId: "old-session",
      sessionId: "new-session",
    });
    expect(prompt).toContain("This is a resumed planning session");
  });
});

describe("formatFeatureStoriesForBuild", () => {
  test("formats title, summary, stories, and aggregated acceptance criteria", () => {
    const feature = makeFeature({
      title: "Saved views",
      summary: "Users can save filters.",
      stories: [
        makeStory({ id: "s1", title: "Save view", description: "desc one", acceptanceCriteria: ["can name", "can reopen"] }),
        makeStory({ id: "s2", title: "Delete view", description: "desc two", acceptanceCriteria: ["can delete"] }),
      ],
    });
    const result = formatFeatureStoriesForBuild(feature);
    expect(result.title).toBe("Saved views");
    expect(result.description).toContain("Feature summary:\nUsers can save filters.");
    expect(result.description).toContain("1. Save view");
    expect(result.description).toContain("2. Delete view");
    expect(result.acceptanceCriteria).toContain("- Save view: can name");
    expect(result.acceptanceCriteria).toContain("- Delete view: can delete");
  });

  test("falls back to a default title and omits the summary when empty", () => {
    const feature = makeFeature({ title: "   ", summary: "", stories: [] });
    const result = formatFeatureStoriesForBuild(feature);
    expect(result.title).toBe("Feature plan");
    expect(result.description).not.toContain("Feature summary:");
    expect(result.acceptanceCriteria).toBe("");
  });
});

import { describe, expect, mock, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry } = await createCommandFixtures();

import type { CommandContext } from "./command-fixtures";

describe("feature plan commands", () => {
  function featureContext() {
    const storage = {
      kanban: {
        createFeaturePlan: mock(async () => ({ id: "feature-1" })),
        updateFeaturePlan: mock(async () => ({ id: "feature-1" })),
        getFeaturePlans: mock(async () => []),
        appendFeaturePlanMessage: mock(async () => ({ id: "feature-1" })),
        appendFeatureStoryMessage: mock(async () => ({ id: "feature-1" })),
      },
    };
    return { context: { storage } as unknown as CommandContext, storage };
  }

  test("forwards a valid feature plan message role to storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    await commands.get("append_feature_plan_message")?.(
      { featureId: "feature-1", role: "assistant", content: "hello" },
      context,
    );

    expect(storage.kanban.appendFeaturePlanMessage).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      "hello",
      undefined,
      undefined,
    );
  });

  test("validates and forwards feature-plan state application metadata", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    await commands.get("append_feature_plan_message")?.(
      {
        featureId: "feature-1",
        role: "assistant",
        content: "hello",
        stateApplication: "pending",
        modelId: "  gpt-5.3-codex  ",
      },
      context,
    );
    expect(storage.kanban.appendFeaturePlanMessage).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      "hello",
      "pending",
      "gpt-5.3-codex",
    );

    expect(() =>
      commands.get("append_feature_story_message")!(
        {
          featureId: "feature-1",
          storyId: "story-1",
          role: "assistant",
          content: "hello",
          stateApplication: "ignored",
        },
        context,
      ),
    ).toThrow(/stateApplication/i);
    expect(storage.kanban.appendFeatureStoryMessage).not.toHaveBeenCalled();
  });

  test("rejects malformed feature-plan model attribution", () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_plan_message")!(
        {
          featureId: "feature-1",
          role: "assistant",
          content: "hello",
          modelId: "   ",
        },
        context,
      ),
    ).toThrow(/modelId/i);
    expect(storage.kanban.appendFeaturePlanMessage).not.toHaveBeenCalled();
  });

  test("rejects an invalid feature plan message role before touching storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_plan_message")!(
        { featureId: "feature-1", role: "robot", content: "hello" },
        context,
      ),
    ).toThrow(/role/i);
    expect(storage.kanban.appendFeaturePlanMessage).not.toHaveBeenCalled();
  });

  test("rejects an invalid story message role before touching storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_story_message")!(
        { featureId: "feature-1", storyId: "story-1", role: "", content: "hello" },
        context,
      ),
    ).toThrow(/role/i);
    expect(storage.kanban.appendFeatureStoryMessage).not.toHaveBeenCalled();
  });
});

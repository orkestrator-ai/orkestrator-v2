import { describe, expect, test } from "bun:test";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { multiReviewDefaultRows } from "./coordinator-launch-defaults.js";

const catalog: AgentModel[] = [
  {
    platform: "codex",
    id: "gpt-5.6-codex",
    label: "GPT-5.6 Codex",
    reasoning: [{ id: "high", label: "High" }],
    supportsSpeed: true,
  },
  {
    platform: "claude",
    id: "sonnet",
    label: "Sonnet",
    aliases: ["claude-sonnet-5"],
    reasoning: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  },
  {
    platform: "claude",
    id: "opus",
    label: "Opus",
    reasoning: [
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra high" },
    ],
  },
];

function rows(global: AgentSettingsTier, enabledAgentPlatforms: unknown = ["claude", "codex"]) {
  return multiReviewDefaultRows({ tiers: { global }, global, enabledAgentPlatforms }, catalog);
}

describe("multiReviewDefaultRows", () => {
  test("follows the Multi Review button's saved rows", () => {
    const resolved = rows({
      actionDefaults: {
        review: { platform: "codex", model: "gpt-5.6-codex", reasoningEffort: "high" },
        review2: { platform: "claude" },
        // A disabled platform falls back to Review, as the button does.
        reviewPreparation: { platform: "pi", model: "pi-model" },
        fixReviewIssues: { platform: "claude", model: "opus", reasoningEffort: "xhigh" },
      },
      platforms: { claude: { model: "claude-sonnet-5" } },
      multiReview: { reviewerCount: 3, additionalReviewers: [null] },
    });
    const review = { agent: "codex", model: "gpt-5.6-codex", reasoningEffort: "high" } as const;
    expect(resolved).toEqual({
      // Reviewer 2 takes Claude's own platform model, matched through its alias.
      reviewers: [review, { agent: "claude", model: "sonnet" }, review],
      reviewModel: review,
      fixModel: { agent: "claude", model: "opus", reasoningEffort: "xhigh" },
    });
  });

  test("keeps only an effort and speed the chosen model offers", () => {
    const resolved = rows({
      actionDefaults: {
        review: { platform: "claude", model: "sonnet", reasoningEffort: "xhigh", fastMode: true },
      },
    });
    expect(resolved.reviewers[0]).toEqual({ agent: "claude", model: "sonnet" });
  });

  test("replaces a stale saved model with the first connected catalogue model", () => {
    const resolved = rows({
      actionDefaults: { review: { platform: "claude", model: "retired-model" } },
    });
    expect(resolved.fixModel).toEqual({ agent: "claude", model: "sonnet" });
  });

  test("keeps a saved model when the platform has no catalogue to check it against", () => {
    const resolved = rows(
      {
        actionDefaults: { review: { platform: "pi", model: "pi-model", reasoningEffort: "high" } },
      },
      ["pi"],
    );
    expect(resolved.reviewers).toEqual([
      { agent: "pi", model: "pi-model", reasoningEffort: "high" },
      { agent: "pi", model: "pi-model", reasoningEffort: "high" },
    ]);
  });

  test("falls back to the default agent and its own default model when nothing is saved", () => {
    const resolved = rows({}, ["codex"]);
    expect(resolved).toEqual({
      reviewers: [
        { agent: "codex", model: "gpt-5.6-codex" },
        { agent: "codex", model: "gpt-5.6-codex" },
      ],
      reviewModel: { agent: "codex", model: "gpt-5.6-codex" },
      fixModel: { agent: "codex", model: "gpt-5.6-codex" },
    });
  });
});

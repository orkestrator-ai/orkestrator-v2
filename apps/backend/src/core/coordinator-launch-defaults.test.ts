import { launchSelectionReport, platformLaunchDefault } from "./control-shared-actions.js";
import { normalizeReviewers } from "./build-pipeline-service-helpers.js";
import type { BuildStepConfig } from "@orkestrator/protocol/build-pipeline";
import type { CommandContext } from "./commands-context.js";
import { describe, expect, test } from "bun:test";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  buildPipelineInputWithDefaults,
  multiReviewAutomation,
  multiReviewInputWithDefaults,
  readLaunchModelCatalog,
  multiReviewDefaultRows,
} from "./coordinator-launch-defaults.js";

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

  describe("a Pi row with no saved model (0172)", () => {
    // The live failure: a ChatGPT-backed Pi login whose first catalogue model
    // is one the login refuses, while Pi's own saved default (what a tab with
    // no model starts on, marked by the bridge) works.
    const piCatalog: AgentModel[] = [
      { platform: "pi", id: "openai/gpt-4", label: "GPT-4" },
      {
        platform: "pi",
        id: "openai/gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        reasoning: [{ id: "high", label: "High" }],
        sessionDefault: true,
      },
      { platform: "pi", id: "openai/gpt-5.5", label: "GPT-5.5" },
    ];
    const piRows = (global: AgentSettingsTier, models = piCatalog) =>
      multiReviewDefaultRows({ tiers: { global }, global, enabledAgentPlatforms: ["pi"] }, models);

    test("resolves every row to the model a Pi tab would start on", () => {
      const resolved = piRows({ actionDefaults: { review: { platform: "pi" } } });
      const row = { agent: "pi", model: "openai/gpt-6.1-sol" } as const;
      expect(resolved).toEqual({ reviewers: [row, row], reviewModel: row, fixModel: row });
    });

    test("keeps an effort the session default offers", () => {
      const resolved = piRows({
        actionDefaults: { review: { platform: "pi", reasoningEffort: "high" } },
      });
      expect(resolved.reviewers[0]).toEqual({
        agent: "pi",
        model: "openai/gpt-6.1-sol",
        reasoningEffort: "high",
      });
    });

    test("an action default, a saved platform model and an explicit extra reviewer still win", () => {
      const resolved = piRows({
        actionDefaults: {
          review: { platform: "pi" },
          fixReviewIssues: { platform: "pi", model: "openai/gpt-5.5" },
        },
        platforms: { pi: { model: "openai/gpt-4" } },
        multiReview: {
          reviewerCount: 3,
          additionalReviewers: [{ platform: "pi", model: "openai/gpt-5.5" }],
        },
      });
      expect(resolved.reviewers.map((row) => row.model)).toEqual([
        "openai/gpt-4",
        "openai/gpt-4",
        "openai/gpt-5.5",
      ]);
      expect(resolved.fixModel.model).toBe("openai/gpt-5.5");
    });

    test("a stale saved model also falls back to the session default", () => {
      const resolved = piRows({ actionDefaults: { review: { platform: "pi", model: "gone/x" } } });
      expect(resolved.reviewModel).toEqual({ agent: "pi", model: "openai/gpt-6.1-sol" });
    });

    test("a disconnected session default leaves the model to the session", () => {
      const resolved = piRows(
        { actionDefaults: { review: { platform: "pi" } } },
        piCatalog.map((model) => (model.sessionDefault ? { ...model, connected: false } : model)),
      );
      expect(resolved.reviewModel).toEqual({ agent: "pi", model: "default" });
    });

    test("an unmarked catalogue (a pre-upgrade cache) never pins the first model", () => {
      // The review's P1: a cache written before the mark existed would
      // otherwise pin the refused `openai/gpt-4`. `default` lets the session
      // start on Pi's saved default, or on the first model when there is none.
      const unmarked = piCatalog.map(({ sessionDefault: _unused, ...model }) => model);
      const resolved = piRows(
        {
          actionDefaults: {
            review: { platform: "pi", reasoningEffort: "high" },
            fixReviewIssues: { platform: "pi", model: "gone/x" },
          },
        },
        unmarked,
      );
      expect(resolved.reviewModel).toEqual({
        agent: "pi",
        model: "default",
        reasoningEffort: "high",
      });
      expect(resolved.fixModel).toEqual({ agent: "pi", model: "default" });
      // A saved model the catalogue offers still wins.
      expect(
        piRows(
          { actionDefaults: { review: { platform: "pi", model: "openai/gpt-5.5" } } },
          unmarked,
        ).reviewModel,
      ).toEqual({ agent: "pi", model: "openai/gpt-5.5" });
    });
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

describe("coordinator launch overrides", () => {
  const global: AgentSettingsTier = {
    actionDefaults: {
      review: { platform: "claude", model: "opus" },
      review2: { platform: "codex", model: "saved-second" },
      reviewPreparation: { platform: "claude", model: "saved-preparation" },
    },
    multiReview: { reviewerCount: 2, autoFix: true, autoPr: true },
  };
  const settings = { tiers: { global }, global, enabledAgentPlatforms: ["claude", "codex"] };
  test("single reviewer survives pipeline normalization without inherited preparation", () => {
    const reviewer = { agent: "codex", model: "override" } as const;
    const resolved = buildPipelineInputWithDefaults({ reviewers: [reviewer] }, settings);
    expect(normalizeReviewers(resolved.reviewers as BuildStepConfig[])).toBeUndefined();
    expect(resolved.steps).toMatchObject({ review: reviewer });
    expect(resolved.reviewPreparation).toBeUndefined();
  });
  test("fanout aligns its review step and preserves explicit preparation", () => {
    const reviewers = [
      { agent: "codex", model: "first" },
      { agent: "claude", model: "second" },
      { agent: "claude", model: "third" },
    ] as BuildStepConfig[];
    const reviewPreparation = { agent: "codex", model: "explicit-preparation" };
    const resolved = buildPipelineInputWithDefaults({ reviewers, reviewPreparation }, settings);
    expect(normalizeReviewers(resolved.reviewers as BuildStepConfig[])).toEqual(reviewers);
    expect(resolved.steps).toMatchObject({ review: reviewers[0] });
    expect(resolved.reviewPreparation).toEqual(reviewPreparation);
    expect(
      buildPipelineInputWithDefaults({ reviewers: [reviewers[0]], reviewPreparation }, settings)
        .reviewPreparation,
    ).toEqual(reviewPreparation);
  });
  test("step overlays preserve other defaults and an explicit pipeline agent", () => {
    const review = { agent: "codex", model: "step-override" } as const;
    const resolved = buildPipelineInputWithDefaults(
      { agentType: "claude", steps: { review } },
      settings,
    );
    expect(resolved.agentType).toBe("claude");
    expect(resolved.steps).toMatchObject({ review });
    expect((resolved.reviewers as BuildStepConfig[])[0]).toEqual(review);
    expect((resolved.reviewers as BuildStepConfig[])[1]?.model).toBe("saved-second");
  });
  test("partial Multi Review overrides preserve explicit rows and false auto-actions", async () => {
    const fixModel = { agent: "codex", model: "explicit-fix" };
    const reviewers = [{ agent: "claude", model: "explicit-review" }];
    const resolved = await multiReviewInputWithDefaults(
      { reviewers, fixModel, autoFix: false, autoPr: false },
      settings,
      async () => catalog,
    );
    expect(resolved).toMatchObject({ reviewers, fixModel });
    // The stale preparation preference falls back to the first offered Claude model.
    expect(resolved.reviewModel).toEqual({ agent: "claude", model: "sonnet" });
    expect(resolved.autoFix).toBe(false);
    expect(resolved.autoPr).toBe(false);
    const saved = await multiReviewInputWithDefaults(
      { reviewModel: fixModel },
      settings,
      async () => [],
    );
    expect(saved).toMatchObject({ reviewModel: fixModel, autoFix: true, autoPr: true });
  });
  test("auto-fix and auto-PR follow the saved settings unless requested", () => {
    const cases: Array<
      [
        { autoFix?: boolean; autoPr?: boolean },
        { autoFix?: boolean; autoPr?: boolean } | undefined,
        { autoFix: boolean; autoPr: boolean },
      ]
    > = [
      [{}, undefined, { autoFix: false, autoPr: false }],
      [{}, { autoFix: true, autoPr: true }, { autoFix: true, autoPr: true }],
      // Saved Auto-PR alone keeps the button's meaning: a PR after a Fix the user starts.
      [{}, { autoPr: true }, { autoFix: false, autoPr: true }],
      [
        { autoFix: false, autoPr: false },
        { autoFix: true, autoPr: true },
        { autoFix: false, autoPr: false },
      ],
      // A requested auto-PR asks for the whole flow, so an omitted auto-fix turns on.
      [{ autoPr: true }, undefined, { autoFix: true, autoPr: true }],
      [{ autoPr: true }, { autoFix: false }, { autoFix: true, autoPr: true }],
      [{ autoFix: false, autoPr: true }, undefined, { autoFix: false, autoPr: true }],
      [{ autoPr: false }, { autoFix: true, autoPr: true }, { autoFix: true, autoPr: false }],
    ];
    for (const [input, saved, expected] of cases)
      expect(multiReviewAutomation(input, saved)).toEqual(expected);
  });
  test("complete explicit Multi Review rows skip catalogue reads", async () => {
    const row = { agent: "codex", model: "explicit" };
    const input = { reviewers: [row], reviewModel: row, fixModel: row };
    expect(
      await multiReviewInputWithDefaults(input, settings, async () => {
        throw new Error("must not read catalogue");
      }),
    ).toMatchObject(input);
  });
  test("catalogue failure preserves saved rows", async () => {
    const result = await multiReviewInputWithDefaults({}, settings, () =>
      readLaunchModelCatalog(
        async () => {
          throw new Error("offline");
        },
        "env",
        {} as CommandContext,
      ),
    );
    expect(result.reviewers).toMatchObject([{ model: "opus" }, { model: "saved-second" }]);
    expect(await readLaunchModelCatalog(undefined, "env", {} as CommandContext)).toEqual([]);
  });
  test("known disconnected models fall back while absent catalogues preserve saved ids", () => {
    const global: AgentSettingsTier = {
      actionDefaults: {
        review: { platform: "opencode", model: "offline", reasoningEffort: "high" },
      },
    };
    const settings = { tiers: { global }, global, enabledAgentPlatforms: ["opencode"] };
    expect(
      multiReviewDefaultRows(settings, [
        { platform: "opencode", id: "offline", label: "Offline", connected: false },
      ]).reviewers[0],
    ).toEqual({ agent: "opencode", model: "default" });
    expect(multiReviewDefaultRows(settings, []).reviewers[0]).toEqual({
      agent: "opencode",
      model: "offline",
      reasoningEffort: "high",
    });
  });
  test.each(["claude-sonnet-5-5", "claude-sonnet-5"])(
    "matches resolved or superseded Claude preference %s",
    (model) => {
      const global: AgentSettingsTier = {
        actionDefaults: { review: { platform: "claude", model } },
      };
      const settings = { tiers: { global }, global, enabledAgentPlatforms: ["claude"] };
      expect(
        multiReviewDefaultRows(settings, [
          { platform: "claude", id: "opus", label: "Opus" },
          { platform: "claude", id: "sonnet", label: "Sonnet" },
        ]).reviewers[0]?.model,
      ).toBe("sonnet");
    },
  );
});

describe("launch selection catalogue matching", () => {
  test("Claude without a saved model reports its default catalogue entry", () => {
    expect(
      platformLaunchDefault({}, "claude", [
        { platform: "claude", id: "default", label: "Default", defaultReasoningId: "high" },
      ]),
    ).toEqual({ modelId: "default", reasoningId: "high" });
    expect(platformLaunchDefault({}, "claude", [])).toEqual({ modelId: null, reasoningId: null });
  });
  test.each(["claude-sonnet-5-5", "claude-sonnet-5"])(
    "selection reports match resolved or superseded ids: %s",
    (model) => {
      expect(
        launchSelectionReport(
          { global: { platforms: { claude: { model } } } },
          [
            { platform: "claude", id: "opus", label: "Opus" },
            { platform: "claude", id: "sonnet", label: "Sonnet", defaultReasoningId: "high" },
          ],
          { agent: "claude" },
        ),
      ).toEqual({ agent: "claude", model: "sonnet", reasoning: "high", source: "default" });
    },
  );
  test("a live resolved id and aliases take precedence over fallback matches", () => {
    const global: AgentSettingsTier = {
      actionDefaults: { review: { platform: "claude", model: "custom-live-id" } },
    };
    const offered: AgentModel[] = [
      { platform: "claude", id: "first", label: "First" },
      { platform: "claude", id: "live", label: "Live", resolvedModel: "custom-live-id" },
    ];
    expect(
      multiReviewDefaultRows(
        { tiers: { global }, global, enabledAgentPlatforms: ["claude"] },
        offered,
      ).reviewers[0]?.model,
    ).toBe("live");
  });
});

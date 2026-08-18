import { describe, expect, test } from "bun:test";
import {
  boundRawResponse,
  createFeaturePlannerInitialPrompt,
  createFeaturePlannerResumePrompt,
  createStoryCardsFromParsedState,
  createStoryRefinementPrompt,
  FEATURE_PLANNING_ACTIVE_PHASES,
  FEATURE_PLANNING_FAILURE_CODES,
  FEATURE_PLANNING_LIMITS,
  FEATURE_PLANNING_PHASES,
  FEATURE_PLANNING_RECORD_VERSION,
  formatFeatureStoriesForBuild,
  isActiveFeaturePlanningPhase,
  isFeaturePlanningPhase,
  isFeaturePlanningRecord,
  isStartFeaturePlanningInput,
  isTerminalFeaturePlanningPhase,
  parseFeaturePlannerState,
  parseStoryRefinement,
  selectFeaturePlannerPrompt,
  stripFeaturePlannerStateBlocks,
  stripStoryRefinementStateBlocks,
  type FeaturePlannerFeature,
  type FeaturePlannerStory,
  type FeaturePlanningRecord,
} from "./feature-planning.js";

const AT = "2026-08-04T12:34:56.789Z";

function story(overrides: Partial<FeaturePlannerStory> = {}): FeaturePlannerStory {
  return {
    id: "story-1",
    title: "Existing story",
    description: "Existing description",
    acceptanceCriteria: ["Existing criterion"],
    messages: [
      {
        id: "message-1",
        role: "assistant",
        content: 'Earlier answer\n<story_refinement>{"title":"old"}</story_refinement>',
        createdAt: AT,
      },
    ],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function feature(overrides: Partial<FeaturePlannerFeature> = {}): FeaturePlannerFeature {
  return {
    id: "feature-1",
    title: "Feature title",
    summary: "Feature summary",
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "First message",
        createdAt: AT,
      },
    ],
    stories: [story()],
    ...overrides,
  };
}

function record(overrides: Partial<FeaturePlanningRecord> = {}): FeaturePlanningRecord {
  return {
    version: FEATURE_PLANNING_RECORD_VERSION,
    operationId: "operation-1",
    featureId: "feature-1",
    projectId: "project-1",
    kind: "feature",
    userMessage: "Please plan this feature",
    phase: "dispatching",
    startedAt: AT,
    updatedAt: AT,
    backendRevision: 0,
    ...overrides,
  };
}

describe("feature-planning prompts", () => {
  test("builds initial and resumed prompts without replaying machine state blocks", () => {
    expect(createFeaturePlannerInitialPrompt("Make uploads retryable")).toContain(
      "User message:\nMake uploads retryable",
    );

    const resumed = createFeaturePlannerResumePrompt(
      feature({
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Make uploads retryable",
            createdAt: AT,
          },
          {
            id: "assistant-1",
            role: "assistant",
            content:
              'Which failures?\n<feature_planner_state>{"phase":"collecting"}</feature_planner_state>',
            createdAt: AT,
          },
        ],
      }),
      "Only network failures",
    );
    expect(resumed).toContain("ASSISTANT: Which failures?");
    expect(resumed).not.toContain("ASSISTANT: Which failures?\n<feature_planner_state>");
    expect(resumed).toContain("id: story-1 | title: Existing story");
    expect(resumed).toContain("Latest user message:\nOnly network failures");
  });

  test("selects raw, initial, and resumed prompts from session continuity", () => {
    const base = feature();
    expect(
      selectFeaturePlannerPrompt({
        feature: base,
        userMessage: "continue",
        previousSessionId: "session-1",
        sessionId: "session-1",
      }),
    ).toBe("continue");
    expect(
      selectFeaturePlannerPrompt({
        feature: base,
        userMessage: "start",
        previousSessionId: null,
        sessionId: "session-1",
      }),
    ).toContain("The user has started describing a new feature");
    expect(
      selectFeaturePlannerPrompt({
        feature: feature({
          messages: [
            ...base.messages,
            { id: "user-2", role: "user", content: "Again", createdAt: AT },
          ],
        }),
        userMessage: "resume",
        previousSessionId: "old-session",
        sessionId: "new-session",
      }),
    ).toContain("This is a resumed planning session");
  });

  test("builds refinement prompts with current state and a clean transcript", () => {
    const prompt = createStoryRefinementPrompt(story(), "Rename it");
    expect(prompt).toContain("Title: Existing story");
    expect(prompt).toContain("- Existing criterion");
    expect(prompt).toContain("ASSISTANT: Earlier answer");
    expect(prompt).not.toContain("ASSISTANT: Earlier answer\n<story_refinement>");
    expect(prompt).toContain('"storyId":"story-1"');
    expect(prompt).toContain("User message:\nRename it");
  });
});

describe("state block parsing", () => {
  test("parses a valid feature state block and all story fields", () => {
    expect(
      parseFeaturePlannerState(`Answer
      <FEATURE_PLANNER_STATE>
      {"phase":"stories","title":"Uploads","summary":"Retry failures","stories":[{"id":"story-1","title":"Retry","description":"Try again","acceptanceCriteria":["Keeps the file"]}]}
      </FEATURE_PLANNER_STATE>`),
    ).toEqual({
      phase: "stories",
      title: "Uploads",
      summary: "Retry failures",
      stories: [
        {
          id: "story-1",
          title: "Retry",
          description: "Try again",
          acceptanceCriteria: ["Keeps the file"],
        },
      ],
    });
  });

  test("rejects absent, malformed, non-object, and unsupported feature states", () => {
    const invalid = [
      "no block",
      "<feature_planner_state>{</feature_planner_state>",
      "<feature_planner_state>null</feature_planner_state>",
      "<feature_planner_state>[]</feature_planner_state>",
      '<feature_planner_state>{"phase":"unknown"}</feature_planner_state>',
      '<feature_planner_state>{"title":1}</feature_planner_state>',
      '<feature_planner_state>{"summary":false}</feature_planner_state>',
      '<feature_planner_state>{"phase":"stories"}</feature_planner_state>',
      '<feature_planner_state>{"stories":{}}</feature_planner_state>',
      '<feature_planner_state>{"stories":[null]}</feature_planner_state>',
      '<feature_planner_state>{"stories":[[]]}</feature_planner_state>',
      '<feature_planner_state>{"stories":[{"id":1,"title":"t","description":"d","acceptanceCriteria":[]}]}</feature_planner_state>',
      '<feature_planner_state>{"stories":[{"title":1,"description":"d","acceptanceCriteria":[]}]}</feature_planner_state>',
      '<feature_planner_state>{"stories":[{"title":"t","description":1,"acceptanceCriteria":[]}]}</feature_planner_state>',
      '<feature_planner_state>{"stories":[{"title":"t","description":"d","acceptanceCriteria":[1]}]}</feature_planner_state>',
      '<feature_planner_state>{"phase":"collecting"}</feature_planner_state>trailing prose',
      '<feature_planner_state>{"phase":"collecting"}</feature_planner_state><feature_planner_state>{"phase":"confirming"}</feature_planner_state>',
    ];
    for (const content of invalid) expect(parseFeaturePlannerState(content)).toBeNull();
  });

  test("parses partial story refinements and rejects malformed fields", () => {
    expect(
      parseStoryRefinement(
        'Done\n<story_refinement>{"storyId":"story-1","title":"New","description":"Updated","acceptanceCriteria":["One"]}</story_refinement>',
      ),
    ).toEqual({
      storyId: "story-1",
      title: "New",
      description: "Updated",
      acceptanceCriteria: ["One"],
    });
    expect(
      parseStoryRefinement(
        '<story_refinement>{"description":"Only this changed"}</story_refinement>',
      ),
    ).toEqual({ description: "Only this changed" });

    const invalid = [
      "no block",
      "<story_refinement>{</story_refinement>",
      "<story_refinement>null</story_refinement>",
      "<story_refinement>[]</story_refinement>",
      '<story_refinement>{"storyId":1}</story_refinement>',
      '<story_refinement>{"title":1}</story_refinement>',
      '<story_refinement>{"description":1}</story_refinement>',
      '<story_refinement>{"acceptanceCriteria":{}}</story_refinement>',
      '<story_refinement>{"acceptanceCriteria":[null]}</story_refinement>',
      '<story_refinement>{"title":"first"}</story_refinement>trailing prose',
      '<story_refinement>{"title":"first"}</story_refinement><story_refinement>{"title":"second"}</story_refinement>',
    ];
    for (const content of invalid) expect(parseStoryRefinement(content)).toBeNull();
  });

  test("strips machine blocks while retaining conversational text", () => {
    expect(
      stripFeaturePlannerStateBlocks(
        '  Keep this\n<feature_planner_state>{"phase":"collecting"}</feature_planner_state>  ',
      ),
    ).toBe("Keep this");
    expect(
      stripStoryRefinementStateBlocks(
        '  Updated\n<story_refinement>{"title":"New"}</story_refinement>  ',
      ),
    ).toBe("Updated");
    expect(stripFeaturePlannerStateBlocks("ordinary text")).toBe("ordinary text");
    expect(
      stripFeaturePlannerStateBlocks(
        "<feature_planner_state>{}</feature_planner_state>text<feature_planner_state>{}</feature_planner_state>",
      ),
    ).toBe("text");
  });
});

describe("story reconciliation and build formatting", () => {
  test("preserves existing identity and history by id or case-insensitive title", () => {
    let nextId = 0;
    const existing = story();
    const cards = createStoryCardsFromParsedState(
      {
        stories: [
          {
            id: existing.id,
            title: "Renamed",
            description: "By id",
            acceptanceCriteria: ["A"],
          },
          {
            title: "EXISTING STORY",
            description: "By title",
            acceptanceCriteria: ["B"],
          },
          {
            title: "Brand new",
            description: "New card",
            acceptanceCriteria: [],
          },
        ],
      },
      [existing],
      {
        now: "2026-08-05T00:00:00.000Z",
        newStoryId: () => `generated-${++nextId}`,
      },
    );

    expect(cards[0]).toMatchObject({
      id: existing.id,
      title: "Renamed",
      messages: existing.messages,
      createdAt: existing.createdAt,
    });
    expect(cards[1]?.id).toBe(existing.id);
    expect(cards[2]).toMatchObject({
      id: "generated-1",
      messages: [{ id: "generated-2", role: "assistant" }],
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    expect(
      createStoryCardsFromParsedState({}, [existing], {
        now: AT,
        newStoryId: () => "unused",
      }),
    ).toEqual([]);
  });

  test("formats all stories and supplies a blank-title fallback", () => {
    const formatted = formatFeatureStoriesForBuild(feature({ title: "  " }));
    expect(formatted.title).toBe("Feature plan");
    expect(formatted.description).toContain("Feature summary:\nFeature summary");
    expect(formatted.description).toContain("### 1. Existing story");
    expect(formatted.description).toContain("- Existing criterion");
    expect(
      formatFeatureStoriesForBuild(feature({ summary: "", stories: [] })).description,
    ).not.toContain("Feature summary:");
  });
});

describe("planning phases", () => {
  test("recognizes every declared phase and only active/terminal subsets", () => {
    for (const phase of FEATURE_PLANNING_PHASES) {
      expect(isFeaturePlanningPhase(phase)).toBe(true);
      expect(isActiveFeaturePlanningPhase(phase)).toBe(
        FEATURE_PLANNING_ACTIVE_PHASES.includes(phase as never),
      );
      expect(isTerminalFeaturePlanningPhase(phase)).toBe(
        phase === "complete" || phase === "failed",
      );
    }
    for (const value of [undefined, null, "", "cancelled", 1, {}]) {
      expect(isFeaturePlanningPhase(value)).toBe(false);
      expect(isActiveFeaturePlanningPhase(value)).toBe(false);
    }
  });
});

describe("isFeaturePlanningRecord", () => {
  test("accepts minimal and fully populated feature and story records", () => {
    expect(isFeaturePlanningRecord(record())).toBe(true);
    expect(
      isFeaturePlanningRecord(
        record({
          kind: "story",
          storyId: "story-1",
          userMessageId: "user-message-1",
          environmentId: "environment-1",
          providerSessionId: "session-1",
          dispatchId: "dispatch-1",
          requestId: "request-1",
          dispatchState: "sent",
          baselineAssistantIds: ["assistant-1", "assistant-2"],
          phase: "failed",
          rawResponse: "raw",
          responseModelId: "model-1",
          responseMessageId: "assistant-3",
          failure: {
            code: "provider",
            message: "Provider disconnected",
            occurredAt: AT,
            retryPhase: "running",
          },
          attemptStartedAt: AT,
          dispatchedAt: AT,
          backendRevision: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toBe(true);
  });

  test("rejects non-records, wrong versions, invalid ids, and kind/story mismatches", () => {
    for (const value of [null, undefined, [], "record", 1]) {
      expect(isFeaturePlanningRecord(value)).toBe(false);
    }
    expect(isFeaturePlanningRecord(record({ version: 2 as 1 }))).toBe(false);
    for (const key of ["operationId", "featureId", "projectId"] as const) {
      expect(isFeaturePlanningRecord({ ...record(), [key]: 1 })).toBe(false);
      expect(isFeaturePlanningRecord({ ...record(), [key]: "" })).toBe(false);
      expect(
        isFeaturePlanningRecord({
          ...record(),
          [key]: "x".repeat(FEATURE_PLANNING_LIMITS.maxIdLength + 1),
        }),
      ).toBe(false);
    }
    expect(isFeaturePlanningRecord({ ...record(), kind: "other" })).toBe(false);
    expect(isFeaturePlanningRecord(record({ kind: "story", storyId: undefined }))).toBe(false);
    expect(isFeaturePlanningRecord(record({ kind: "story", storyId: "" }))).toBe(false);
    expect(isFeaturePlanningRecord(record({ kind: "story", storyId: 1 as never }))).toBe(false);
    expect(isFeaturePlanningRecord(record({ storyId: "story-1" }))).toBe(false);
  });

  test("enforces user, optional id, raw response, and dispatch-state bounds", () => {
    expect(
      isFeaturePlanningRecord(
        record({
          userMessage: "x".repeat(FEATURE_PLANNING_LIMITS.maxUserMessageLength),
          rawResponse: "x".repeat(FEATURE_PLANNING_LIMITS.maxRawResponseLength),
        }),
      ),
    ).toBe(true);
    expect(
      isFeaturePlanningRecord(
        record({
          userMessage: "x".repeat(FEATURE_PLANNING_LIMITS.maxUserMessageLength + 1),
        }),
      ),
    ).toBe(false);
    expect(
      isFeaturePlanningRecord(
        record({
          rawResponse: "x".repeat(FEATURE_PLANNING_LIMITS.maxRawResponseLength + 1),
        }),
      ),
    ).toBe(false);

    const optionalIds = [
      "userMessageId",
      "environmentId",
      "providerSessionId",
      "dispatchId",
      "requestId",
      "responseMessageId",
      "responseModelId",
    ] as const;
    for (const key of optionalIds) {
      expect(isFeaturePlanningRecord({ ...record(), [key]: 1 })).toBe(false);
      expect(isFeaturePlanningRecord({ ...record(), [key]: "" })).toBe(false);
      expect(
        isFeaturePlanningRecord({
          ...record(),
          [key]: "x".repeat(FEATURE_PLANNING_LIMITS.maxIdLength + 1),
        }),
      ).toBe(false);
    }
    expect(isFeaturePlanningRecord({ ...record(), dispatchState: "queued" })).toBe(false);
  });

  test("enforces assistant-baseline count and id bounds", () => {
    const maximum = Array.from(
      { length: FEATURE_PLANNING_LIMITS.maxBaselineAssistantIds },
      (_, index) => `assistant-${index}`,
    );
    expect(isFeaturePlanningRecord(record({ baselineAssistantIds: maximum }))).toBe(true);
    expect(
      isFeaturePlanningRecord(
        record({
          baselineAssistantIds: [...maximum, "one-too-many"],
        }),
      ),
    ).toBe(false);
    expect(isFeaturePlanningRecord({ ...record(), baselineAssistantIds: {} })).toBe(false);
    expect(isFeaturePlanningRecord(record({ baselineAssistantIds: [1 as never] }))).toBe(false);
    expect(isFeaturePlanningRecord(record({ baselineAssistantIds: [""] }))).toBe(false);
    expect(
      isFeaturePlanningRecord(
        record({
          baselineAssistantIds: ["x".repeat(FEATURE_PLANNING_LIMITS.maxIdLength + 1)],
        }),
      ),
    ).toBe(false);
  });

  test("validates every failure field and boundary", () => {
    const validFailure = {
      code: FEATURE_PLANNING_FAILURE_CODES[0],
      message: "x".repeat(FEATURE_PLANNING_LIMITS.maxFailureMessageLength),
      occurredAt: AT,
      retryPhase: FEATURE_PLANNING_ACTIVE_PHASES[0],
    };
    for (const code of FEATURE_PLANNING_FAILURE_CODES) {
      for (const retryPhase of FEATURE_PLANNING_ACTIVE_PHASES) {
        expect(
          isFeaturePlanningRecord(
            record({
              phase: "failed",
              failure: { ...validFailure, code, retryPhase },
            }),
          ),
        ).toBe(true);
      }
    }
    for (const failure of [
      null,
      [],
      { ...validFailure, code: "unknown" },
      {
        ...validFailure,
        message: "x".repeat(FEATURE_PLANNING_LIMITS.maxFailureMessageLength + 1),
      },
      { ...validFailure, occurredAt: "not-a-date" },
      { ...validFailure, retryPhase: "failed" },
    ]) {
      expect(isFeaturePlanningRecord({ ...record(), failure })).toBe(false);
    }
  });

  test("requires bounded ISO timestamps including optional attempt clocks", () => {
    expect(
      isFeaturePlanningRecord(
        record({
          startedAt: "2026-08-04T13:34:56.789+01:00",
          updatedAt: "2026-08-04T13:34:56.789+01:00",
          attemptStartedAt: "2026-08-04T13:34:56+01:00",
          dispatchedAt: AT,
        }),
      ),
    ).toBe(true);
    for (const key of ["startedAt", "updatedAt", "attemptStartedAt", "dispatchedAt"] as const) {
      expect(isFeaturePlanningRecord({ ...record(), [key]: "not-a-date" })).toBe(false);
      expect(
        isFeaturePlanningRecord({
          ...record(),
          [key]: `2026-08-04T${"0".repeat(FEATURE_PLANNING_LIMITS.maxTimestampLength)}Z`,
        }),
      ).toBe(false);
    }
  });

  test("requires a non-negative safe integer revision and a known phase", () => {
    for (const backendRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, "1"]) {
      expect(isFeaturePlanningRecord({ ...record(), backendRevision })).toBe(false);
    }
    expect(isFeaturePlanningRecord({ ...record(), phase: "cancelled" })).toBe(false);
  });
});

describe("isStartFeaturePlanningInput", () => {
  test("accepts feature and story inputs at the message boundary", () => {
    expect(
      isStartFeaturePlanningInput({
        featureId: "feature-1",
        kind: "feature",
        userMessage: "Plan this",
      }),
    ).toBe(true);
    expect(
      isStartFeaturePlanningInput({
        featureId: "feature-1",
        kind: "story",
        storyId: "story-1",
        userMessage: "x".repeat(FEATURE_PLANNING_LIMITS.maxUserMessageLength),
      }),
    ).toBe(true);
  });

  test("rejects malformed, blank, oversized, and kind-inconsistent inputs", () => {
    const invalid = [
      null,
      [],
      {},
      { featureId: "", kind: "feature", userMessage: "x" },
      { featureId: 1, kind: "feature", userMessage: "x" },
      {
        featureId: "x".repeat(FEATURE_PLANNING_LIMITS.maxIdLength + 1),
        kind: "feature",
        userMessage: "x",
      },
      { featureId: "f", kind: "other", userMessage: "x" },
      { featureId: "f", kind: "feature", storyId: "s", userMessage: "x" },
      { featureId: "f", kind: "story", userMessage: "x" },
      { featureId: "f", kind: "story", storyId: "", userMessage: "x" },
      { featureId: "f", kind: "story", storyId: 1, userMessage: "x" },
      { featureId: "f", kind: "feature", userMessage: " \n\t " },
      {
        featureId: "f",
        kind: "feature",
        userMessage: "x".repeat(FEATURE_PLANNING_LIMITS.maxUserMessageLength + 1),
      },
    ];
    for (const input of invalid) expect(isStartFeaturePlanningInput(input)).toBe(false);
  });
});

describe("boundRawResponse", () => {
  const max = FEATURE_PLANNING_LIMITS.maxRawResponseLength;

  test("returns content at or below the boundary unchanged", () => {
    expect(boundRawResponse("short")).toBe("short");
    const exact = "x".repeat(max);
    expect(boundRawResponse(exact)).toBe(exact);
  });

  test("bounds oversized prose and does not split a surrogate pair", () => {
    const oversized = `${"x".repeat(max - 2)}😀tail`;
    const bounded = boundRawResponse(oversized);
    expect(bounded.length).toBeLessThanOrEqual(max);
    expect(bounded.endsWith("…")).toBe(true);
    expect(bounded).not.toContain("\ud83d…");
  });

  test("preserves a parseable terminal feature state block", () => {
    const block =
      '<feature_planner_state>{"phase":"confirming","title":"Keep me","summary":"Ready"}</feature_planner_state>';
    const bounded = boundRawResponse(`${"p".repeat(max)}${block}`);
    expect(bounded.length).toBe(max);
    expect(bounded.endsWith(block)).toBe(true);
    expect(parseFeaturePlannerState(bounded)).toMatchObject({
      phase: "confirming",
      title: "Keep me",
    });
  });

  test("preserves a parseable terminal story refinement block and trailing whitespace", () => {
    const block = '<story_refinement>{"storyId":"story-1","title":"Keep me"}</story_refinement>\n';
    const bounded = boundRawResponse(`${"p".repeat(max)}${block}`);
    expect(bounded.length).toBe(max);
    expect(bounded.endsWith(block)).toBe(true);
    expect(parseStoryRefinement(bounded)).toEqual({
      storyId: "story-1",
      title: "Keep me",
    });
  });

  test("falls back to bounded truncation when the state block itself cannot fit", () => {
    const content = `<feature_planner_state>{"summary":"${"x".repeat(max)}"}</feature_planner_state>`;
    const bounded = boundRawResponse(content);
    expect(bounded.length).toBeLessThanOrEqual(max);
    expect(bounded.endsWith("…")).toBe(true);
    expect(parseFeaturePlannerState(bounded)).toBeNull();
  });
});

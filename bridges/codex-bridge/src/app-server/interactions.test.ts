import { describe, expect, test } from "bun:test";
import {
  buildInteractionResponse,
  describeInteraction,
  isInteractionAnswerMap,
  parseInteractionAnswer,
  type InteractionMethod,
  type InteractionRequest,
} from "./interactions.js";

const REQUESTED_AT = 1_000_000;
const DEFAULT_EXPIRES_AT = REQUESTED_AT + 300_000;

function describeWith(
  method: InteractionMethod,
  params: unknown,
  overrides: { requestedAt?: number; defaultExpiresAt?: number } = {},
): InteractionRequest | null {
  return describeInteraction({
    interactionId: "ask-1",
    method,
    params,
    generation: 3,
    requestedAt: overrides.requestedAt ?? REQUESTED_AT,
    defaultExpiresAt: overrides.defaultExpiresAt ?? DEFAULT_EXPIRES_AT,
  });
}

const QUESTION = "item/tool/requestUserInput" as const;
const ELICITATION = "mcpServer/elicitation/request" as const;

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "language",
    header: "Language",
    question: "Which language?",
    ...overrides,
  };
}

describe("describeInteraction: params coercion", () => {
  /**
   * `params` arrives straight off the wire. Anything that is not an object must
   * degrade to "no thread id" rather than throwing on the read-loop path.
   */
  test.each([null, undefined, "a string", 42, ["an", "array"], true])(
    "non-object params (%p) describe as null",
    (params) => {
      expect(describeWith(QUESTION, params)).toBeNull();
      expect(describeWith(ELICITATION, params)).toBeNull();
    },
  );

  test("a missing, empty or non-string threadId describes as null", () => {
    for (const threadId of [undefined, "", 7, null, {}]) {
      expect(describeWith(QUESTION, { threadId, questions: [question()] })).toBeNull();
      expect(describeWith(ELICITATION, { threadId, mode: "form" })).toBeNull();
    }
  });

  test("a non-string turnId or itemId becomes null rather than leaking the raw value", () => {
    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      turnId: 12,
      itemId: { nested: true },
      questions: [question()],
    });
    expect(described?.turnId).toBeNull();
    expect(described?.itemId).toBeNull();
  });

  test("an empty-string turnId is treated as absent", () => {
    expect(
      describeWith(QUESTION, { threadId: "thread-1", turnId: "", questions: [question()] })?.turnId,
    ).toBeNull();
  });
});

describe("describeInteraction: questions", () => {
  test("carries the whole question set with its ids, options and flags", () => {
    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [
        question({
          isOther: true,
          isSecret: true,
          options: [{ label: "TypeScript", description: "Typed JavaScript" }, { label: "Rust" }],
        }),
      ],
    });

    expect(described).toMatchObject({
      interactionId: "ask-1",
      kind: "question",
      method: QUESTION,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      generation: 3,
      requestedAt: REQUESTED_AT,
      expiresAt: DEFAULT_EXPIRES_AT,
    });
    expect(described?.questions).toEqual([
      {
        id: "language",
        header: "Language",
        question: "Which language?",
        isOther: true,
        isSecret: true,
        options: [{ label: "TypeScript", description: "Typed JavaScript" }, { label: "Rust" }],
      },
    ]);
  });

  test("questions that are not an array describe as null", () => {
    for (const questions of [undefined, null, "one question", { id: "a" }, 5]) {
      expect(describeWith(QUESTION, { threadId: "thread-1", questions })).toBeNull();
    }
  });

  test("an empty question list describes as null", () => {
    expect(describeWith(QUESTION, { threadId: "thread-1", questions: [] })).toBeNull();
  });

  test("a set that is empty only after filtering describes as null", () => {
    // Every entry is unusable, so there is nothing a human could answer — and a
    // card with no questions would be an unanswerable prompt.
    expect(
      describeWith(QUESTION, {
        threadId: "thread-1",
        questions: [{ question: "No id" }, { id: "no-prompt" }, "not an object", null],
      }),
    ).toBeNull();
  });

  test("individual unusable questions are dropped, keeping the rest", () => {
    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [{ question: "missing id" }, { id: "missing-question" }, question({ id: "kept" })],
    });
    expect(described?.questions?.map((entry) => entry.id)).toEqual(["kept"]);
  });

  test('header defaults to "Question" when absent or not a non-empty string', () => {
    for (const header of [undefined, "", null, 7, {}]) {
      const described = describeWith(QUESTION, {
        threadId: "thread-1",
        questions: [question({ header })],
      });
      expect(described?.questions?.[0]?.header).toBe("Question");
    }
  });

  test("isOther and isSecret are strictly true, never truthy", () => {
    // A string "true" or a 1 from a loose client must not silently unmask a
    // secret field or enable free-text entry.
    for (const truthy of ["true", 1, {}, [], "yes"]) {
      const described = describeWith(QUESTION, {
        threadId: "thread-1",
        questions: [question({ isOther: truthy, isSecret: truthy })],
      });
      expect(described?.questions?.[0]?.isOther).toBe(false);
      expect(described?.questions?.[0]?.isSecret).toBe(false);
    }

    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [question({ isOther: true, isSecret: true })],
    });
    expect(described?.questions?.[0]?.isOther).toBe(true);
    expect(described?.questions?.[0]?.isSecret).toBe(true);
  });

  test("options without a usable label are dropped, and an all-bad list is omitted", () => {
    const partial = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [
        question({
          options: [{ label: "" }, { description: "no label" }, "nope", { label: "Kept" }],
        }),
      ],
    });
    expect(partial?.questions?.[0]?.options).toEqual([{ label: "Kept" }]);

    const none = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [question({ options: [{ description: "no label" }, 5] })],
    });
    expect(none?.questions?.[0]?.options).toBeUndefined();
  });

  test("a non-array options value is treated as no options", () => {
    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [question({ options: "TypeScript" })],
    });
    expect(described?.questions?.[0]?.options).toBeUndefined();
  });

  test('an empty option description is omitted rather than serialized as ""', () => {
    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [question({ options: [{ label: "Yes", description: "" }] })],
    });
    expect(described?.questions?.[0]?.options).toEqual([{ label: "Yes" }]);
  });
});

describe("describeInteraction: the autoResolutionMs clamp", () => {
  test("a shorter autoResolutionMs wins over the default expiry", () => {
    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [question()],
      autoResolutionMs: 60_000,
    });
    expect(described?.expiresAt).toBe(REQUESTED_AT + 60_000);
    expect(described?.autoResolutionMs).toBe(60_000);
  });

  test("a longer autoResolutionMs never extends past the default expiry", () => {
    // The other direction of the clamp: Codex must not be able to pin a request
    // open for longer than the router's own approval window.
    const described = describeWith(QUESTION, {
      threadId: "thread-1",
      questions: [question()],
      autoResolutionMs: 86_400_000,
    });
    expect(described?.expiresAt).toBe(DEFAULT_EXPIRES_AT);
    expect(described?.autoResolutionMs).toBe(86_400_000);
  });

  test.each([undefined, null, 0, -1, "60000", Number.NaN, {}])(
    "a non-positive or non-numeric autoResolutionMs (%p) falls back to the default expiry",
    (autoResolutionMs) => {
      const described = describeWith(QUESTION, {
        threadId: "thread-1",
        questions: [question()],
        autoResolutionMs,
      });
      expect(described?.expiresAt).toBe(DEFAULT_EXPIRES_AT);
      expect(described?.autoResolutionMs).toBeUndefined();
    },
  );
});

describe("describeInteraction: MCP elicitation", () => {
  test("form mode carries the requested schema", () => {
    const schema = { type: "object", properties: { region: { type: "string" } } };
    const described = describeWith(ELICITATION, {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "deploy",
      mode: "form",
      message: "Choose a region",
      requestedSchema: schema,
    });

    expect(described).toMatchObject({
      kind: "mcp-form",
      method: ELICITATION,
      threadId: "thread-1",
      turnId: "turn-1",
      // Elicitation is not scoped to an item even when it happens during one.
      itemId: null,
      serverName: "deploy",
      message: "Choose a region",
      expiresAt: DEFAULT_EXPIRES_AT,
    });
    expect(described?.schema).toEqual(schema);
    expect(described?.url).toBeUndefined();
  });

  test("openai/form is an alias for form, not a separate kind", () => {
    const described = describeWith(ELICITATION, {
      threadId: "thread-1",
      mode: "openai/form",
      message: "Pick one",
      requestedSchema: { type: "object" },
    });
    expect(described?.kind).toBe("mcp-form");
    expect(described?.schema).toEqual({ type: "object" });
  });

  test("url mode becomes an mcp-url card carrying the link and elicitation id", () => {
    const described = describeWith(ELICITATION, {
      threadId: "thread-1",
      turnId: "turn-2",
      serverName: "linear",
      mode: "url",
      message: "Authorize Orkestrator",
      url: "https://linear.app/oauth/authorize",
      elicitationId: "elicit-7",
      // Present in the params but meaningless for a url card.
      requestedSchema: { type: "object" },
    });

    expect(described).toMatchObject({
      kind: "mcp-url",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: null,
      serverName: "linear",
      message: "Authorize Orkestrator",
      url: "https://linear.app/oauth/authorize",
      elicitationId: "elicit-7",
    });
    // A url card has no form, so it must not carry a schema to render.
    expect(described?.schema).toBeUndefined();
  });

  test("a url card with a missing or non-string url keeps the fields undefined", () => {
    const described = describeWith(ELICITATION, {
      threadId: "thread-1",
      mode: "url",
      url: 42,
      elicitationId: "",
    });
    expect(described?.kind).toBe("mcp-url");
    expect(described?.url).toBeUndefined();
    expect(described?.elicitationId).toBeUndefined();
  });

  test("serverName and message are omitted when they are not non-empty strings", () => {
    const described = describeWith(ELICITATION, {
      threadId: "thread-1",
      mode: "form",
      serverName: "",
      message: 5,
    });
    expect(described?.serverName).toBeUndefined();
    expect(described?.message).toBeUndefined();
  });

  test.each([undefined, null, "", "Form", "openai/Form", "link", 7, {}])(
    "an unrecognised mode (%p) describes as null so the router declines it",
    (mode) => {
      expect(describeWith(ELICITATION, { threadId: "thread-1", mode })).toBeNull();
    },
  );

  test("questions on an elicitation are ignored; mode alone decides", () => {
    expect(describeWith(ELICITATION, { threadId: "thread-1", questions: [question()] })).toBeNull();
  });

  test("elicitation never uses autoResolutionMs", () => {
    const described = describeWith(ELICITATION, {
      threadId: "thread-1",
      mode: "form",
      autoResolutionMs: 1_000,
    });
    expect(described?.expiresAt).toBe(DEFAULT_EXPIRES_AT);
    expect(described?.autoResolutionMs).toBeUndefined();
  });
});

describe("buildInteractionResponse", () => {
  const questionRequest = describeWith(QUESTION, {
    threadId: "thread-1",
    questions: [question(), question({ id: "framework", question: "Which framework?" })],
  })!;
  const formRequest = describeWith(ELICITATION, {
    threadId: "thread-1",
    mode: "form",
    requestedSchema: { type: "object" },
  })!;
  const urlRequest = describeWith(ELICITATION, {
    threadId: "thread-1",
    mode: "url",
    url: "https://example.test/auth",
    elicitationId: "elicit-1",
  })!;

  test("an accepted question set is wrapped in the protocol's per-question shape", () => {
    expect(
      buildInteractionResponse(questionRequest, {
        action: "accept",
        answers: { language: ["TypeScript"], framework: ["Bun", "Hono"] },
      }),
    ).toEqual({
      answers: {
        language: { answers: ["TypeScript"] },
        framework: { answers: ["Bun", "Hono"] },
      },
    });
  });

  test("an accept with no answers is an empty map, not undefined", () => {
    expect(buildInteractionResponse(questionRequest, { action: "accept" })).toEqual({
      answers: {},
    });
  });

  test.each(["decline", "cancel"] as const)(
    "a %s on a question answers with an empty map so the turn is not left waiting",
    (action) => {
      expect(buildInteractionResponse(questionRequest, { action })).toEqual({ answers: {} });
    },
  );

  test("a question decline ignores any answers the client attached", () => {
    // The response shape has no room for a refusal, so the answers must not leak
    // into a decline the user actually made.
    expect(
      buildInteractionResponse(questionRequest, {
        action: "cancel",
        meta: { reason: "closed the tab" },
      }),
    ).toEqual({ answers: {} });
  });

  test.each(["decline", "cancel"] as const)(
    "an MCP %s sends null content and null _meta",
    (action) => {
      for (const request of [formRequest, urlRequest]) {
        expect(buildInteractionResponse(request, { action })).toEqual({
          action,
          content: null,
          _meta: null,
        });
      }
    },
  );

  test("an accepted MCP form passes the structured content through", () => {
    expect(
      buildInteractionResponse(formRequest, {
        action: "accept",
        content: { region: "eu-west-1" },
      }),
    ).toEqual({ action: "accept", content: { region: "eu-west-1" }, _meta: null });
  });

  test("an accepted MCP request with no content sends an empty object, never null", () => {
    // `content: null` is the documented decline shape; an accept must not use it.
    expect(buildInteractionResponse(urlRequest, { action: "accept" })).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
  });

  test("meta is passed through as _meta on every MCP action", () => {
    expect(
      buildInteractionResponse(formRequest, {
        action: "accept",
        content: {},
        meta: { formId: "f-1" },
      }),
    ).toMatchObject({ _meta: { formId: "f-1" } });
    expect(
      buildInteractionResponse(formRequest, { action: "decline", meta: { formId: "f-1" } }),
    ).toMatchObject({ _meta: { formId: "f-1" } });
  });
});

describe("isInteractionAnswerMap", () => {
  test("accepts a map of non-empty string arrays", () => {
    expect(isInteractionAnswerMap({ a: ["one"], b: ["two", "three"] })).toBe(true);
    // No questions answered is still the right *shape*; whether it satisfies the
    // card is the runtime's decision, not this predicate's.
    expect(isInteractionAnswerMap({})).toBe(true);
  });

  test.each([
    null,
    undefined,
    "TypeScript",
    42,
    [["TypeScript"]],
    { a: "TypeScript" },
    { a: [] },
    { a: [""] },
    { a: ["ok", 7] },
    { a: null },
    { a: { answers: ["TypeScript"] } },
  ])("rejects %p", (value) => {
    expect(isInteractionAnswerMap(value)).toBe(false);
  });
});

describe("parseInteractionAnswer", () => {
  test.each(["decline", "cancel"] as const)("parses a bare %s", (action) => {
    expect(parseInteractionAnswer({ action })).toEqual({ action });
  });

  test("carries meta through on a decline", () => {
    expect(parseInteractionAnswer({ action: "decline", meta: { why: "no" } })).toEqual({
      action: "decline",
      meta: { why: "no" },
    });
  });

  test("parses an accept with a well-formed answer map", () => {
    expect(
      parseInteractionAnswer({ action: "accept", answers: { language: ["TypeScript"] } }),
    ).toEqual({ action: "accept", answers: { language: ["TypeScript"] } });
  });

  test("treats an absent or null answers field as no answers", () => {
    expect(parseInteractionAnswer({ action: "accept" })).toEqual({ action: "accept" });
    expect(parseInteractionAnswer({ action: "accept", answers: null })).toEqual({
      action: "accept",
    });
  });

  test("rejects a malformed answers map instead of handing it to the runtime", () => {
    // The regression: `{"answers":{"q":"TypeScript"}}` used to reach a `.some()`
    // call on a string and throw a TypeError, which surfaced as a 500 while the
    // interaction stayed parked until its auto-cancel.
    for (const answers of [
      { q: "TypeScript" },
      { q: [] },
      { q: [""] },
      { q: [1] },
      ["TypeScript"],
      "TypeScript",
      7,
    ]) {
      expect(parseInteractionAnswer({ action: "accept", answers })).toBeNull();
    }
  });

  test("passes content and meta through untouched on an accept", () => {
    expect(
      parseInteractionAnswer({
        action: "accept",
        content: { region: "eu-west-1" },
        meta: { formId: "f-1" },
      }),
    ).toEqual({
      action: "accept",
      content: { region: "eu-west-1" },
      meta: { formId: "f-1" },
    });
  });

  test.each([null, undefined, "accept", 7, ["accept"], {}, { action: "approve" }, { action: 1 }])(
    "rejects %p as an answer body",
    (body) => {
      expect(parseInteractionAnswer(body)).toBeNull();
    },
  );
});

import { describe, expect, test } from "bun:test";
import { openCode2FormAnswer, openCode2FormCard } from "./forms.js";

/** The form 2.2.6's `question` tool creates for two questions. */
const questionToolForm = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_1", id: "call_1" } },
  fields: [
    {
      key: "q0",
      title: "Colour",
      description: "Which colour should the button be?",
      type: "string",
      options: [
        {
          value: "Blue (Recommended)",
          label: "Blue (Recommended)",
          description: "Matches the theme",
        },
        { value: "Red", label: "Red", description: "Stands out" },
      ],
      custom: true,
    },
    {
      key: "q1",
      title: "Pages",
      description: "Which pages?",
      type: "multiselect",
      options: [
        { value: "Home", label: "Home" },
        { value: "Settings", label: "Settings" },
      ],
      custom: true,
    },
  ],
};

describe("openCode2FormCard", () => {
  test("a question-tool form is one required question per field", () => {
    const card = openCode2FormCard(questionToolForm)!;
    expect(card.title).toBe("OpenCode needs input");
    expect(card.body).toBeUndefined();
    expect(card.questions).toEqual([
      {
        id: "f0",
        prompt: "Which colour should the button be?",
        description: "Colour",
        required: true,
        secret: false,
        multiple: false,
        allowFreeText: true,
        options: [
          {
            id: "q0:o0",
            label: "Blue (Recommended)",
            providerValue: "Blue (Recommended)",
            description: "Matches the theme",
          },
          { id: "q0:o1", label: "Red", providerValue: "Red", description: "Stands out" },
        ],
      },
      expect.objectContaining({
        id: "f1",
        prompt: "Which pages?",
        multiple: true,
        allowFreeText: true,
      }),
    ]);
  });

  test("answers encode as the field values the question tool reads", () => {
    const card = openCode2FormCard(questionToolForm)!;
    expect(
      openCode2FormAnswer(card, [
        { questionId: "f0", optionIds: ["q0:o1"] },
        { questionId: "f1", optionIds: ["q1:o0"], freeText: "About" },
      ]),
    ).toEqual({ ok: true, answer: { q0: "Red", q1: ["Home", "About"] } });
    expect(openCode2FormAnswer(card, [{ questionId: "f0", freeText: "Green" }])).toEqual({
      ok: true,
      answer: { q0: "Green" },
    });
    // Both a choice and text for a single answer is ambiguous: refused, never guessed.
    expect(
      openCode2FormAnswer(card, [{ questionId: "f0", optionIds: ["q0:o0"], freeText: "x" }]).ok,
    ).toBe(false);
    expect(openCode2FormAnswer(card, [{ questionId: "f0", optionIds: ["q9:o9"] }]).ok).toBe(false);
  });

  test("boolean, number, integer and external fields", () => {
    const card = openCode2FormCard({
      id: "frm_2",
      sessionID: "s",
      title: "Deploy settings",
      fields: [
        { key: "confirm", type: "boolean", title: "Deploy now?", required: true },
        { key: "replicas", type: "integer", title: "Replicas", minimum: 1, maximum: 5 },
        { key: "ratio", type: "number", title: "Ratio" },
        { key: "login", type: "external", url: "https://example.test/login", title: "Sign in" },
      ],
    })!;
    expect(card.title).toBe("Deploy settings");
    expect(card.body).toBe("Deploy settings");
    expect(card.url).toBe("https://example.test/login");
    expect(
      card.questions.map((q) => [
        q.prompt,
        q.required,
        q.allowFreeText,
        q.options.map((o) => o.label),
      ]),
    ).toEqual([
      ["Deploy now?", true, false, ["Yes", "No"]],
      ["Replicas", false, true, []],
      ["Ratio", false, true, []],
      ["Sign in", true, false, ["Done"]],
    ]);
    expect(card.questions[1]!.description).toBe("A whole number. Between 1 and 5.");
    expect(
      openCode2FormAnswer(card, [
        { questionId: "f0", optionIds: ["q0:o1"] },
        { questionId: "f1", freeText: " 3 " },
        { questionId: "f2", freeText: "0.5" },
        { questionId: "f3", optionIds: ["q3:o0"] },
      ]),
    ).toEqual({ ok: true, answer: { confirm: false, replicas: 3, ratio: 0.5, login: true } });
    for (const freeText of ["2.5", "9", "abc", ""]) {
      expect(
        openCode2FormAnswer(card, [
          { questionId: "f0", optionIds: ["q0:o0"] },
          { questionId: "f1", freeText },
          { questionId: "f3", optionIds: ["q3:o0"] },
        ]).ok,
      ).toBe(false);
    }
  });

  test("hidden fields answer with their default; conditional fields are dropped when inactive", () => {
    const card = openCode2FormCard({
      id: "frm_3",
      sessionID: "s",
      title: "Release",
      fields: [
        {
          key: "channel",
          type: "string",
          title: "Channel",
          options: [
            { value: "beta", label: "Beta" },
            { value: "stable", label: "Stable" },
          ],
        },
        {
          key: "notes",
          type: "string",
          title: "Beta notes",
          required: true,
          when: [{ key: "channel", op: "eq", value: "beta" }],
        },
        { key: "token", type: "string", hidden: true, default: "abc" },
        { key: "internal", type: "string", hidden: true },
      ],
    })!;
    expect(card.questions.map((q) => q.prompt)).toEqual(["Channel", "Beta notes"]);
    // Conditional, so not required on the card, and the condition is stated.
    expect(card.questions[1]).toMatchObject({
      required: false,
      description: 'Only applies when "Channel" is beta.',
    });
    expect(
      openCode2FormAnswer(card, [
        { questionId: "f0", optionIds: ["q0:o1"] },
        { questionId: "f1", freeText: "ignored" },
      ]),
    ).toEqual({ ok: true, answer: { channel: "stable", token: "abc" } });
    expect(
      openCode2FormAnswer(card, [
        { questionId: "f0", optionIds: ["q0:o0"] },
        { questionId: "f1", freeText: "kept" },
      ]),
    ).toEqual({ ok: true, answer: { channel: "beta", notes: "kept", token: "abc" } });
  });

  test("too many choices degrade to free text; too many fields refuse; unknown kinds are text", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      value: `v${index}`,
      label: `V${index}`,
    }));
    const card = openCode2FormCard({
      id: "f",
      sessionID: "s",
      title: "Pick",
      fields: [
        { key: "a", type: "multiselect", title: "Values", options: many },
        { key: "b", type: "colour", title: "Hue" },
      ],
    })!;
    expect(card.questions[0]).toMatchObject({ allowFreeText: true, options: [], multiple: false });
    expect(card.questions[0]!.description).toContain("Allowed values: v0, v1");
    expect(card.questions[1]).toMatchObject({
      allowFreeText: true,
      description: "Answered as text.",
    });
    expect(
      openCode2FormAnswer(card, [
        { questionId: "f0", freeText: "v1, v2\nv3" },
        { questionId: "f1", freeText: "teal" },
      ]),
    ).toEqual({ ok: true, answer: { a: ["v1", "v2", "v3"], b: "teal" } });

    const wide = openCode2FormCard({
      id: "f",
      sessionID: "s",
      title: "Huge",
      fields: Array.from({ length: 20 }, (_, index) => ({ key: `k${index}`, type: "string" })),
    })!;
    expect(wide.confirmDisabled).toBe(true);
    expect(wide.body).toContain("20 fields");
    expect(openCode2FormAnswer(wide, []).ok).toBe(false);
  });

  test("something that is not a form is null", () => {
    expect(openCode2FormCard(null)).toBeNull();
    expect(openCode2FormCard({ id: "f", title: "x", fields: [] })).toBeNull();
    expect(openCode2FormCard({ id: "f", title: "x", fields: [{ type: "string" }] })).toBeNull();
  });
});

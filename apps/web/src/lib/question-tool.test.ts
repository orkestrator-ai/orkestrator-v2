import { describe, expect, test } from "bun:test";
import {
  parseQuestionToolArgs,
  parseQuestionToolOutput,
  questionToolPreview,
  resolveQuestionToolAnswers,
} from "./question-tool";

const ARGS = {
  questions: [
    {
      question: 'Commit 0795fb29 is "not mine". How should I treat it?',
      header: "0795fb29",
      multiSelect: false,
      options: [
        { label: "Keep it on top and push", description: "Run the checks and push it." },
        { label: "Split into its phases", description: "Move each change, then restack." },
        { label: "Leave it alone" },
      ],
    },
    {
      question: "Where should the two public keys go?",
      header: "Keys go in",
      multiSelect: false,
      options: [{ label: "A sixth PR on top (Recommended)" }, { label: "Into #1003" }],
    },
  ],
};

const OUTPUT =
  'Your questions have been answered: "Commit 0795fb29 is "not mine". How should I treat it?"="Keep it on top and push", ' +
  '"Where should the two public keys go?"="Into #1003". You can now continue with these answers in mind.';

describe("parseQuestionToolArgs", () => {
  test("reads questions, headers and options", () => {
    const questions = parseQuestionToolArgs(ARGS);
    expect(questions).toHaveLength(2);
    expect(questions![0]).toEqual({
      question: ARGS.questions[0]!.question,
      header: "0795fb29",
      multiSelect: false,
      options: [
        { label: "Keep it on top and push", description: "Run the checks and push it." },
        { label: "Split into its phases", description: "Move each change, then restack." },
        { label: "Leave it alone" },
      ],
    });
  });

  test("accepts OpenCode's `multiple` flag and skips malformed entries", () => {
    const questions = parseQuestionToolArgs({
      questions: [
        null,
        { header: "no question" },
        { question: "Pick some", multiple: true, options: [{ label: "" }, { label: "One" }, 7] },
      ],
    });
    expect(questions).toEqual([
      { question: "Pick some", multiSelect: true, options: [{ label: "One" }] },
    ]);
  });

  test("returns null for arguments that are not question-shaped", () => {
    expect(parseQuestionToolArgs(undefined)).toBeNull();
    expect(parseQuestionToolArgs({ command: "ls" })).toBeNull();
    expect(parseQuestionToolArgs({ questions: [] })).toBeNull();
    expect(parseQuestionToolArgs({ questions: "what?" })).toBeNull();
  });
});

describe("parseQuestionToolOutput", () => {
  test("recovers each answer even when the question text contains quotes", () => {
    const answers = parseQuestionToolOutput(parseQuestionToolArgs(ARGS)!, OUTPUT);
    expect([...answers.values()]).toEqual(["Keep it on top and push", "Into #1003"]);
  });

  test.each(["user notes: be careful", "selected preview: proposed changes"])(
    "excludes %s from the recovered answer",
    (annotation) => {
      const questions = parseQuestionToolArgs({ questions: [{ question: "Q?", options: [] }] })!;
      const answers = parseQuestionToolOutput(
        questions,
        `User has answered your questions: "Q?"="Yes" ${annotation}. You can now continue with the user's answers in mind.`,
      );
      expect(answers.get("Q?")).toBe("Yes");
    },
  );

  test("returns nothing for output that names no question", () => {
    const answers = parseQuestionToolOutput(parseQuestionToolArgs(ARGS)!, "User declined");
    expect(answers.size).toBe(0);
  });
});

describe("resolveQuestionToolAnswers", () => {
  test("marks the chosen options from the tool result", () => {
    const resolved = resolveQuestionToolAnswers(parseQuestionToolArgs(ARGS)!, ARGS, OUTPUT);
    expect(resolved.map((question) => question.selectedLabels)).toEqual([
      ["Keep it on top and push"],
      ["Into #1003"],
    ]);
    expect(resolved.every((question) => question.answered)).toBe(true);
  });

  test("prefers answers recorded in the arguments", () => {
    const args = {
      questions: [
        {
          question: "Which?",
          multiSelect: true,
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
      ],
      answers: { "Which?": "C, A" },
    };
    const [resolved] = resolveQuestionToolAnswers(parseQuestionToolArgs(args)!, args);
    expect(resolved!.selectedLabels).toEqual(["A", "C"]);
    expect(resolved!.customAnswers).toEqual([]);
  });

  test("splits JSON multi-select answers and keeps custom replies", () => {
    const args = {
      questions: [{ question: "Which?", options: [{ label: "A, with comma" }, { label: "B" }] }],
    };
    const [resolved] = resolveQuestionToolAnswers(
      parseQuestionToolArgs(args)!,
      args,
      '"Which?"="["A, with comma","Something else"]". You can now continue.',
    );
    expect(resolved!.selectedLabels).toEqual(["A, with comma"]);
    expect(resolved!.customAnswers).toEqual(["Something else"]);
  });

  test("splits comma-joined multi-select output in option order", () => {
    const args = {
      questions: [{ question: "Which?", multiSelect: true, options: ["A", "B", "C"] }],
    };
    const [resolved] = resolveQuestionToolAnswers(
      parseQuestionToolArgs(args)!,
      args,
      'Your questions have been answered: "Which?"="C, A". You can now continue.',
    );
    expect(resolved!.selectedLabels).toEqual(["A", "C"]);
    expect(resolved!.customAnswers).toEqual([]);
    expect(resolved!.answered).toBe(true);
  });

  test("leaves questions unanswered while the call is pending", () => {
    const resolved = resolveQuestionToolAnswers(parseQuestionToolArgs(ARGS)!, ARGS);
    expect(resolved.some((question) => question.answered)).toBe(false);
  });
});

describe("questionToolPreview", () => {
  test("summarizes one or several questions", () => {
    const questions = parseQuestionToolArgs(ARGS)!;
    expect(questionToolPreview(questions.slice(1))).toBe("Where should the two public keys go?");
    expect(questionToolPreview(questions)).toBe(`2 questions · ${questions[0]!.question}`);
  });
});

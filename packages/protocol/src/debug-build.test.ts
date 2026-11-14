import { describe, expect, test } from "bun:test";
import {
  debugBuildCriteria,
  debugBuildRequestIdentity,
  debugBuildTicket,
  debugBuildTitle,
  allocateDebugTranscriptBudgets,
  debugTranscriptComments,
  debugTranscriptSize,
  isCreateDebugBuildInput,
  MAX_DEBUG_BUILD_CRITERIA,
  MAX_DEBUG_BUILD_PROBLEM_LENGTH,
  type DebugBuildSourceDetails,
  type DebugTranscriptMessage,
} from "./debug-build.js";
import { parseTicketMarkdown } from "./ticket-sections.js";

const source: DebugBuildSourceDetails = {
  environmentId: "env-1",
  name: "settings-dialog",
  projectId: "project-1",
  projectName: "acme",
  environmentType: "local",
  status: "running",
  branch: "settings-dialog",
  capturedAt: "2026-11-14T10:00:00.000Z",
  tabs: [
    { tabId: "tab-1", agent: "claude", title: "Main", front: true, transcript: "attached" },
    { tabId: "tab-2", agent: "codex", title: null, front: false, transcript: "empty" },
  ],
};

describe("isCreateDebugBuildInput", () => {
  const valid = { environmentId: "env-1", problem: "Broken", requestId: "r-1" };

  test("requires an environment, a non-blank problem and a key", () => {
    expect(isCreateDebugBuildInput(valid)).toBe(true);
    expect(isCreateDebugBuildInput({ ...valid, problem: "   " })).toBe(false);
    expect(isCreateDebugBuildInput({ ...valid, environmentId: "" })).toBe(false);
    expect(isCreateDebugBuildInput({ ...valid, requestId: undefined })).toBe(false);
    expect(
      isCreateDebugBuildInput({
        ...valid,
        problem: "x".repeat(MAX_DEBUG_BUILD_PROBLEM_LENGTH + 1),
      }),
    ).toBe(false);
  });

  test("accepts an optional expected result and base64 screenshot, nothing else", () => {
    expect(isCreateDebugBuildInput({ ...valid, expectedResult: "Works", screenshot: "AAAA" })).toBe(
      true,
    );
    expect(isCreateDebugBuildInput({ ...valid, screenshot: "not base64!" })).toBe(false);
    expect(isCreateDebugBuildInput({ ...valid, projectId: "p" })).toBe(false);
  });
});

describe("debugBuildRequestIdentity", () => {
  test("changes with the text and the screenshot, not with the key", () => {
    const base = { environmentId: "env-1", problem: "Broken", requestId: "r-1" };
    expect(debugBuildRequestIdentity(base)).toBe(
      debugBuildRequestIdentity({ ...base, requestId: "r-2" }),
    );
    expect(debugBuildRequestIdentity(base)).not.toBe(
      debugBuildRequestIdentity({ ...base, problem: "Other" }),
    );
    expect(debugBuildRequestIdentity(base)).not.toBe(
      debugBuildRequestIdentity({ ...base, screenshot: "AAAA" }),
    );
  });

  test("two screenshots of equal length with the same ends are different requests", () => {
    const base = { environmentId: "env-1", problem: "Broken", requestId: "r-1" };
    const ends = "A".repeat(200);
    const first = `${ends}${"B".repeat(1_000)}${ends}`;
    const second = `${ends}${"B".repeat(499)}C${"B".repeat(500)}${ends}`;
    expect(first.length).toBe(second.length);
    expect(debugBuildRequestIdentity({ ...base, screenshot: first })).not.toBe(
      debugBuildRequestIdentity({ ...base, screenshot: second }),
    );
    // The identity stays small however large the capture is.
    expect(debugBuildRequestIdentity({ ...base, screenshot: first }).length).toBeLessThan(200);
  });
});

describe("debugBuildTitle", () => {
  test("takes the first sentence, without its full stop", () => {
    expect(debugBuildTitle("the toolbar is gone. It was there yesterday.")).toBe(
      "The toolbar is gone",
    );
    expect(debugBuildTitle("\n\n- add an export button\nmore")).toBe("Add an export button");
    expect(debugBuildTitle("!!!")).toBe("Debug request");
  });

  test("shortens a long first sentence on a word boundary", () => {
    const title = debugBuildTitle(`${"word ".repeat(40)}end`);
    expect(title.length).toBeLessThanOrEqual(73);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("debugBuildCriteria", () => {
  test("one criterion per expected-result line, list markers dropped", () => {
    expect(
      debugBuildCriteria("x", "- Opens on click\n2. Closes on Escape\n[ ] Keeps focus"),
    ).toEqual(["Opens on click", "Closes on Escape", "Keeps focus"]);
  });

  test("a single paragraph is one criterion", () => {
    expect(debugBuildCriteria("x", "The dialog opens and   shows the form.")).toEqual([
      "The dialog opens and shows the form.",
    ]);
  });

  test("without an expected result, the problem is the criterion", () => {
    expect(debugBuildCriteria("Add a dark theme")).toEqual([
      "The problem or objective in the summary is resolved: Add a dark theme",
    ]);
  });

  test("is bounded, and says the rest still applies", () => {
    const lines = Array.from(
      { length: MAX_DEBUG_BUILD_CRITERIA + 5 },
      (_, index) => `- item ${index}`,
    );
    const criteria = debugBuildCriteria("x", lines.join("\n"));
    expect(criteria).toHaveLength(MAX_DEBUG_BUILD_CRITERIA + 1);
    expect(criteria.at(-1)).toContain("Every other point");
  });
});

describe("debugBuildTicket", () => {
  test("puts the user's text in the summary and the source details in Context", () => {
    const ticket = debugBuildTicket({
      problem: "The dialog does not open.\n## Not a heading",
      expectedResult: "It opens",
      source,
      screenshotAttached: true,
    });
    expect(ticket.title).toBe("The dialog does not open");
    const parsed = parseTicketMarkdown(ticket.description);
    expect(parsed.summary).toContain("The dialog does not open.");
    expect(parsed.summary).toContain("\\## Not a heading");
    expect(parsed.summary).toContain("It opens");
    expect(parsed.context).toContain("Environment ID: `env-1`");
    expect(parsed.context).toContain("Project: acme (`project-1`)");
    expect(parsed.context).toContain("Type: local worktree");
    expect(parsed.context).toContain("Screenshot: attached as `debug-screenshot.webp`");
    expect(parsed.context).toContain('"Main" (claude, tab `tab-1`), in front: transcript attached');
    expect(parsed.context).toContain("untitled (codex, tab `tab-2`): no conversation yet");
    expect(ticket.acceptanceCriteria).toBe("- It opens");
  });

  test("says when no screenshot is attached", () => {
    const ticket = debugBuildTicket({ problem: "x", source, screenshotAttached: false });
    expect(ticket.description).toContain("Screenshot: not attached.");
  });
});

describe("debugTranscriptComments", () => {
  const message = (index: number, text = `message ${index}`): DebugTranscriptMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    createdAt: null,
    text,
    textTruncated: false,
    parts: [],
  });
  const tab = { tabId: "tab-1", agent: "claude", title: "Main" };

  test("renders every message with tool calls by name, status and title only", () => {
    const comments = debugTranscriptComments({
      tab,
      environmentId: "env-1",
      sessionId: "session-1",
      complete: true,
      maxChars: 10_000,
      messages: [
        message(0, "Fix it"),
        {
          ...message(1, "Done"),
          parts: [{ type: "tool", toolName: "Bash", status: "completed", title: "bun test" }],
        },
      ],
    });
    expect(comments).toHaveLength(1);
    const text = comments[0]!;
    expect(text).toContain(
      '### Source transcript: "Main" (claude, environment `env-1`, tab `tab-1`)',
    );
    expect(text).toContain("#### 1. user");
    expect(text).toContain("Fix it");
    expect(text).toContain("- `Bash` (completed): bun test");
    expect(text).not.toContain("omitted");
    // A whole conversation needs no pointer to the rest of it.
    expect(text).not.toContain("orkestrator session transcript");
  });

  test("a whole conversation longer than one comment spans several, losing nothing", () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(index, `${index}:${"x".repeat(990)}`),
    );
    const comments = debugTranscriptComments({
      tab,
      environmentId: "env-1",
      complete: true,
      maxChars: debugTranscriptSize(messages),
      commentMaxChars: 10_000,
      messages,
    });
    expect(comments.length).toBeGreaterThan(5);
    for (const comment of comments) expect(comment.length).toBeLessThanOrEqual(10_000);
    expect(comments[0]).toContain(`(part 1 of ${comments.length})`);
    const joined = comments.join("\n");
    for (let index = 0; index < 60; index++) {
      expect(joined).toContain(`#### ${index + 1}. `);
      expect(joined).toContain(`${index}:${"x".repeat(990)}`);
    }
    expect(joined).not.toContain("omitted");
  });

  test("keeps the first message and the newest that fit, says what was left out and where the rest is", () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(index, "x".repeat(200)));
    const comments = debugTranscriptComments({
      tab,
      environmentId: "env-1",
      sessionId: "session-1",
      complete: false,
      maxChars: 5_000,
      messages,
    });
    const text = comments.join("\n");
    expect(text.length).toBeLessThanOrEqual(6_500);
    expect(text).toContain("#### 1. user");
    expect(text).toContain("#### 200. assistant");
    expect(text).toMatch(/_\[\d+ messages omitted for length\]_/);
    expect(text).toContain("starts part-way");
    expect(text).toContain("`orkestrator session transcript session-1`");
  });
});

describe("allocateDebugTranscriptBudgets", () => {
  test("every tab that fits an equal share is kept whole; the longest share the rest", () => {
    expect(allocateDebugTranscriptBudgets([10, 500, 20], 1_000)).toEqual([10, 500, 20]);
    expect(allocateDebugTranscriptBudgets([10, 5_000, 20, 4_000], 1_000)).toEqual([
      10, 485, 20, 485,
    ]);
  });

  test("a long first tab does not leave the later tabs out", () => {
    const budgets = allocateDebugTranscriptBudgets([1_000_000, 3_000, 2_000], 240_000);
    expect(budgets[1]).toBe(3_000);
    expect(budgets[2]).toBe(2_000);
    expect(budgets[0]).toBe(235_000);
    expect(budgets.reduce((sum, budget) => sum + budget, 0)).toBeLessThanOrEqual(240_000);
  });

  test("empty tabs take nothing", () => {
    expect(allocateDebugTranscriptBudgets([0, 0], 100)).toEqual([0, 0]);
    expect(allocateDebugTranscriptBudgets([], 100)).toEqual([]);
  });
});

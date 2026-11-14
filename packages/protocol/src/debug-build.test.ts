import { describe, expect, test } from "bun:test";
import {
  debugBuildCriteria,
  debugBuildRequestIdentity,
  debugBuildTicket,
  debugBuildTitle,
  debugTranscriptComment,
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

describe("debugTranscriptComment", () => {
  const message = (index: number, text = `message ${index}`): DebugTranscriptMessage => ({
    role: index % 2 === 0 ? "user" : "assistant",
    createdAt: null,
    text,
    textTruncated: false,
    parts: [],
  });
  const tab = { tabId: "tab-1", agent: "claude", title: "Main" };

  test("renders every message with tool calls by name, status and title only", () => {
    const text = debugTranscriptComment({
      tab,
      environmentId: "env-1",
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
    expect(text).toContain(
      '### Source transcript: "Main" (claude, environment `env-1`, tab `tab-1`)',
    );
    expect(text).toContain("#### 1. user");
    expect(text).toContain("Fix it");
    expect(text).toContain("- `Bash` (completed): bun test");
    expect(text).not.toContain("omitted");
  });

  test("keeps the first message and the newest that fit, and says what was left out", () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(index, "x".repeat(200)));
    const text = debugTranscriptComment({
      tab,
      environmentId: "env-1",
      complete: false,
      maxChars: 5_000,
      messages,
    });
    expect(text.length).toBeLessThanOrEqual(5_000);
    expect(text).toContain("#### 1. user");
    expect(text).toContain("#### 200. assistant");
    expect(text).toMatch(/_\[\d+ messages omitted for length\]_/);
    expect(text).toContain("starts part-way");
  });
});

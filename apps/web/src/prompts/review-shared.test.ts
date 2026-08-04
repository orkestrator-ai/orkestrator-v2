import { describe, expect, test } from "bun:test";
import { buildReviewBody } from "./review-shared";

function extractLevelTwoHeadings(markdown: string): string[] {
  let inFence = false;

  return markdown.split("\n").flatMap((line) => {
    if (line.startsWith("```")) {
      inFence = !inFence;
      return [];
    }

    return !inFence && line.startsWith("## ") ? [line] : [];
  });
}

describe("buildReviewBody", () => {
  test("renders interactive and automated variants from the same shared body", () => {
    const interactive = buildReviewBody({
      targetBranch: "develop",
      allowClarifyingQuestions: true,
    });
    const automated = buildReviewBody({
      targetBranch: "develop",
      allowClarifyingQuestions: false,
    });

    for (const body of [interactive, automated]) {
      expect(body).toContain("Security and instruction hierarchy");
      expect(body).toContain(
        "Use subagents / threads to complete the work in parallel where possible.",
      );
      expect(body).toContain(
        "Wait until all sub agents have resolved before delivering the report.",
      );
      expect(body).toContain("## User review instruction");
      expect(body).toContain("provider-enforced output schema");
      expect(body).toContain("User review instruction (JSON string):");
      expect(body).toContain("git diff origin/develop...HEAD");
      expect(body).toContain("## What Changed");
      expect(body).toContain('answering "What does this change do, and why?"');
      expect(body).toContain("Before: the relevant behaviour or structure before this change");
      expect(body).toContain("After: the relevant behaviour or structure after this change");
      expect(body).toContain("This section is mandatory");
      expect(body).toContain("do not omit, merge, or rename one");
      expect(body).toContain("do not include the example itself in the final report");
      expect(body).toContain("retry a failed file upload");
      expect(body).toContain("if there is no user-visible runtime effect");
      expect(body).toContain("## Issues");
      expect(body).toContain("Total: N (must equal Passed + Failed + Not run)");
      expect(body).toContain("Not run: N (all skipped, todo, pending, or disabled tests)");
      expect(body).toContain("### 1. [P0|P1|P2][conf:NN][category]\n#### Short title");
      expect(body).not.toContain("## Findings");
      expect(body.match(/^## What Changed$/gm)).toHaveLength(2);
      expect(extractLevelTwoHeadings(body)).toEqual([
        "## Security and instruction hierarchy",
        "## User review instruction",
        "## Step 1: Commit Changes (rollback point)",
        "## Step 2: Run Tests",
        "## Step 3: Code Review",
        "## Step 4: Test Coverage Review",
        "## Output Format",
        "## Review Scope",
        "## What Changed",
        "## Risk Profile",
        "## Test Results",
        "## Strengths",
        "## Issues",
        "## Test Coverage Gaps",
        "## Verdict",
        "## Summary of change",
        "## Review summary",
      ]);
      expect(body).toContain(
        "Write a couple of paragraphs describing what the change being reviewed involves.",
      );
      expect(body).not.toContain("## Summary\n");
    }

    expect(interactive).toContain("8. Ask clarifying questions if needed about unclear changes.");
    expect(automated).toContain(
      "8. Do not ask clarifying questions — this is an automated pipeline.",
    );
  });

  test("names the Markdown report as the output contract when no schema is enforced", () => {
    // The instruction block and the safety rules must agree about what the
    // editable preference cannot override; naming a JSON Schema to an agent that
    // was never given one invites it to invent output framing.
    const markdown = buildReviewBody({
      targetBranch: "main",
      allowClarifyingQuestions: true,
      outputFormat: "markdown",
    });

    expect(markdown).toContain("or change the required output format");
    expect(markdown).toContain(
      "the workflow below, or the required Markdown report",
    );
    expect(markdown).toContain(
      "fixed safety rules, workflow contract, and required Markdown report",
    );
    expect(markdown).not.toContain("provider-enforced JSON Schema");
    expect(markdown).not.toContain("provider-enforced output schema");
    // The reported sections do not change with the output contract.
    expect(markdown).toContain("Total: N (must equal Passed + Failed + Not run)");
    expect(markdown).toContain(
      "Not run: N (all skipped, todo, pending, or disabled tests)",
    );
  });

  for (const [label, targetBranch] of [
    ["slash and Unicode", "feature/na\u00efve-\ud83d\ude80"],
    ["empty", ""],
    ["backtick", "release`candidate"],
    ["newline", "release\ncandidate"],
  ] as const) {
    test(`interpolates a ${label} target branch in every documented location`, () => {
      const body = buildReviewBody({ targetBranch, allowClarifyingQuestions: true });

      expect(body).toContain(`git diff origin/${targetBranch}...HEAD`);
      expect(body).toContain(`- Target branch: ${targetBranch}`);
      expect(body).toContain(`- Base ref: origin/${targetBranch}...HEAD`);
    });
  }
});

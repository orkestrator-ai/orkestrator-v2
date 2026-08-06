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
      outputFormat: "markdown",
    });
    const automated = buildReviewBody({
      targetBranch: "develop",
      allowClarifyingQuestions: false,
      preparationMode: "verify-clean",
      outputFormat: "structured",
    });

    for (const body of [interactive, automated]) {
      expect(body).toContain("Security and instruction hierarchy");
      expect(body).toContain(
        "Delegate only independent work whose expected cost exceeds delegation and duplicated-context overhead",
      );
      expect(body).toContain(
        "Use the provider's native subagent lifecycle and completion notifications to wait for delegated work. Do not create background shell loops, marker files, polling sentinels, or sleep commands to wait for subagents.",
      );
      expect(body).toContain(
        "Wait until all sub agents have resolved before delivering the report.",
      );
      expect(body).toContain(
        "Before delivering the report, stop any temporary background task created only for coordination or waiting. Do not stop substantive builds, tests, servers, or other user-requested work.",
      );
      expect(body).toContain("## User review instruction");
      expect(body).toContain("User review instruction (JSON string):");
      expect(body).toContain("git diff origin/develop...HEAD");
      expect(body).toContain("## Step 2: Run Tests");
      expect(body).toContain("while the primary reviewer begins Step 3");
      expect(body).toContain("Do not report unrelated pre-existing gaps");
    }

    expect(interactive).toContain("required Markdown report");
    expect(interactive).toContain("## Step 1: Establish the review snapshot and rollback point");
    expect(interactive).toContain("## Issues");
    expect(interactive).toContain("### 1. [P0|P1|P2][conf:NN][category]\n#### Short title");
    expect(interactive).not.toContain("## What Changed");
    expect(interactive).not.toContain("## Strengths");
    expect(extractLevelTwoHeadings(interactive)).toEqual([
      "## Security and instruction hierarchy",
      "## User review instruction",
      "## Step 1: Establish the review snapshot and rollback point",
      "## Step 2: Run Tests",
      "## Step 3: Code Review",
      "## Step 4: Test Coverage Review",
      "## Output Format",
      "## Review Scope",
      "## Risk Profile",
      "## Issues",
      "## Test Coverage Gaps",
      "## Test Results",
      "## Verdict",
      "## Summary of change",
    ]);
    expect(extractLevelTwoHeadings(interactive).at(-1)).toBe("## Summary of change");
    expect(interactive).not.toContain("## Summary\n");
    expect(interactive).toContain("8. Ask a clarifying question only when the answer would materially change");

    expect(automated).toContain("provider-enforced output schema");
    expect(automated).toContain("## Step 1: Establish the read-only review snapshot");
    expect(automated).toContain("## Output contract");
    expect(automated).not.toContain("## Output Format");
    expect(automated).not.toContain("### 1. [P0|P1|P2]");
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
    expect(markdown).toContain("do not infer counts the runner did not provide");
  });

  for (const [label, targetBranch] of [
    ["slash and Unicode", "feature/na\u00efve-\ud83d\ude80"],
    ["empty", ""],
    ["backtick", "release`candidate"],
    ["newline", "release\ncandidate"],
  ] as const) {
    test(`interpolates a ${label} target branch in every documented location`, () => {
      const body = buildReviewBody({
        targetBranch,
        allowClarifyingQuestions: true,
        outputFormat: "markdown",
      });

      expect(body).toContain(`git diff origin/${targetBranch}...HEAD`);
      expect(body).toContain(`- Target branch: ${targetBranch}`);
      expect(body).toContain(`- Base ref: origin/${targetBranch}...HEAD`);
    });
  }
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createReviewPrompt } from "./git-workflows";
import { buildReviewBody } from "./review-shared";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function extractDocumentedPrompt(markdown: string): string {
  const startMarker = "---\n\n";
  const endMarker = "\n\n---\n\n## Workflow summary";
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Could not locate documented review prompt block");
  }

  return markdown.slice(start + startMarker.length, end);
}

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
      expect(body).toContain("### 1. [P0|P1|P2][conf:NN][category]\n#### Short title");
      expect(body).not.toContain("## Findings");
      expect(body.match(/^## What Changed$/gm)).toHaveLength(2);
      expect(extractLevelTwoHeadings(body)).toEqual([
        "## Security and instruction hierarchy",
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

  test("keeps the documented current review prompt in sync with createReviewPrompt", () => {
    const documentation = read("docs/current-review-prompt.md");
    const documentedPrompt = extractDocumentedPrompt(documentation);

    expect(documentedPrompt).toBe(createReviewPrompt("main"));
    expect(documentation).toContain("Settings → Review");
    expect(documentation).toContain("Reset to default");
    expect(documentation).toContain("100,000 characters");
    expect(documentation).toContain("malformed, blank, or oversized persisted overrides");
    expect(documentation).toContain("{{targetBranch}}");
    expect(documentation).toContain(
      "| Output | Markdown sections: Review Scope, What Changed, Risk Profile, Test Results",
    );
    expect(documentation).toContain("Summary of change, Review summary");
  });

  test("documents the prompt sources, invocation, related workflows, and maintenance steps", () => {
    const documentation = read("docs/current-review-prompt.md");
    const headings = extractLevelTwoHeadings(documentation);

    expect(headings.slice(0, 5)).toEqual([
      "## Source",
      "## How it is invoked",
      "## Custom prompt setting",
      "## Dynamic parameter",
      "## Full prompt text",
    ]);
    expect(headings.slice(-3)).toEqual([
      "## Workflow summary",
      "## Related prompts (not this button)",
      "## Maintenance",
    ]);

    for (const expected of [
      "| Prompt generator | `apps/web/src/prompts/git-workflows.ts` → `createReviewPrompt(targetBranch, customPrompt?)` |",
      "| Shared body | `apps/web/src/prompts/review-shared.ts` → `buildReviewBody(opts)` |",
      "| Export | `apps/web/src/prompts/index.ts` |",
      "| UI trigger | `apps/web/src/components/layout/ActionBar.tsx` → `handleReview()` |",
      "| Tests | `apps/web/src/prompts/git-workflows.test.ts` |",
      "`handleReview(agentOverride?)` runs:",
      "Calls `createReviewPrompt(targetBranch, config.global.reviewPrompt)`.",
      'Opens a new agent tab via `createTab(agent, { initialPrompt: reviewPrompt, displayTitle: "Review" })`.',
      "**Right-click context menu**: explicit override — Claude, OpenCode, or Codex.",
      "**Keyboard**: `⌘R` (same as click; requires `canCreateTab` and `selectedProjectId`).",
      "The prompt is passed as `initialPrompt` on the new tab and sent automatically",
      "- Compare command: `` git diff origin/${targetBranch}...HEAD ``",
      "- Base ref line in Review Scope: `Base ref: origin/${targetBranch}...HEAD`",
      "- Target branch line in Review Scope: `Target branch: ${targetBranch}`",
      "| Preamble | Security/instruction hierarchy",
      "| 1 | Commit only files that clearly belong to the change",
      "| 2 | Run full project test suite; record failures |",
      "| 3 | Diff against `origin/<targetBranch>...HEAD`",
      "| 4 | Audit test coverage for all impacted files",
      "| Build pipeline review phase | `createBuildReviewPrompt()`",
      "| Create PR button | `createPRPrompt()`",
      "| Claude compose `/review` | Claude CLI slash command |",
      "| `docs/second-opinion.md` | Standalone review rubric |",
      "| `docs/code-review-prompt-enhancement-spec.md` | Spec that drove these changes |",
      "1. `buildReviewBody()` in `apps/web/src/prompts/review-shared.ts`",
      "2. `createReviewPrompt()` in `apps/web/src/prompts/git-workflows.ts`",
      "3. `createBuildReviewPrompt()` in `apps/web/src/prompts/build-pipeline.ts`",
      "4. Assertions in `apps/web/src/prompts/git-workflows.test.ts` and `apps/web/src/prompts/build-pipeline.test.ts`.",
      "5. This file so it stays in sync with the generated template",
      "regenerate with `bun -e",
    ]) {
      expect(documentation).toContain(expected);
    }
  });
});

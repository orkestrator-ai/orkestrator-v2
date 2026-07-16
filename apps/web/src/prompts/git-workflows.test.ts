import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  REVIEW_PROMPT_TARGET_BRANCH_TOKEN,
  createReviewPrompt,
  createPRPrompt,
  createPushChangesPrompt,
  createResolveConflictsPrompt,
} from "./git-workflows";

// --- createReviewPrompt ---

describe("createReviewPrompt", () => {
  test("includes commit step with rollback-point guardrails", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Step 1: Commit Changes (rollback point)");
    expect(result).toContain("conventional-commit format");
    expect(result).toContain("Do NOT reference Claude");
    expect(result).toContain("git status --porcelain");
    expect(result).toContain("git diff HEAD");
    expect(result).toContain(".env*");
    expect(result).toContain("node_modules");
  });

  test("includes prompt-injection defence", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("Security and instruction hierarchy");
    expect(result).toContain("untrusted data");
    expect(result).toContain("ignore previous instructions");
    expect(result).toContain("Redact");
  });

  test("includes test run step", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Step 2: Run Tests");
    expect(result).toContain("Run the project's full test suite");
    expect(result).toContain("record every failure");
  });

  test("includes code review step with git diff against target branch", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Step 3: Code Review");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  test("includes expanded review rubric with bugs, edge cases, race conditions", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("Bugs and correctness");
    expect(result).toContain("intended consequence does not arise");
    expect(result).toContain("off-by-one");
    expect(result).toContain("Edge cases");
    expect(result).toContain("idempotency");
    expect(result).toContain("Concurrency and race conditions");
    expect(result).toContain("TOCTOU");
    expect(result).toContain("Error handling");
  });

  test("includes expanded security checklist", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("Authentication, session handling");
    expect(result).toContain("SSRF");
    expect(result).toContain("supply-chain");
    expect(result).toContain("LLM-specific risks");
  });

  test("gates issues on confidence and severity", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("confidence >= 75");
    expect(result).toContain("P0 (broken/crash/data-loss/security)");
    expect(result).toContain("P1");
    expect(result).toContain("P2");
  });

  test("includes test coverage review step", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Step 4: Test Coverage Review");
    expect(result).toContain("entire file");
    expect(result).toContain("not modified in this change");
  });

  test("includes markdown output sections", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Output Format");
    expect(result).toContain("## Review Scope");
    expect(result).toContain("## Risk Profile");
    expect(result).toContain("Overall risk: low | medium | high");
    expect(result).toContain("## Test Results");
    expect(result).toContain("## Issues");
    expect(result).toContain("Number issues sequentially starting at 1");
    expect(result).toContain("### 1. [P0|P1|P2][conf:NN][category]\n#### Short title");
    expect(result).not.toContain("## Findings");
    expect(result).toContain("Symbol:");
    expect(result).toContain("## Test Coverage Gaps");
    expect(result).toContain("## Verdict");
    expect(result).toContain("## Summary");
  });

  test("uses safer no-issues wording", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain(
      'No high-confidence issues were found in the reviewed scope.',
    );
    expect(result).toContain("Do NOT claim the code is correct");
    expect(result).not.toContain("meets best practices");
  });

  test("allows clarifying questions (action bar variant)", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("Ask clarifying questions if needed");
    expect(result).not.toContain("automated pipeline");
  });

  test("uses the provided target branch", () => {
    const result = createReviewPrompt("develop");
    expect(result).toContain("git diff origin/develop...HEAD");
    expect(result).toContain("Base ref: origin/develop...HEAD");
    expect(result).not.toContain("origin/main...HEAD");
  });

  test("resolves target-branch tokens in a custom prompt", () => {
    const customPrompt = `Review origin/${REVIEW_PROMPT_TARGET_BRANCH_TOKEN}...HEAD\nTarget: ${REVIEW_PROMPT_TARGET_BRANCH_TOKEN}`;

    expect(createReviewPrompt("release/v2", customPrompt)).toBe(
      "Review origin/release/v2...HEAD\nTarget: release/v2",
    );
  });

  test("falls back to the built-in template for an empty custom prompt", () => {
    expect(createReviewPrompt("main", "   ")).toBe(
      DEFAULT_REVIEW_PROMPT_TEMPLATE.replaceAll(
        REVIEW_PROMPT_TARGET_BRANCH_TOKEN,
        "main",
      ),
    );
  });
});

// --- createPRPrompt ---

describe("createPRPrompt", () => {
  test("includes stage, commit, push, and PR steps", () => {
    const result = createPRPrompt("main");
    expect(result).toContain("## Step 1: Stage All Changes");
    expect(result).toContain("## Step 2: Create Commit");
    expect(result).toContain("## Step 3: Push to Remote");
    expect(result).toContain("## Step 4: Create Pull Request");
  });

  test("uses the provided target branch for PR creation", () => {
    const result = createPRPrompt("develop");
    expect(result).toContain("gh pr create --base develop --fill");
    expect(result).toContain("git diff origin/develop...HEAD");
  });

  test("instructs not to reference Claude", () => {
    const result = createPRPrompt("main");
    expect(result).toContain("Do NOT reference Claude");
  });

  test("instructs not to skip hooks", () => {
    const result = createPRPrompt("main");
    expect(result).toContain("Do NOT use --no-verify");
  });

  test("requests PR URL in output", () => {
    const result = createPRPrompt("main");
    expect(result).toContain("PR URL");
  });
});

// --- createPushChangesPrompt ---

describe("createPushChangesPrompt", () => {
  test("includes stage, commit, and push steps", () => {
    const result = createPushChangesPrompt();
    expect(result).toContain("## Step 1: Stage All Changes");
    expect(result).toContain("## Step 2: Create Commit");
    expect(result).toContain("## Step 3: Push to Remote");
  });

  test("instructs not to reference Claude", () => {
    const result = createPushChangesPrompt();
    expect(result).toContain("Do NOT reference Claude");
  });

  test("instructs not to skip hooks", () => {
    const result = createPushChangesPrompt();
    expect(result).toContain("Do NOT use --no-verify");
  });

  test("mentions updating existing PR", () => {
    const result = createPushChangesPrompt();
    expect(result).toContain("update an existing PR");
  });
});

// --- createResolveConflictsPrompt ---

describe("createResolveConflictsPrompt", () => {
  test("includes all resolution steps", () => {
    const result = createResolveConflictsPrompt("main");
    expect(result).toContain("## Step 1: Fetch Latest Changes");
    expect(result).toContain("## Step 2: Merge Target Branch");
    expect(result).toContain("## Step 3: Resolve Conflicts");
    expect(result).toContain("## Step 4: Complete the Merge");
    expect(result).toContain("## Step 5: Push Changes");
  });

  test("uses the provided target branch", () => {
    const result = createResolveConflictsPrompt("develop");
    expect(result).toContain("git merge origin/develop");
    expect(result).toContain(`Merge develop and resolve conflicts`);
  });

  test("instructs not to skip hooks", () => {
    const result = createResolveConflictsPrompt("main");
    expect(result).toContain("Do NOT use --no-verify");
  });

  test("includes conflict marker instructions", () => {
    const result = createResolveConflictsPrompt("main");
    expect(result).toContain("<<<<<<<");
    expect(result).toContain("=======");
    expect(result).toContain(">>>>>>>");
  });
});

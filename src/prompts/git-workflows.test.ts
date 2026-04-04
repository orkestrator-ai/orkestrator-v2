import { describe, expect, test } from "bun:test";
import {
  createReviewPrompt,
  createPRPrompt,
  createPushChangesPrompt,
  createResolveConflictsPrompt,
} from "./git-workflows";

// --- createReviewPrompt ---

describe("createReviewPrompt", () => {
  test("includes commit step", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Step 1: Commit Changes");
    expect(result).toContain("conventional commit format");
    expect(result).toContain("Do NOT reference Claude");
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

  test("includes all review categories", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("Logic and correctness");
    expect(result).toContain("Readability");
    expect(result).toContain("Performance");
  });

  test("includes test coverage review step", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Step 4: Test Coverage Review");
    expect(result).toContain("entire file");
    expect(result).toContain("not modified in this change");
  });

  test("includes structured output format", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("## Output Format");
    expect(result).toContain("File and line number(s)");
    expect(result).toContain("Code snippet");
    expect(result).toContain("Potential solution(s)");
    expect(result).toContain("test coverage gaps");
  });

  test("uses the provided target branch", () => {
    const result = createReviewPrompt("develop");
    expect(result).toContain("git diff origin/develop...HEAD");
  });

  test("output format includes test results reporting", () => {
    const result = createReviewPrompt("main");
    expect(result).toContain("Report test suite results");
    expect(result).toContain("total tests run, passed, and failed");
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

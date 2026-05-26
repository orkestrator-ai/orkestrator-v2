import { describe, expect, test } from "bun:test";
import { createBuildReviewPrompt, type TaskSnapshot } from "./build-pipeline";

const emptyTask: TaskSnapshot = {
  title: "",
  description: "",
  acceptanceCriteria: "",
  comments: [],
  images: [],
};

describe("createBuildReviewPrompt", () => {
  test("includes shared review body sections", () => {
    const result = createBuildReviewPrompt(null, "", "main");
    expect(result).toContain("Security and instruction hierarchy");
    expect(result).toContain("untrusted data");
    expect(result).toContain("## Step 1: Commit Changes (rollback point)");
    expect(result).toContain("## Step 2: Run Tests");
    expect(result).toContain("## Step 3: Code Review");
    expect(result).toContain("## Step 4: Test Coverage Review");
    expect(result).toContain("## Review Scope");
    expect(result).toContain("## Risk Profile");
    expect(result).toContain("## Issues");
    expect(result).toContain("### 1. [P0|P1|P2][conf:NN][category]\nShort title");
    expect(result).not.toContain("## Findings");
    expect(result).toContain("## Verdict");
  });

  test("includes expanded rubric and security checklist", () => {
    const result = createBuildReviewPrompt(null, "", "main");
    expect(result).toContain("Bugs and correctness");
    expect(result).toContain("Edge cases");
    expect(result).toContain("Concurrency and race conditions");
    expect(result).toContain("SSRF");
    expect(result).toContain("supply-chain");
    expect(result).toContain("confidence >= 75");
  });

  test("uses pipeline (no-questions) variant of clarifying line", () => {
    const result = createBuildReviewPrompt(null, "", "main");
    expect(result).toContain("Do not ask clarifying questions");
    expect(result).toContain("automated pipeline");
    expect(result).not.toContain("Ask clarifying questions if needed");
  });

  test("uses safer no-issues wording", () => {
    const result = createBuildReviewPrompt(null, "", "main");
    expect(result).toContain(
      "No high-confidence issues were found in the reviewed scope.",
    );
    expect(result).not.toContain("meets best practices");
  });

  test("interpolates target branch", () => {
    const result = createBuildReviewPrompt(null, "", "develop");
    expect(result).toContain("git diff origin/develop...HEAD");
    expect(result).toContain("Base ref: origin/develop...HEAD");
    expect(result).not.toContain("origin/main...HEAD");
  });

  test("defaults target branch to main when omitted", () => {
    const result = createBuildReviewPrompt(null, "");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  test("includes ticket title, description, and acceptance criteria when task provided", () => {
    const task: TaskSnapshot = {
      ...emptyTask,
      title: "Add user export",
      description: "Allow users to export their data as CSV.",
      acceptanceCriteria: "- CSV download works\n- Email field is included",
    };
    const result = createBuildReviewPrompt(task, "", "main");
    expect(result).toContain("**Title**: Add user export");
    expect(result).toContain("**Description**: Allow users to export their data as CSV.");
    expect(result).toContain("**Acceptance Criteria**:");
    expect(result).toContain("CSV download works");
  });

  test("includes project notes when provided", () => {
    const result = createBuildReviewPrompt(null, "Use Bun, not Node.", "main");
    expect(result).toContain("**Project Notes**:");
    expect(result).toContain("Use Bun, not Node.");
  });

  test("includes ticket comments and image filenames when present", () => {
    const task: TaskSnapshot = {
      ...emptyTask,
      title: "Fix login",
      comments: [{ text: "Repro requires SSO." }],
      images: [{ filename: "screenshot.png", data: "base64data" }],
    };
    const result = createBuildReviewPrompt(task, "", "main");
    expect(result).toContain("**Comments**:");
    expect(result).toContain("Repro requires SSO.");
    expect(result).toContain("**Attached Images** (1): screenshot.png");
  });
});

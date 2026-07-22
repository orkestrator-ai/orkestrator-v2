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
      expect(body).toContain("## Functionality Summary");
      expect(body).toContain("functionality introduced or changed by the reviewed diff");
      expect(body).toContain("If the diff has no runtime behaviour change");
      expect(body).toContain("## Issues");
      expect(body).toContain("### 1. [P0|P1|P2][conf:NN][category]\n#### Short title");
      expect(body).not.toContain("## Findings");
    }

    expect(interactive).toContain("Ask clarifying questions if needed");
    expect(automated).toContain("Do not ask clarifying questions");
  });

  test("keeps the documented current review prompt in sync with createReviewPrompt", () => {
    const documentation = read("docs/current-review-prompt.md");
    const documentedPrompt = extractDocumentedPrompt(documentation);

    expect(documentedPrompt).toBe(createReviewPrompt("main"));
    expect(documentation).toContain("Settings → Review");
    expect(documentation).toContain("Reset to default");
    expect(documentation).toContain("100,000 characters");
    expect(documentation).toContain("malformed, blank, or oversized persisted overrides");
    expect(documentation).toContain("{{targetBranch}}");
  });
});

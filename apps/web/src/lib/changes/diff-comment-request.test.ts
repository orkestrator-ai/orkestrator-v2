import { describe, expect, test } from "bun:test";
import type { DiffComment, DiffCommentAnchor } from "@/stores/diffCommentsStore";
import {
  buildDiffCommentRequest,
  diffCommentLocation,
  diffCommentRequestId,
} from "./diff-comment-request";

function comment(
  body: string,
  anchor: Partial<DiffCommentAnchor> = {},
  overrides: Partial<DiffComment> = {},
): DiffComment {
  return {
    id: body,
    body,
    revision: 1,
    selected: true,
    createdAt: 0,
    anchor: {
      source: "live",
      diffIdentityId: "diff-1",
      measurementId: "m-1",
      scope: "environment-net",
      pathId: "p:src/app.ts",
      path: "src/app.ts",
      contentKey: "blob:a|blob:b",
      kind: "line",
      side: "new",
      line: 42,
      hunkHeader: "@@ -40,3 +40,4 @@",
      excerpt: [{ type: "add", text: "const value = read();", oldLine: null, newLine: 42 }],
      excerptTruncated: false,
      ...anchor,
    },
    ...overrides,
  };
}

describe("diffCommentLocation", () => {
  test("names the line, the removed line or the hunk", () => {
    expect(diffCommentLocation(comment("a"))).toBe("src/app.ts:42");
    expect(diffCommentLocation(comment("a", { side: "old", line: 7 }))).toBe(
      "src/app.ts:7 (removed line)",
    );
    expect(diffCommentLocation(comment("a", { kind: "hunk", line: null }))).toBe(
      "src/app.ts, hunk @@ -40,3 +40,4 @@",
    );
  });
});

describe("buildDiffCommentRequest", () => {
  test("quotes each comment's captured code under one numbered request", () => {
    const text = buildDiffCommentRequest([
      { comment: comment("Handle a null result."), outdated: false },
      {
        comment: comment("Drop this helper.", {
          path: "src/util.ts",
          pathId: "p:src/util.ts",
          kind: "hunk",
          line: null,
          hunkHeader: "@@ -1,2 +1,1 @@",
          excerpt: [
            { type: "context", text: "export {};", oldLine: 1, newLine: 1 },
            { type: "remove", text: "function helper() {}", oldLine: 2, newLine: null },
          ],
          excerptTruncated: true,
        }),
        outdated: true,
      },
    ]);

    expect(text).toBe(
      [
        "Please address these review comments on the changes in this workspace (2 comments across 2 files). Each quotes the diff lines it refers to; line numbers count in the file as shown in that diff.",
        "## 1. src/app.ts:42\n\n```diff\n+const value = read();\n```\n\nHandle a null result.",
        "## 2. src/util.ts, hunk @@ -1,2 +1,1 @@\n\nNote: this file has changed since the comment was written, so the line numbers may have moved. The code below is what the comment was written about.\n\n```diff\n export {};\n-function helper() {}\n…\n```\n\nDrop this helper.",
      ].join("\n\n"),
    );
  });

  test("labels historical comments and fences code that contains backticks", () => {
    const text = buildDiffCommentRequest([
      {
        comment: comment("Use a template.", {
          source: "historical",
          excerpt: [{ type: "add", text: "const s = ```;", oldLine: null, newLine: 42 }],
        }),
        outdated: false,
      },
    ]);
    expect(text).toContain("(1 comment)");
    expect(text).toContain("Note: written on an earlier recorded change to this file.");
    expect(text).toContain("````diff\n+const s = ```;\n````");
  });
});

describe("diffCommentRequestId", () => {
  test("is stable for one batch and changes with any revision or destination", () => {
    const items = [
      { id: "a", revision: 1 },
      { id: "b", revision: 3 },
    ];
    const id = diffCommentRequestId("env-1", "tab-1", items);
    expect(id).toMatch(/^diff-comments:[0-9a-f]{16}$/);
    expect(
      diffCommentRequestId(
        "env-1",
        "tab-1",
        items.map((item) => ({ ...item })),
      ),
    ).toBe(id);
    expect(
      diffCommentRequestId("env-1", "tab-1", [
        { id: "a", revision: 2 },
        { id: "b", revision: 3 },
      ]),
    ).not.toBe(id);
    expect(diffCommentRequestId("env-1", "tab-2", items)).not.toBe(id);
  });
});

import { describe, expect, test } from "bun:test";
import {
  fileStatusFromApi,
  getGitHubPullRequestFiles,
  mapPullRequestFiles,
  parsePullRequestFilePatch,
} from "../src/core/github-pull-request-files";
import {
  HEAD_SHA,
  REF,
  TOKEN,
  apiPull,
  createFakeGitHub,
  json,
} from "./github-pull-request-fixtures";

const PATCH = "@@ -1,3 +1,4 @@ function main() {\n line1\n-old\n+new\n+added\n line3";

describe("pull request file patches", () => {
  test("parses GitHub's bare hunks with old and new line numbers", () => {
    const hunks = parsePullRequestFilePatch(PATCH);
    expect(hunks).toHaveLength(1);
    expect(hunks?.[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(hunks?.[0]?.lines).toEqual([
      { type: "context", text: "line1", oldLine: 1, newLine: 1 },
      { type: "remove", text: "old", oldLine: 2, newLine: null },
      { type: "add", text: "new", oldLine: null, newLine: 2 },
      { type: "add", text: "added", oldLine: null, newLine: 3 },
      { type: "context", text: "line3", oldLine: 3, newLine: 4 },
    ]);
  });

  test("numbers a second hunk from its own header and keeps no-newline markers", () => {
    const hunks = parsePullRequestFilePatch(
      "@@ -1 +1 @@\n-a\n+b\n@@ -40,2 +40,2 @@\n x\n-y\n\\ No newline at end of file\n+z\n\\ No newline at end of file",
    );
    expect(hunks?.[1]?.lines.map((line) => [line.type, line.oldLine, line.newLine])).toEqual([
      ["context", 40, 40],
      ["remove", 41, null],
      ["no-newline", null, null],
      ["add", null, 41],
      ["no-newline", null, null],
    ]);
  });

  test("gives up on patches over the per-file row cap", () => {
    const lines = Array.from({ length: 3_001 }, (_, index) => `+line ${index}`);
    expect(parsePullRequestFilePatch(`@@ -0,0 +1,3001 @@\n${lines.join("\n")}`)).toBeNull();
  });

  test.each([
    ["added", "added"],
    ["removed", "deleted"],
    ["modified", "modified"],
    ["renamed", "renamed"],
    ["copied", "copied"],
    ["changed", "mode-changed"],
    ["unchanged", "modified"],
    ["weird", "unknown"],
  ] as const)("maps GitHub status %s to %s", (status, expected) => {
    expect(fileStatusFromApi(status)).toBe(expected);
  });

  test("marks binary and oversized files unavailable and respects the response budget", () => {
    const files = mapPullRequestFiles(
      [
        { filename: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
        { filename: "big.json", status: "modified", additions: 9000, deletions: 0 },
        {
          filename: "new/name.ts",
          previous_filename: "old/name.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
        { filename: "src/b.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH },
      ],
      new Map([["src/a.ts", "viewed"]]),
      6,
    );
    expect(
      files.map((file) => [file.path, file.patchAvailable, file.hunks.length, file.viewedState]),
    ).toEqual([
      ["src/a.ts", true, 1, "viewed"],
      ["logo.png", false, 0, "unviewed"],
      ["big.json", false, 0, "unviewed"],
      ["new/name.ts", true, 0, "unviewed"],
      // Over the shared budget of six rendered rows.
      ["src/b.ts", false, 0, "unviewed"],
    ]);
    expect(files[3]?.previousPath).toBe("old/name.ts");
  });
});

describe("getGitHubPullRequestFiles", () => {
  test("merges REST files with GraphQL viewed state and paged review threads", async () => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", () =>
      json(apiPull({ changed_files: 2 }), { headers: { etag: '"pull"' } }),
    );
    fake.on("GET", "/repos/acme/repo/pulls/7/files", () =>
      json(
        [
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            patch: PATCH,
            blob_url: "https://github.com/acme/repo/blob/x/src/a.ts",
          },
          {
            filename: "src/b.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+hello",
          },
        ],
        { headers: { etag: '"files"' } },
      ),
    );
    const thread = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
      id,
      path,
      line: 2,
      startLine: null,
      diffSide: "RIGHT",
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      comments: {
        nodes: [
          {
            databaseId: 11,
            id: `${id}_c1`,
            body: "First",
            author: { login: "rev", avatarUrl: null, url: null },
            createdAt: "t1",
            updatedAt: "t1",
            url: "u1",
            diffHunk: "@@ -1 +1 @@",
          },
          {
            databaseId: 12,
            id: `${id}_c2`,
            body: "Reply",
            author: null,
            createdAt: "t2",
            updatedAt: "t3",
            url: "u2",
            diffHunk: "@@ -1 +1 @@",
          },
        ],
      },
      ...extra,
    });
    const calls: Array<Record<string, unknown>> = [];
    fake.onGraphql("PullRequestReviewState", (request) => {
      const variables = request.body?.variables as Record<string, unknown>;
      calls.push(variables);
      const first = variables.threadsAfter === null;
      return json({
        data: {
          repository: {
            pullRequest: {
              ...(variables.withFiles
                ? {
                    files: {
                      pageInfo: { hasNextPage: false, endCursor: "f1" },
                      nodes: [
                        { path: "src/a.ts", viewerViewedState: "VIEWED" },
                        { path: "src/b.ts", viewerViewedState: "DISMISSED" },
                      ],
                    },
                  }
                : {}),
              reviewThreads: first
                ? {
                    pageInfo: { hasNextPage: true, endCursor: "t1" },
                    nodes: [thread("PRRT_1", "src/a.ts")],
                  }
                : {
                    pageInfo: { hasNextPage: false, endCursor: "t2" },
                    nodes: [
                      thread("PRRT_2", "src/b.ts", {
                        line: null,
                        isOutdated: true,
                        diffSide: "LEFT",
                        isResolved: true,
                      }),
                    ],
                  },
            },
          },
        },
      });
    });

    const result = await getGitHubPullRequestFiles(TOKEN, REF, fake.options);

    expect(fake.unexpected).toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({
        withFiles: true,
        withThreads: true,
        filesAfter: null,
        threadsAfter: null,
        number: 7,
      }),
      expect.objectContaining({ withFiles: false, withThreads: true, threadsAfter: "t1" }),
    ]);
    expect(result.headSha).toBe(HEAD_SHA);
    expect(result.truncated).toBe(false);
    expect(result.files.map((file) => [file.path, file.status, file.viewedState])).toEqual([
      ["src/a.ts", "modified", "viewed"],
      ["src/b.ts", "added", "dismissed"],
    ]);
    expect(result.files[1]?.hunks[0]?.lines).toEqual([
      { type: "add", text: "hello", oldLine: null, newLine: 1 },
    ]);
    expect(
      result.threads.map((entry) => [
        entry.id,
        entry.line,
        entry.side,
        entry.isOutdated,
        entry.isResolved,
      ]),
    ).toEqual([
      ["PRRT_1", 2, "RIGHT", false, false],
      ["PRRT_2", null, "LEFT", true, true],
    ]);
    expect(result.threads[0]?.comments).toEqual([
      {
        id: 11,
        nodeId: "PRRT_1_c1",
        body: "First",
        author: { login: "rev", avatarUrl: undefined, htmlUrl: undefined },
        createdAt: "t1",
        updatedAt: "t1",
        htmlUrl: "u1",
        diffHunk: "@@ -1 +1 @@",
      },
      {
        id: 12,
        nodeId: "PRRT_1_c2",
        body: "Reply",
        author: null,
        createdAt: "t2",
        updatedAt: "t3",
        htmlUrl: "u2",
      },
    ]);
    // File pages are large and never cached.
    expect(fake.cache.size).toBe(1);
  });

  test("reports truncation when GitHub returns fewer files than changed", async () => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", apiPull({ changed_files: 3_500 }));
    fake.on("GET", "/repos/acme/repo/pulls/7/files", [
      { filename: "a", status: "added", patch: "@@ -0,0 +1 @@\n+x" },
    ]);
    fake.onGraphql("PullRequestReviewState", {
      repository: {
        pullRequest: {
          files: { pageInfo: { hasNextPage: false }, nodes: [] },
          reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    });
    const result = await getGitHubPullRequestFiles(TOKEN, REF, fake.options);
    expect(result.truncated).toBe(true);
  });
});

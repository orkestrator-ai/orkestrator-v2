import { describe, expect, test } from "bun:test";
import {
  MAX_SINGLE_FILE_RENDERED_LINES,
  filePatchPageOrder,
  fileStatusFromApi,
  getGitHubPullRequestFilePatch,
  getGitHubPullRequestFiles,
  mapPullRequestFiles,
  parsePullRequestFilePatch,
} from "../src/core/git/github-pull-request-files";
import {
  BASE,
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
    // Only the file left out for the budget can be loaded on its own.
    expect(files.map((file) => file.patchDeferred ?? false)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  test("defers a patch over the list's per-file cap but not one too large to load alone", () => {
    const rows = (count: number) =>
      `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+l${i}`).join("\n")}`;
    const files = mapPullRequestFiles(
      [
        { filename: "medium.ts", status: "added", additions: 3_500, patch: rows(3_500) },
        {
          filename: "giant.ts",
          status: "added",
          additions: MAX_SINGLE_FILE_RENDERED_LINES + 1,
          patch: rows(MAX_SINGLE_FILE_RENDERED_LINES + 1),
        },
      ],
      new Map(),
    );
    expect(files.map((file) => [file.path, file.patchAvailable, file.patchDeferred])).toEqual([
      ["medium.ts", false, true],
      ["giant.ts", false, undefined],
    ]);
  });
});

describe("getGitHubPullRequestFilePatch", () => {
  const filePage = (names: string[]) =>
    names.map((filename) => ({
      filename,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: PATCH,
    }));

  test("reads the page the index names first, at the requested head", async () => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
    fake.on("GET", "/repos/acme/repo/pulls/7/files", (request) =>
      json(
        request.url.searchParams.get("page") === "3"
          ? filePage(["deep/nested/file.ts"])
          : filePage(Array.from({ length: 100 }, (_, i) => `other-${i}`)),
      ),
    );
    const result = await getGitHubPullRequestFilePatch(
      TOKEN,
      REF,
      { path: "deep/nested/file.ts", headSha: HEAD_SHA, comparisonBase: BASE, index: 205 },
      fake.options,
    );
    expect(result).toMatchObject({
      outcome: "loaded",
      patchAvailable: true,
      headSha: HEAD_SHA,
      comparisonBase: BASE,
    });
    expect(result.hunks[0]?.lines).toHaveLength(5);
    const pages = fake
      .requestsTo("GET", "/repos/acme/repo/pulls/7/files")
      .map((request) => request.url.searchParams.get("page"));
    expect(pages).toEqual(["3"]);
    // Two uncached head reads bracket the page.
    expect(fake.requestsTo("GET", "/repos/acme/repo/pulls/7")).toHaveLength(2);
    expect(fake.cache.size).toBe(0);
  });

  test("falls back to the other pages and stops after the last one", async () => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
    fake.on("GET", "/repos/acme/repo/pulls/7/files", (request) => {
      const page = request.url.searchParams.get("page");
      return json(
        page === "1"
          ? filePage(Array.from({ length: 100 }, (_, i) => `a-${i}`))
          : page === "2"
            ? filePage(["b"])
            : [],
      );
    });
    const missing = await getGitHubPullRequestFilePatch(
      TOKEN,
      REF,
      { path: "nowhere.ts", headSha: HEAD_SHA, comparisonBase: BASE, index: 0 },
      fake.options,
    );
    expect(missing).toMatchObject({ outcome: "not-found", patchAvailable: false, hunks: [] });
    expect(
      fake
        .requestsTo("GET", "/repos/acme/repo/pulls/7/files")
        .map((request) => request.url.searchParams.get("page")),
    ).toEqual(["1", "2"]);
    expect(filePatchPageOrder(250).slice(0, 3)).toEqual([3, 1, 2]);
    expect(filePatchPageOrder(undefined)).toHaveLength(30);
  });

  test("answers head-moved when the head is not the requested one, before or after", async () => {
    const fake = createFakeGitHub();
    let head = "b".repeat(40);
    fake.on("GET", "/repos/acme/repo/pulls/7", () => json(apiPull({ head: { sha: head } })));
    fake.on("GET", "/repos/acme/repo/pulls/7/files", () => {
      head = "c".repeat(40);
      return json(filePage(["a.ts"]));
    });
    const before = await getGitHubPullRequestFilePatch(
      TOKEN,
      REF,
      { path: "a.ts", headSha: HEAD_SHA, comparisonBase: BASE },
      fake.options,
    );
    expect(before).toMatchObject({ outcome: "head-moved", headSha: "b".repeat(40), hunks: [] });
    expect(fake.requestsTo("GET", "/repos/acme/repo/pulls/7/files")).toHaveLength(0);

    const after = await getGitHubPullRequestFilePatch(
      TOKEN,
      REF,
      { path: "a.ts", headSha: "b".repeat(40), comparisonBase: BASE },
      fake.options,
    );
    expect(after).toMatchObject({ outcome: "head-moved", headSha: "c".repeat(40), hunks: [] });
  });

  test.each([
    { ref: "release", sha: "e".repeat(40) },
    { ref: "release", sha: BASE.sha },
    { ref: BASE.ref, sha: "e".repeat(40) },
  ])("discards the previous patch when the base changes to %j at the same head", async (base) => {
    const fake = createFakeGitHub();
    let currentBase = BASE;
    fake.on("GET", "/repos/acme/repo/pulls/7", () => json(apiPull({ base: currentBase })));
    fake.on("GET", "/repos/acme/repo/pulls/7/files", () => {
      const entries = filePage(["a.ts"]);
      const patch = currentBase === BASE ? PATCH : "@@ -0,0 +9 @@\n+retargeted";
      currentBase = base;
      return json(entries.map((file) => ({ ...file, patch })));
    });
    const input = { path: "a.ts", headSha: HEAD_SHA, comparisonBase: BASE };
    const after = await getGitHubPullRequestFilePatch(TOKEN, REF, input, fake.options);
    expect(after).toMatchObject({
      outcome: "head-moved",
      headSha: HEAD_SHA,
      comparisonBase: base,
      hunks: [],
    });
    const before = await getGitHubPullRequestFilePatch(TOKEN, REF, input, fake.options);
    expect(before).toEqual(after);
    expect(fake.requestsTo("GET", "/repos/acme/repo/pulls/7/files")).toHaveLength(1);
    const current = await getGitHubPullRequestFilePatch(
      TOKEN,
      REF,
      { ...input, comparisonBase: base },
      fake.options,
    );
    expect(current.outcome).toBe("loaded");
    expect(current.hunks[0]?.lines[0]).toMatchObject({ text: "retargeted", newLine: 9 });
  });

  test.each([
    ["binary.png", { status: "added" }, false],
    ["renamed.ts", { status: "renamed" }, true],
    ["copied.ts", { status: "copied" }, true],
    [
      "large.ts",
      {
        status: "added",
        patch:
          `@@ -0,0 +1,${MAX_SINGLE_FILE_RENDERED_LINES + 1} @@\n` +
          "+line\n".repeat(MAX_SINGLE_FILE_RENDERED_LINES + 1),
      },
      false,
    ],
  ] as const)("reports patch availability for %s", async (path, file, available) => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
    fake.on("GET", "/repos/acme/repo/pulls/7/files", [
      { filename: path, additions: 0, deletions: 0, ...file },
    ]);
    const result = await getGitHubPullRequestFilePatch(
      TOKEN,
      REF,
      { path, headSha: HEAD_SHA, comparisonBase: BASE },
      fake.options,
    );
    expect(result).toMatchObject({ outcome: "loaded", patchAvailable: available, hunks: [] });
  });

  test("refuses a missing path or a head that is not a commit SHA", async () => {
    const fake = createFakeGitHub();
    await expect(
      getGitHubPullRequestFilePatch(
        TOKEN,
        REF,
        { path: "", headSha: HEAD_SHA, comparisonBase: BASE },
        fake.options,
      ),
    ).rejects.toThrow("path");
    await expect(
      getGitHubPullRequestFilePatch(
        TOKEN,
        REF,
        { path: "a", headSha: "main", comparisonBase: BASE },
        fake.options,
      ),
    ).rejects.toThrow("headSha");
    expect(fake.requests).toHaveLength(0);
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
    expect(fake.cache.size).toBe(0);
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

test("retries files when a push changes the head during pagination", async () => {
  const fake = createFakeGitHub();
  let head = HEAD_SHA;
  let loads = 0;
  fake.on("GET", "/repos/acme/repo/pulls/7", () => json(apiPull({ head: { sha: head } })));
  fake.on("GET", "/repos/acme/repo/pulls/7/files", (request) => {
    const second = request.url.searchParams.get("page") === "2";
    if (second) head = "b".repeat(40);
    else loads++;
    return json(
      [{ filename: second ? "b" : "a", status: "added", patch: `@@ -0,0 +1 @@\n+${head}` }],
      {
        headers: second
          ? {}
          : { link: '<https://api.github.com/repos/acme/repo/pulls/7/files?page=2>; rel="next"' },
      },
    );
  });
  fake.onGraphql("PullRequestReviewState", {
    repository: { pullRequest: { files: { nodes: [] }, reviewThreads: { nodes: [] } } },
  });
  const result = await getGitHubPullRequestFiles(TOKEN, REF, fake.options);
  expect(loads).toBe(2);
  expect(result.headSha).toBe("b".repeat(40));
  expect(result.files[0]?.hunks[0]?.lines[0]?.text).toBe(result.headSha);
  expect(fake.unexpected).toEqual([]);
});

test("retries the file list when the base is retargeted at the same head", async () => {
  const fake = createFakeGitHub();
  const retargeted = { ref: "release", sha: "e".repeat(40) };
  let base = BASE;
  fake.on("GET", "/repos/acme/repo/pulls/7", () => json(apiPull({ base })));
  fake.on("GET", "/repos/acme/repo/pulls/7/files", () => {
    const patch = `@@ -0,0 +1 @@\n+${base.ref}`;
    base = retargeted;
    return json([{ filename: "a.ts", status: "added", patch }]);
  });
  fake.onGraphql("PullRequestReviewState", {
    repository: { pullRequest: { files: { nodes: [] }, reviewThreads: { nodes: [] } } },
  });
  const result = await getGitHubPullRequestFiles(TOKEN, REF, fake.options);
  expect(result).toMatchObject({ headSha: HEAD_SHA, comparisonBase: retargeted });
  expect(result.files[0]?.hunks[0]?.lines[0]?.text).toBe("release");
  expect(fake.requestsTo("GET", "/repos/acme/repo/pulls/7/files")).toHaveLength(2);
});

test("long threads disclose omitted newer replies after reload", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
  fake.on("GET", "/repos/acme/repo/pulls/7/files", []);
  let total = 101;
  fake.onGraphql("PullRequestReviewState", () =>
    json({
      data: {
        repository: {
          pullRequest: {
            files: { nodes: [] },
            reviewThreads: {
              nodes: [
                {
                  id: "thread",
                  path: "a",
                  comments: {
                    pageInfo: { hasNextPage: total > 100 },
                    nodes: Array.from({ length: 100 }, (_, i) => ({
                      id: `c${i}`,
                      databaseId: i + 1,
                      body: `reply ${i}`,
                    })),
                  },
                },
              ],
            },
          },
        },
      },
    }),
  );
  for (total of [101, 102]) {
    const result = await getGitHubPullRequestFiles(TOKEN, REF, fake.options);
    expect(result.threads[0]?.comments).toHaveLength(100);
    expect(result.threads[0]?.commentsTruncated).toBe(true);
  }
});

test("rejects an unstable head after bounded retries instead of returning comment coordinates", async () => {
  const fake = createFakeGitHub();
  let revision = 0;
  fake.on("GET", "/repos/acme/repo/pulls/7", () =>
    json(apiPull({ head: { sha: (++revision).toString(16).padStart(40, "0") } })),
  );
  fake.on("GET", "/repos/acme/repo/pulls/7/files", []);
  fake.onGraphql("PullRequestReviewState", {
    repository: { pullRequest: { files: { nodes: [] }, reviewThreads: { nodes: [] } } },
  });
  await expect(getGitHubPullRequestFiles(TOKEN, REF, fake.options)).rejects.toThrow(
    "changed while loading files",
  );
  expect(fake.requestsTo("GET", "/repos/acme/repo/pulls/7/files")).toHaveLength(3);
});

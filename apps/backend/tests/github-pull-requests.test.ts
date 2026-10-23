import { describe, expect, test } from "bun:test";
import {
  buildPullRequestSearchQuery,
  createGitHubConditionalCache,
  getGitHubPullRequest,
  listGitHubPullRequests,
  mergeabilityFromApi,
  mergeChecks,
  rollUpChecks,
} from "../src/core/github-pull-requests";
import {
  HEAD_SHA,
  REF,
  TOKEN,
  apiUser,
  createFakeGitHub,
  json,
  routePullRequestDetail,
} from "./github-pull-request-fixtures";

const repository = { owner: "acme", repo: "repo" };

describe("pull request list", () => {
  test.each([
    ["open", "repo:acme/repo is:pr is:open sort:updated-desc"],
    ["closed", "repo:acme/repo is:pr is:closed sort:updated-desc"],
    ["mine", "repo:acme/repo is:pr is:open author:@me sort:updated-desc"],
    ["review-requested", "repo:acme/repo is:pr is:open review-requested:@me sort:updated-desc"],
  ] as const)("builds the %s search", (filter, expected) => {
    expect(buildPullRequestSearchQuery(repository, filter)).toBe(expected);
  });

  test("appends free text but drops qualifiers that widen the scope", () => {
    expect(
      buildPullRequestSearchQuery(
        repository,
        "open",
        "  fix  repo:evil/x ORG:evil sort:created label:bug ",
      ),
    ).toBe("repo:acme/repo is:pr is:open fix label:bug sort:updated-desc");
  });

  test("maps one GraphQL search into list items", async () => {
    const fake = createFakeGitHub();
    let variables: Record<string, unknown> = {};
    fake.onGraphql("PullRequestList", (request) => {
      variables = request.body?.variables as Record<string, unknown>;
      return json({
        data: {
          viewer: {
            login: "viewer",
            avatarUrl: "https://avatars.example/viewer",
            url: "https://github.com/viewer",
          },
          repository: { nameWithOwner: "Acme/Repo", url: "https://github.com/Acme/Repo" },
          search: {
            issueCount: 140,
            nodes: [
              {
                __typename: "PullRequest",
                number: 7,
                title: "Add widgets",
                url: "https://github.com/Acme/Repo/pull/7",
                state: "OPEN",
                isDraft: true,
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-10-02T00:00:00Z",
                headRefName: "feature",
                baseRefName: "main",
                author: { login: "author", avatarUrl: null, url: "https://github.com/author" },
                repository: { nameWithOwner: "Acme/Repo" },
                comments: { totalCount: 4 },
                labels: { nodes: [{ name: "bug", color: "ff0000", description: null }] },
                commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
              },
              {
                __typename: "PullRequest",
                number: 6,
                title: "Merged",
                url: "https://github.com/Acme/Repo/pull/6",
                state: "MERGED",
                isDraft: false,
                createdAt: "2026-09-01T00:00:00Z",
                updatedAt: "2026-09-02T00:00:00Z",
                headRefName: "old",
                baseRefName: "main",
                author: null,
                repository: { nameWithOwner: "acme/repo" },
                comments: { totalCount: 0 },
                labels: { nodes: [] },
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              },
              {
                __typename: "PullRequest",
                number: 99,
                url: "https://github.com/other/x/pull/99",
                repository: { nameWithOwner: "other/x" },
              },
              { __typename: "Issue" },
            ],
          },
        },
      });
    });

    const result = await listGitHubPullRequests(TOKEN, repository, "mine", "widgets", fake.options);

    expect(fake.unexpected).toEqual([]);
    expect(variables).toMatchObject({
      owner: "acme",
      name: "repo",
      first: 100,
      query: "repo:acme/repo is:pr is:open author:@me widgets sort:updated-desc",
    });
    expect(result.repository).toEqual({
      owner: "Acme",
      repo: "Repo",
      fullName: "Acme/Repo",
      htmlUrl: "https://github.com/Acme/Repo",
    });
    expect(result.viewer.login).toBe("viewer");
    expect(result.filter).toBe("mine");
    expect(result.hasMore).toBe(true);
    expect(result.pullRequests.map((item) => item.number)).toEqual([7, 6]);
    expect(result.pullRequests[0]).toMatchObject({
      state: "open",
      isDraft: true,
      headRef: "feature",
      baseRef: "main",
      commentsCount: 4,
      checksState: "failure",
      labels: [{ name: "bug", color: "ff0000" }],
      author: { login: "author" },
    });
    expect(result.pullRequests[1]).toMatchObject({
      state: "merged",
      checksState: "none",
      author: null,
    });
  });

  test("reports GraphQL errors with GitHub's message", async () => {
    const fake = createFakeGitHub();
    fake.onGraphql("PullRequestList", () =>
      json({
        data: null,
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository." }],
      }),
    );
    await expect(
      listGitHubPullRequests(TOKEN, repository, "open", undefined, fake.options),
    ).rejects.toMatchObject({
      code: "not-found",
      message: expect.stringContaining("Could not resolve to a Repository"),
    });
  });
});

describe("pull request detail", () => {
  test("maps reviewers by latest decisive state, checks, comments and permissions", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake, {
      reviews: [
        { user: apiUser("alice"), state: "APPROVED" },
        { user: apiUser("bob"), state: "COMMENTED" },
        { user: apiUser("carol"), state: "CHANGES_REQUESTED" },
        { user: apiUser("alice"), state: "COMMENTED" },
        { user: apiUser("author"), state: "COMMENTED" },
        { user: apiUser("carol"), state: "DISMISSED" },
        { user: apiUser("rita"), state: "CHANGES_REQUESTED" },
        { user: apiUser("dave"), state: "PENDING" },
      ],
      comments: [
        {
          id: 1,
          node_id: "IC_1",
          body: "Mine",
          html_url: "https://github.com/acme/repo/pull/7#issuecomment-1",
          user: apiUser("viewer"),
          created_at: "2026-10-01T01:00:00Z",
          updated_at: "2026-10-01T02:00:00Z",
        },
        {
          id: 2,
          body: "Theirs",
          html_url: "https://github.com/acme/repo/pull/7#issuecomment-2",
          user: apiUser("someone"),
          created_at: "2026-10-01T03:00:00Z",
          updated_at: "2026-10-01T03:00:00Z",
        },
      ],
      repository: { permissions: { push: false } },
    });
    fake.on("GET", `/repos/acme/repo/commits/${HEAD_SHA}/check-runs`, {
      total_count: 4,
      check_runs: [
        {
          name: "build",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-10-01T00:00:00Z",
          app: { name: "GitHub Actions" },
        },
        {
          name: "build",
          status: "completed",
          conclusion: "success",
          started_at: "2026-10-01T05:00:00Z",
          details_url: "https://ci.example/build",
          output: { title: "Passed" },
          app: { name: "GitHub Actions" },
        },
        {
          name: "lint",
          status: "in_progress",
          conclusion: null,
          started_at: "2026-10-01T05:00:00Z",
        },
      ],
    });
    fake.on("GET", `/repos/acme/repo/commits/${HEAD_SHA}/status`, {
      state: "failure",
      statuses: [
        {
          context: "ci/legacy",
          state: "error",
          target_url: "https://legacy.example",
          description: "Broke",
        },
        { context: "lint", state: "success" },
      ],
    });

    const detail = await getGitHubPullRequest(TOKEN, REF, fake.options);

    expect(fake.unexpected).toEqual([]);
    expect(detail.reviewers).toEqual([
      {
        login: "alice",
        kind: "user",
        avatarUrl: "https://avatars.example/alice",
        requested: false,
        state: "approved",
      },
      {
        login: "bob",
        kind: "user",
        avatarUrl: "https://avatars.example/bob",
        requested: false,
        state: "commented",
      },
      {
        login: "carol",
        kind: "user",
        avatarUrl: "https://avatars.example/carol",
        requested: false,
        state: "dismissed",
      },
      {
        login: "rita",
        kind: "user",
        avatarUrl: "https://avatars.example/rita",
        requested: true,
        state: "changes-requested",
      },
      {
        login: "dave",
        kind: "user",
        avatarUrl: "https://avatars.example/dave",
        requested: false,
        state: "pending",
      },
      { login: "acme/core", kind: "team", requested: true },
    ]);
    expect(detail.checks).toEqual([
      {
        name: "build",
        context: "GitHub Actions",
        conclusion: "success",
        detailsUrl: "https://ci.example/build",
        summary: "Passed",
      },
      {
        name: "ci/legacy",
        conclusion: "failure",
        detailsUrl: "https://legacy.example",
        summary: "Broke",
      },
      {
        name: "lint",
        context: undefined,
        conclusion: "pending",
        detailsUrl: undefined,
        summary: undefined,
      },
      { name: "lint", conclusion: "success", detailsUrl: undefined, summary: undefined },
    ]);
    expect(detail.checksState).toBe("failure");
    expect(
      detail.comments.map((comment) => [comment.id, comment.canEdit, comment.isEdited]),
    ).toEqual([
      [1, true, true],
      [2, false, false],
    ]);
    expect(detail.comments[0]?.nodeId).toBe("IC_1");
    expect(detail).toMatchObject({
      ref: REF,
      nodeId: "PR_node7",
      state: "open",
      headRef: "feature/widgets",
      headSha: HEAD_SHA,
      baseRef: "main",
      isCrossRepository: false,
      headRepositoryFullName: null,
      mergeability: "blocked",
      allowedMergeMethods: ["merge", "squash"],
      viewer: { login: "viewer" },
      viewerPermissions: { canWrite: false, canMerge: false, isAuthor: false },
      labels: [{ name: "bug", color: "ff0000", description: "Broken" }],
      assignees: [{ login: "ann" }],
      commitsCount: 3,
      reviewCommentsCount: 2,
    });
  });

  test("marks forks as cross-repository and merged pull requests as unavailable to merge", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake, {
      pull: {
        merged: true,
        merged_at: "2026-10-03T00:00:00Z",
        state: "closed",
        merged_by: apiUser("viewer"),
        user: apiUser("viewer"),
        head: { ref: "patch", sha: HEAD_SHA, repo: { full_name: "fork/repo" } },
        mergeable_state: "clean",
      },
    });
    const detail = await getGitHubPullRequest(TOKEN, REF, fake.options);
    expect(detail).toMatchObject({
      state: "merged",
      mergedBy: { login: "viewer" },
      isCrossRepository: true,
      headRepositoryFullName: "fork/repo",
      mergeability: "unavailable",
      checksState: "none",
      viewerPermissions: { canWrite: true, canMerge: false, isAuthor: true },
    });
  });

  test("still loads when the token cannot read checks", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake);
    fake.on("GET", `/repos/acme/repo/commits/${HEAD_SHA}/check-runs`, () =>
      json({ message: "Resource not accessible by personal access token" }, { status: 403 }),
    );
    const detail = await getGitHubPullRequest(TOKEN, REF, fake.options);
    expect(detail.checks).toEqual([]);
  });

  test.each([
    ["clean", "clean"],
    ["has_hooks", "clean"],
    ["blocked", "blocked"],
    ["dirty", "dirty"],
    ["behind", "behind"],
    ["unstable", "unstable"],
    ["unknown", "unknown"],
    [null, "unknown"],
    ["draft", "unavailable"],
  ] as const)("maps mergeable_state %s to %s", (mergeableState, expected) => {
    expect(mergeabilityFromApi({ mergeable_state: mergeableState }, "open", false)).toBe(expected);
  });

  test("mergeability is unavailable for drafts and closed pull requests", () => {
    expect(mergeabilityFromApi({ mergeable_state: "clean" }, "open", true)).toBe("unavailable");
    expect(mergeabilityFromApi({ mergeable_state: "clean" }, "closed", false)).toBe("unavailable");
  });

  test("rolls up check conclusions", () => {
    const check = (conclusion: Parameters<typeof rollUpChecks>[0][number]["conclusion"]) => ({
      name: conclusion,
      conclusion,
    });
    expect(rollUpChecks([])).toBe("none");
    expect(rollUpChecks([check("success"), check("cancelled")])).toBe("failure");
    expect(rollUpChecks([check("success"), check("timed-out")])).toBe("failure");
    expect(rollUpChecks([check("success"), check("pending")])).toBe("pending");
    expect(rollUpChecks([check("success"), check("skipped")])).toBe("success");
    expect(rollUpChecks([check("neutral"), check("skipped")])).toBe("neutral");
    expect(
      mergeChecks(
        [{ name: "x", status: "completed", conclusion: "startup_failure" }],
        [{ context: "X", state: "success" }],
      ).map((entry) => entry.conclusion),
    ).toEqual(["failure", "success"]);
  });

  test("rejects refs that are not a valid pull request before any request", async () => {
    const fake = createFakeGitHub();
    for (const ref of [
      { owner: "..", repo: "repo", number: 1 },
      { owner: "acme", repo: "a/b", number: 1 },
      { owner: "acme", repo: "repo", number: 0 },
      { owner: "acme", repo: "repo", number: 1.5 },
    ]) {
      await expect(getGitHubPullRequest(TOKEN, ref, fake.options)).rejects.toMatchObject({
        code: "validation",
      });
    }
    expect(fake.requests).toEqual([]);
  });
});

describe("conditional request cache", () => {
  test("revalidates polled reads with If-None-Match and reuses the body on 304", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake);
    let title = "First";
    fake.on("GET", "/repos/acme/repo/pulls/7", (request) => {
      if (request.headers.get("if-none-match") === '"v1"')
        return new Response(null, { status: 304 });
      return json({ ...pullWithTitle(title) }, { headers: { etag: '"v1"' } });
    });

    const first = await getGitHubPullRequest(TOKEN, REF, fake.options);
    title = "Changed upstream but still 304";
    const second = await getGitHubPullRequest(TOKEN, REF, fake.options);

    const pullRequests = fake.requestsTo("GET", "/repos/acme/repo/pulls/7");
    expect(pullRequests).toHaveLength(2);
    expect(pullRequests[0]?.headers.get("if-none-match")).toBeNull();
    expect(pullRequests[1]?.headers.get("if-none-match")).toBe('"v1"');
    expect(second.title).toBe("First");
    expect(second).toEqual(first);
    for (const request of fake.requests) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("keys entries by credential and never stores the raw token", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake);
    fake.on("GET", "/repos/acme/repo/pulls/7", () =>
      json(pullWithTitle("T"), { headers: { etag: '"v1"' } }),
    );
    await getGitHubPullRequest(TOKEN, REF, fake.options);
    await getGitHubPullRequest("ghp_other_token", REF, fake.options);
    const pullRequests = fake.requestsTo("GET", "/repos/acme/repo/pulls/7");
    expect(pullRequests[1]?.headers.get("if-none-match")).toBeNull();
    const keys: string[] = [];
    const probe = createGitHubConditionalCache();
    const originalSet = probe.set.bind(probe);
    probe.set = (key, entry) => {
      keys.push(key);
      originalSet(key, entry);
    };
    await getGitHubPullRequest(TOKEN, REF, { fetchImpl: fake.fetchImpl, cache: probe });
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain(TOKEN);
    }
  });

  test("evicts least recently used entries by count and skips oversized bodies", () => {
    const cache = createGitHubConditionalCache({ maxEntries: 2, maxBytes: 100, maxEntryBytes: 60 });
    const entry = (size: number) => ({ etag: "e", data: null, link: null, size });
    cache.set("a", entry(10));
    cache.set("b", entry(10));
    cache.get("a");
    cache.set("c", entry(10));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    cache.set("big", entry(61));
    expect(cache.get("big")).toBeUndefined();
    cache.set("d", entry(50));
    cache.set("e", entry(55));
    expect(cache.size).toBe(1);
    expect(cache.get("e")).toBeDefined();
  });
});

function pullWithTitle(title: string) {
  return {
    number: 7,
    node_id: "PR_node7",
    title,
    body: "",
    html_url: "https://github.com/acme/repo/pull/7",
    state: "open",
    user: apiUser("author"),
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    head: { ref: "feature", sha: HEAD_SHA, repo: { full_name: "acme/repo" } },
    base: { ref: "main", repo: { full_name: "acme/repo" } },
  };
}

test("same-named checks from different apps and legacy contexts remain independent", () => {
  const checks = mergeChecks(
    [
      { id: 1, name: "build", app: { id: 1 }, status: "completed", conclusion: "failure" },
      { id: 2, name: "build", app: { id: 2 }, status: "completed", conclusion: "success" },
    ],
    [{ context: "build", state: "pending" }],
  );
  expect(checks).toHaveLength(3);
  expect(rollUpChecks(checks)).toBe("failure");
  const legacyFailure = mergeChecks(
    [{ id: 3, name: "test", app: { id: 1 }, status: "completed", conclusion: "success" }],
    [{ context: "test", state: "failure" }],
  );
  expect(legacyFailure).toHaveLength(2);
  expect(rollUpChecks(legacyFailure)).toBe("failure");
});

test("comment caps disclose omitted newer comments after a new comment is posted", async () => {
  const fake = createFakeGitHub();
  routePullRequestDetail(fake);
  let total = 501;
  fake.on("GET", "/repos/acme/repo/issues/7/comments", (request) => {
    const page = Number(request.url.searchParams.get("page") ?? 1);
    const start = (page - 1) * 100;
    return json(
      Array.from({ length: Math.min(100, total - start) }, (_, i) => ({
        id: start + i + 1,
        created_at: "2026-10-01T00:00:00Z",
        html_url: `https://github.com/acme/repo/pull/7#issuecomment-${start + i + 1}`,
        body: `comment ${start + i + 1}`,
      })),
      {
        headers:
          page * 100 < total
            ? {
                link: `<https://api.github.com/repos/acme/repo/issues/7/comments?per_page=100&page=${page + 1}>; rel="next"`,
              }
            : {},
      },
    );
  });
  for (total of [501, 502]) {
    const detail = await getGitHubPullRequest(TOKEN, REF, fake.options);
    expect(detail.comments).toHaveLength(500);
    expect(detail.commentsTruncated).toBe(true);
  }
});

test("same-app check IDs remain distinct while repeated API IDs update in place", () => {
  const checks = mergeChecks(
    [
      { id: 1, app: { id: 5 }, name: "test", status: "in_progress", started_at: "t1" },
      {
        id: 2,
        app: { id: 5 },
        name: "test",
        status: "completed",
        conclusion: "failure",
        started_at: "t1",
        completed_at: "t2",
      },
      {
        id: 1,
        app: { id: 5 },
        name: "test",
        status: "completed",
        conclusion: "success",
        started_at: "t1",
        completed_at: "t2",
      },
    ],
    [],
  );
  expect(checks).toHaveLength(2);
  expect(checks.map((x) => x.conclusion)).toEqual(["success", "failure"]);
  expect(rollUpChecks(checks)).toBe("failure");
});

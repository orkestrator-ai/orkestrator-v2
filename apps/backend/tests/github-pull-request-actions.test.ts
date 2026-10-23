import { describe, expect, test } from "bun:test";
import {
  addGitHubPullRequestReviewComment,
  mergeGitHubPullRequest,
  replyGitHubPullRequestReviewThread,
  reviewerPayload,
  setGitHubPullRequestFileViewed,
  setGitHubPullRequestLabels,
  setGitHubPullRequestReviewers,
  setGitHubPullRequestThreadResolved,
  submitGitHubPullRequestReview,
  updateGitHubPullRequestComment,
  updateGitHubPullRequestState,
} from "../src/core/github-pull-request-actions";
import {
  HEAD_SHA,
  REF,
  TOKEN,
  apiPull,
  apiUser,
  createFakeGitHub,
  json,
  routePullRequestDetail,
} from "./github-pull-request-fixtures";

const MERGE_PATH = "/repos/acme/repo/pulls/7/merge";
const BRANCH_PATH = "/repos/acme/repo/git/refs/heads/feature/widgets";

describe("mergeGitHubPullRequest", () => {
  test("merges with the expected head SHA and deletes a same-repository branch", async () => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
    fake.on("PUT", MERGE_PATH, {
      merged: true,
      sha: "b".repeat(40),
      message: "Pull Request successfully merged",
    });
    fake.on("DELETE", BRANCH_PATH, () => new Response(null, { status: 204 }));

    const result = await mergeGitHubPullRequest(
      TOKEN,
      REF,
      { method: "squash", deleteBranch: true, expectedHeadSha: HEAD_SHA },
      fake.options,
    );

    expect(fake.unexpected).toEqual([]);
    expect(fake.requestsTo("PUT", MERGE_PATH)[0]?.body).toEqual({
      merge_method: "squash",
      sha: HEAD_SHA,
    });
    expect(fake.requestsTo("DELETE", BRANCH_PATH)).toHaveLength(1);
    expect(result).toEqual({
      merged: true,
      sha: "b".repeat(40),
      message: "Pull Request successfully merged",
      branchDeleted: true,
    });
  });

  test("never deletes a fork's branch and does not load the PR when keeping the branch", async () => {
    const fake = createFakeGitHub();
    fake.on(
      "GET",
      "/repos/acme/repo/pulls/7",
      apiPull({ head: { ref: "patch", sha: HEAD_SHA, repo: { full_name: "fork/repo" } } }),
    );
    fake.on("PUT", MERGE_PATH, { merged: true, sha: "b".repeat(40) });
    const forked = await mergeGitHubPullRequest(
      TOKEN,
      REF,
      { method: "merge", deleteBranch: true },
      fake.options,
    );
    expect(forked.branchDeleted).toBe(false);
    expect(fake.requests.some((request) => request.method === "DELETE")).toBe(false);

    const kept = createFakeGitHub();
    kept.on("PUT", MERGE_PATH, { merged: true });
    const result = await mergeGitHubPullRequest(
      TOKEN,
      REF,
      { method: "rebase", deleteBranch: false },
      kept.options,
    );
    expect(result).toEqual({ merged: true, sha: undefined, message: undefined });
    expect(kept.requests.map((request) => request.method)).toEqual(["PUT"]);
  });

  test("treats an already-deleted branch as deleted and a failed delete as a soft failure", async () => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
    fake.on("PUT", MERGE_PATH, { merged: true });
    fake.on("DELETE", BRANCH_PATH, () =>
      json({ message: "Reference does not exist" }, { status: 422 }),
    );
    expect(
      (
        await mergeGitHubPullRequest(
          TOKEN,
          REF,
          { method: "merge", deleteBranch: true },
          fake.options,
        )
      ).branchDeleted,
    ).toBe(true);

    fake.on("DELETE", BRANCH_PATH, () => json({ message: "boom" }, { status: 500 }));
    const result = await mergeGitHubPullRequest(
      TOKEN,
      REF,
      { method: "merge", deleteBranch: true },
      fake.options,
    );
    expect(result).toMatchObject({
      merged: true,
      branchDeleted: false,
      message: expect.stringContaining("could not delete"),
    });
  });

  test("surfaces GitHub's reason when it refuses the merge", async () => {
    const fake = createFakeGitHub();
    fake.on("PUT", MERGE_PATH, () =>
      json(
        { message: "Head branch was modified. Review and try the merge again." },
        { status: 409 },
      ),
    );
    await expect(
      mergeGitHubPullRequest(
        TOKEN,
        REF,
        { method: "merge", deleteBranch: false, expectedHeadSha: HEAD_SHA },
        fake.options,
      ),
    ).rejects.toThrow("Head branch was modified");
  });

  test("validates the method and head SHA before any request", async () => {
    const fake = createFakeGitHub();
    await expect(
      mergeGitHubPullRequest(
        TOKEN,
        REF,
        { method: "fast-forward" as never, deleteBranch: false },
        fake.options,
      ),
    ).rejects.toThrow("Merge method");
    await expect(
      mergeGitHubPullRequest(
        TOKEN,
        REF,
        { method: "merge", deleteBranch: false, expectedHeadSha: "abc" },
        fake.options,
      ),
    ).rejects.toThrow("full commit SHA");
    expect(fake.requests).toEqual([]);
  });
});

describe("reviews", () => {
  test("requires a body for change requests and comment-only reviews", async () => {
    const fake = createFakeGitHub();
    await expect(
      submitGitHubPullRequestReview(
        TOKEN,
        REF,
        { event: "REQUEST_CHANGES", body: "  " },
        fake.options,
      ),
    ).rejects.toThrow("Requesting changes needs");
    await expect(
      submitGitHubPullRequestReview(TOKEN, REF, { event: "COMMENT", body: "" }, fake.options),
    ).rejects.toThrow("comment review needs");
    await expect(
      submitGitHubPullRequestReview(
        TOKEN,
        REF,
        {
          event: "COMMENT",
          body: "",
          comments: [{ path: "a.ts", line: 3, side: "RIGHT", startLine: 3, body: "x" }],
        },
        fake.options,
      ),
    ).rejects.toThrow("start line");
    await expect(
      submitGitHubPullRequestReview(
        TOKEN,
        REF,
        {
          event: "COMMENT",
          body: "",
          comments: [{ path: "a.ts", line: 3, side: "UP" as never, body: "x" }],
        },
        fake.options,
      ),
    ).rejects.toThrow("LEFT or RIGHT");
    expect(fake.requests).toEqual([]);
  });

  test("submits inline comments in GitHub's shape and returns the review id", async () => {
    const fake = createFakeGitHub();
    fake.on("POST", "/repos/acme/repo/pulls/7/reviews", { id: 321 });
    const result = await submitGitHubPullRequestReview(
      TOKEN,
      REF,
      {
        event: "COMMENT",
        body: "",
        commitId: HEAD_SHA,
        comments: [
          { path: "a.ts", line: 10, side: "RIGHT", startLine: 8, body: "Range" },
          { path: "b.ts", line: 2, side: "LEFT", body: "Old line" },
        ],
      },
      fake.options,
    );
    expect(result).toEqual({ reviewId: 321 });
    expect(fake.requests[0]?.body).toEqual({
      event: "COMMENT",
      commit_id: HEAD_SHA,
      comments: [
        {
          path: "a.ts",
          line: 10,
          side: "RIGHT",
          start_line: 8,
          start_side: "RIGHT",
          body: "Range",
        },
        { path: "b.ts", line: 2, side: "LEFT", body: "Old line" },
      ],
    });
  });

  test("an approval may omit the body", async () => {
    const fake = createFakeGitHub();
    fake.on("POST", "/repos/acme/repo/pulls/7/reviews", { id: 1 });
    await submitGitHubPullRequestReview(TOKEN, REF, { event: "APPROVE", body: "" }, fake.options);
    expect(fake.requests[0]?.body).toEqual({ event: "APPROVE" });
  });

  test("adds a single review comment on a commit", async () => {
    const fake = createFakeGitHub();
    fake.on("POST", "/repos/acme/repo/pulls/7/comments", {
      id: 77,
      node_id: "PRRC_77",
      body: "Nit",
      user: apiUser("viewer"),
      created_at: "t",
      updated_at: "t",
      html_url: "https://github.com/acme/repo/pull/7#discussion_r77",
      diff_hunk: "@@ -1 +1 @@",
    });
    const comment = await addGitHubPullRequestReviewComment(
      TOKEN,
      REF,
      HEAD_SHA,
      { path: "a.ts", line: 1, side: "RIGHT", body: "Nit" },
      fake.options,
    );
    expect(comment).toMatchObject({ id: 77, nodeId: "PRRC_77", diffHunk: "@@ -1 +1 @@" });
    expect(fake.requests[0]?.body).toEqual({
      path: "a.ts",
      line: 1,
      side: "RIGHT",
      body: "Nit",
      commit_id: HEAD_SHA,
    });
  });
});

describe("review threads and viewed files", () => {
  function routeThreadOwner(
    fake: ReturnType<typeof createFakeGitHub>,
    number: number,
    repo = "acme/repo",
  ) {
    fake.onGraphql("ReviewThreadOwner", {
      node: {
        __typename: "PullRequestReviewThread",
        pullRequest: { number, repository: { nameWithOwner: repo } },
      },
    });
  }

  test("replies and resolves only threads on this pull request", async () => {
    const fake = createFakeGitHub();
    routeThreadOwner(fake, 7, "Acme/Repo");
    fake.onGraphql("ReplyToThread", {
      addPullRequestReviewThreadReply: {
        comment: {
          databaseId: 5,
          id: "PRRC_5",
          body: "Done",
          author: { login: "viewer" },
          createdAt: "t",
          updatedAt: "t",
          url: "u",
        },
      },
    });
    fake.onGraphql("ResolveThread", { resolveReviewThread: { thread: { isResolved: true } } });
    fake.onGraphql("UnresolveThread", { unresolveReviewThread: { thread: { isResolved: false } } });

    expect(
      await replyGitHubPullRequestReviewThread(TOKEN, REF, "PRRT_abc", "Done", fake.options),
    ).toMatchObject({
      id: 5,
      nodeId: "PRRC_5",
      body: "Done",
    });
    expect(
      await setGitHubPullRequestThreadResolved(TOKEN, REF, "PRRT_abc", true, fake.options),
    ).toEqual({ isResolved: true });
    expect(
      await setGitHubPullRequestThreadResolved(TOKEN, REF, "PRRT_abc", false, fake.options),
    ).toEqual({ isResolved: false });

    const other = createFakeGitHub();
    routeThreadOwner(other, 8);
    await expect(
      setGitHubPullRequestThreadResolved(TOKEN, REF, "PRRT_abc", true, other.options),
    ).rejects.toThrow("does not belong to pull request #7");
    await expect(
      setGitHubPullRequestThreadResolved(TOKEN, REF, "bad id!", true, other.options),
    ).rejects.toThrow("not a valid GitHub id");
  });

  test("marks a file viewed with the pull request node id", async () => {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
    let variables: unknown;
    fake.onGraphql("MarkFileViewed", (request) => {
      variables = request.body?.variables;
      return json({ data: { markFileAsViewed: { pullRequest: { id: "PR_node7" } } } });
    });
    expect(
      await setGitHubPullRequestFileViewed(TOKEN, REF, "src/a.ts", true, fake.options),
    ).toEqual({ viewedState: "viewed" });
    expect(variables).toEqual({ id: "PR_node7", path: "src/a.ts" });
  });
});

describe("state, comments, reviewers and labels", () => {
  test("ready-for-review uses GraphQL and returns the refreshed detail", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake, { pull: { draft: true } });
    let id: unknown;
    fake.onGraphql("MarkReady", (request) => {
      id = (request.body?.variables as Record<string, unknown> | undefined)?.id;
      return json({
        data: {
          markPullRequestReadyForReview: { pullRequest: { id: "PR_node7", isDraft: false } },
        },
      });
    });
    const detail = await updateGitHubPullRequestState(TOKEN, REF, "ready-for-review", fake.options);
    expect(id).toBe("PR_node7");
    expect(detail.ref).toEqual(REF);
  });

  test("close patches the pull request state", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake);
    fake.on("PATCH", "/repos/acme/repo/pulls/7", { number: 7 });
    await updateGitHubPullRequestState(TOKEN, REF, "close", fake.options);
    expect(fake.requestsTo("PATCH", "/repos/acme/repo/pulls/7")[0]?.body).toEqual({
      state: "closed",
    });
  });

  test("edits only comments on this pull request", async () => {
    const fake = createFakeGitHub();
    routePullRequestDetail(fake);
    fake.on("GET", "/repos/acme/repo/issues/comments/9", {
      id: 9,
      body: "old",
      user: apiUser("viewer"),
      issue_url: "https://api.github.com/repos/acme/repo/issues/8",
      created_at: "t",
    });
    await expect(
      updateGitHubPullRequestComment(TOKEN, REF, 9, "new", fake.options),
    ).rejects.toThrow("does not belong to pull request #7");
    expect(fake.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  test("splits team reviewers and removes before adding", async () => {
    expect(reviewerPayload(REF, ["alice", "Acme/core", "alice"])).toEqual({
      reviewers: ["alice"],
      team_reviewers: ["core"],
    });
    expect(() => reviewerPayload(REF, ["other/core"])).toThrow("must be a team in acme");
    expect(() => reviewerPayload(REF, ["not a login"])).toThrow("not a valid GitHub login");

    const fake = createFakeGitHub();
    routePullRequestDetail(fake);
    fake.on("DELETE", "/repos/acme/repo/pulls/7/requested_reviewers", {});
    fake.on("POST", "/repos/acme/repo/pulls/7/requested_reviewers", {});
    await setGitHubPullRequestReviewers(
      TOKEN,
      REF,
      { add: ["bob"], remove: ["acme/core"] },
      fake.options,
    );
    const mutations = fake.requests.filter((request) => request.method !== "GET");
    expect(mutations.map((request) => [request.method, request.body])).toEqual([
      ["DELETE", { reviewers: [], team_reviewers: ["core"] }],
      ["POST", { reviewers: ["bob"], team_reviewers: [] }],
    ]);
  });

  test("replaces labels", async () => {
    const fake = createFakeGitHub();
    fake.on("PUT", "/repos/acme/repo/issues/7/labels", [{ name: "bug", color: "f00" }]);
    expect(await setGitHubPullRequestLabels(TOKEN, REF, [" bug ", "bug"], fake.options)).toEqual([
      { name: "bug", color: "f00", description: undefined },
    ]);
    expect(fake.requests[0]?.body).toEqual({ labels: ["bug"] });
    await expect(setGitHubPullRequestLabels(TOKEN, REF, [""], fake.options)).rejects.toThrow(
      "Label names",
    );
  });
});

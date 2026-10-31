import { afterEach, expect, test } from "bun:test";
import type { PublicActionName } from "@orkestrator/protocol/public-api";
import { resetGitHubPullRequestCache } from "../src/core/github-pull-requests.js";
import {
  getPrMonitorDetectionRequest,
  parsePrMonitorDetectionResponse,
} from "../src/core/commands-pr-monitor.js";
import { cleanupSessionHarnesses, setup } from "../src/core/public-api/test-provider.js";
import {
  apiUser,
  createFakeGitHub,
  routePullRequestDetail,
  TOKEN,
} from "./github-pull-request-fixtures.js";

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetGitHubPullRequestCache();
  await cleanupSessionHarnesses();
});

test("public PR actions agree with registered viewer commands and their transport results", async () => {
  const { harness } = await setup();
  const config = await harness.storage.loadConfig();
  await harness.storage.updateGlobalConfig({
    ...config.global,
    useHostGitHubCredentials: false,
    githubToken: TOKEN,
  });
  await harness.storage.updateEnvironment("env-1", {
    prUrl: "https://github.com/acme/repo/pull/7",
    prState: "open",
  });
  const fake = createFakeGitHub();
  globalThis.fetch = fake.fetchImpl;
  resetGitHubPullRequestCache();
  routePullRequestDetail(fake);
  const comment = {
    id: 5,
    node_id: "IC_5",
    body: "Text",
    user: apiUser("viewer"),
    issue_url: "https://api.github.com/repos/acme/repo/issues/7",
    html_url: "https://github.com/acme/repo/pull/7#issuecomment-5",
    created_at: "2026-10-01",
    updated_at: "2026-10-01",
  };
  fake.on("GET", "/repos/acme/repo/issues/7/timeline", []);
  fake.on("GET", "/repos/acme/repo/pulls/7/commits", []);
  fake.on("GET", "/repos/acme/repo/pulls/7/comments", []);
  fake.on("GET", "/repos/acme/repo/pulls/7/files", [
    {
      filename: "a.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
  ]);
  fake.onGraphql("PullRequestReviewState", {
    repository: {
      pullRequest: {
        files: { nodes: [], pageInfo: { hasNextPage: false } },
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      },
    },
  });
  fake.on("GET", "/repos/acme/repo/labels", []);
  fake.on("GET", "/repos/acme/repo/assignees", [apiUser("viewer")]);
  fake.on("PATCH", "/repos/acme/repo/pulls/7", {});
  fake.onGraphql("MarkReady", {});
  fake.onGraphql("ConvertToDraft", {});
  fake.on("POST", "/repos/acme/repo/issues/7/comments", comment);
  fake.on("GET", "/repos/acme/repo/issues/comments/5", comment);
  fake.on("PATCH", "/repos/acme/repo/issues/comments/5", comment);
  fake.on("POST", "/repos/acme/repo/pulls/7/reviews", { id: 12 });
  fake.on("POST", "/repos/acme/repo/pulls/7/comments", { ...comment, node_id: "PRRC_5" });
  fake.onGraphql("ReviewThreadOwner", {
    node: { pullRequest: { number: 7, repository: { nameWithOwner: "acme/repo" } } },
  });
  fake.onGraphql("ReplyToThread", {
    addPullRequestReviewThreadReply: {
      comment: {
        databaseId: 6,
        id: "PRRC_6",
        body: "Reply",
        author: { login: "viewer" },
        createdAt: "2026-10-01",
        updatedAt: "2026-10-01",
        url: "https://github.com/acme/repo/pull/7#discussion_r6",
      },
    },
  });
  fake.onGraphql("ResolveThread", { resolveReviewThread: { thread: { isResolved: true } } });
  fake.onGraphql("MarkFileViewed", {});
  fake.on("POST", "/repos/acme/repo/pulls/7/requested_reviewers", {});
  fake.on("POST", "/repos/acme/repo/issues/7/labels", [{ name: "bug", color: "ff0000" }]);
  let request = 0;
  async function call(
    action: PublicActionName,
    input: Record<string, unknown> = {},
    mutation = false,
  ) {
    const response = await harness.call<Record<string, any>>(
      action,
      { environmentId: "env-1", ...input },
      mutation ? { requestId: `contract-${request++}` } : undefined,
    );
    if (!response.ok) throw new Error(`${action}: ${response.error.message}`);
    return response.result;
  }
  expect((await call("pr.get")).pullRequest.headRef).toBe("feature/widgets");
  expect((await call("pr.timeline")).items[0].kind).toBe("event");
  expect((await call("pr.files", { path: "a.ts" })).file.hunks[0].lines[1].text).toBe("new");
  expect((await call("pr.options")).assignableUsers[0].login).toBe("viewer");
  for (const action of ["pr.close", "pr.reopen", "pr.ready", "pr.draft"] as const)
    expect((await call(action, {}, true)).state).toBe("open");
  expect((await call("pr.comment", { body: "Text" }, true)).commentId).toBe(5);
  expect((await call("pr.comment.edit", { commentId: 5, body: "Edited" }, true)).commentId).toBe(5);
  const inline = { path: "a.ts", line: 1, side: "RIGHT", body: "Inline" };
  expect((await call("pr.review", { event: "COMMENT", comments: [inline] }, true)).reviewId).toBe(
    12,
  );
  expect((await call("pr.review.comment", inline, true)).commentId).toBe(5);
  expect(
    (await call("pr.thread.reply", { threadId: "PRRT_1", body: "Reply" }, true)).commentId,
  ).toBe(6);
  expect((await call("pr.thread.resolve", { threadId: "PRRT_1" }, true)).isResolved).toBe(true);
  expect((await call("pr.file.viewed", { path: "a.ts" }, true)).viewedState).toBe("viewed");
  expect((await call("pr.reviewers", { add: ["viewer"] }, true)).reviewers).toBeArray();
  expect((await call("pr.label", { name: "bug" }, true)).labels[0]).toBe("bug");
  expect(fake.requestsTo("POST", "/repos/acme/repo/pulls/7/reviews")[0]?.body).toMatchObject({
    event: "COMMENT",
    comments: [inline],
  });
  expect(fake.unexpected).toEqual([]);
});

test("a fork returned by branch lookup is neither attached nor mutated", async () => {
  const { harness } = await setup();
  const environment = (await harness.storage.getEnvironment("env-1"))!;
  const request = getPrMonitorDetectionRequest({
    environmentId: environment.id,
    branch: environment.branch,
    kind: "local",
    ready: true,
    worktreePath: environment.worktreePath!,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
  });
  // Exercise the real lookup response parser at the external gh boundary.
  harness.commands.set("detect_pr_local", async () =>
    parsePrMonitorDetectionResponse(
      request,
      JSON.stringify([
        { url: "https://github.com/acme/repo/pull/8", state: "OPEN", isCrossRepository: true },
      ]),
    ),
  );
  const read = await harness.call<Record<string, unknown>>("pr.get", { environmentId: "env-1" });
  expect(read.ok && read.result.attachment).toBe("none");
  for (const action of ["pr.merge", "pr.comment"] as const) {
    const response = await harness.call(
      action,
      { environmentId: "env-1", ...(action === "pr.comment" ? { body: "Text" } : {}) },
      { requestId: action },
    );
    expect(!response.ok && response.error.code).toBe("not-found");
    expect(response.receipt).toBeUndefined();
  }
  expect((await harness.storage.getEnvironment("env-1"))?.prUrl).toBeNull();
});

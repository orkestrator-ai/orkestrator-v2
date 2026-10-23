import { describe, expect, test } from "bun:test";
import { getGitHubPullRequestTimeline } from "../src/core/github-pull-request-timeline";
import {
  REF,
  TOKEN,
  apiPull,
  apiRepository,
  apiUser,
  createFakeGitHub,
  json,
} from "./github-pull-request-fixtures";

const COMMIT = "c".repeat(40);

function routeTimeline(fake: ReturnType<typeof createFakeGitHub>, events: unknown[]) {
  fake.on("GET", "/repos/acme/repo/pulls/7", apiPull());
  fake.on("GET", "/repos/acme/repo/issues/7/timeline", events);
  fake.on("GET", "/repos/acme/repo", apiRepository({ permissions: { push: false } }));
  fake.on("GET", "/user", apiUser("viewer"));
  fake.on("GET", "/repos/acme/repo/pulls/7/commits", [{ sha: COMMIT, author: apiUser("coder") }]);
  fake.on("GET", "/repos/acme/repo/pulls/7/comments", [
    { id: 1, pull_request_review_id: 50 },
    { id: 2, pull_request_review_id: 50 },
    { id: 3, pull_request_review_id: 51 },
  ]);
}

describe("getGitHubPullRequestTimeline", () => {
  test("maps commits, comments, reviews and events after a synthetic opened event", async () => {
    const fake = createFakeGitHub();
    routeTimeline(fake, [
      {
        event: "committed",
        sha: COMMIT,
        message: "Add widgets",
        author: { name: "Coder Person", date: "2026-10-01T00:00:00Z" },
        committer: { name: "Coder Person", date: "2026-10-01T00:05:00Z" },
        html_url: `https://github.com/acme/repo/commit/${COMMIT}`,
      },
      {
        event: "committed",
        sha: "d".repeat(40),
        message: "Unlinked author",
        author: { name: "Ghost", date: "2026-10-01T01:00:00Z" },
      },
      {
        event: "commented",
        id: 900,
        node_id: "IC_900",
        body: "Looks good",
        html_url: "https://github.com/acme/repo/pull/7#issuecomment-900",
        user: apiUser("viewer"),
        actor: apiUser("viewer"),
        created_at: "2026-10-01T02:00:00Z",
        updated_at: "2026-10-01T02:00:00Z",
      },
      {
        event: "reviewed",
        id: 50,
        state: "changes_requested",
        body: "Please fix",
        user: apiUser("rev"),
        submitted_at: "2026-10-01T03:00:00Z",
        html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-50",
      },
      { event: "reviewed", id: 52, state: "pending", user: apiUser("viewer") },
      { event: "labeled", id: 1, actor: apiUser("ann"), created_at: "t", label: { name: "bug" } },
      {
        event: "review_requested",
        id: 2,
        actor: apiUser("ann"),
        created_at: "t",
        requested_reviewer: apiUser("rita"),
      },
      {
        event: "review_requested",
        id: 3,
        actor: apiUser("ann"),
        created_at: "t",
        requested_team: { slug: "core" },
      },
      {
        event: "renamed",
        id: 4,
        actor: apiUser("ann"),
        created_at: "t",
        rename: { from: "Old", to: "New" },
      },
      { event: "convert_to_draft", id: 5, actor: apiUser("ann"), created_at: "t" },
      { event: "subscribed", id: 6, actor: apiUser("ann"), created_at: "t" },
      { event: "cross-referenced", actor: apiUser("ann"), created_at: "t" },
      { event: "merged", id: 7, actor: apiUser("ann"), created_at: "t" },
    ]);

    const timeline = await getGitHubPullRequestTimeline(TOKEN, REF, fake.options);

    expect(fake.unexpected).toEqual([]);
    expect(timeline.truncated).toBe(false);
    expect(timeline.items[0]).toEqual({
      kind: "event",
      id: "opened-7",
      event: "opened",
      actor: {
        login: "author",
        avatarUrl: "https://avatars.example/author",
        htmlUrl: "https://github.com/author",
      },
      createdAt: "2026-10-01T00:00:00Z",
    });
    expect(timeline.items[1]).toMatchObject({
      kind: "commit",
      sha: COMMIT,
      author: { login: "coder" },
      authorName: "Coder Person",
      createdAt: "2026-10-01T00:05:00Z",
    });
    expect(timeline.items[2]).toMatchObject({ kind: "commit", author: null, authorName: "Ghost" });
    expect(timeline.items[3]).toMatchObject({
      kind: "comment",
      id: "comment-900",
      comment: { id: 900, nodeId: "IC_900", body: "Looks good", canEdit: true },
    });
    expect(timeline.items[4]).toMatchObject({
      kind: "review",
      reviewId: 50,
      state: "changes-requested",
      inlineCommentsCount: 2,
      author: { login: "rev" },
    });
    const events = timeline.items
      .slice(5)
      .map((item) => (item.kind === "event" ? [item.event, item.detail] : [item.kind]));
    expect(events).toEqual([
      ["labeled", "bug"],
      ["review-requested", "rita"],
      ["review-requested", "acme/core"],
      ["renamed", "Old → New"],
      ["converted-to-draft", undefined],
      ["other", "cross referenced"],
      ["merged", undefined],
    ]);
  });

  test("caps long timelines and still loads when decorations fail", async () => {
    const fake = createFakeGitHub();
    routeTimeline(fake, []);
    let page = 0;
    fake.on("GET", "/repos/acme/repo/issues/7/timeline", (request) => {
      page += 1;
      const next = new URL(request.url);
      next.searchParams.set("page", String(page + 1));
      return json(
        Array.from({ length: 100 }, (_, index) => ({
          event: "labeled",
          id: page * 1000 + index,
          created_at: "t",
          label: { name: "x" },
        })),
        { headers: { link: `<${next.toString()}>; rel="next"` } },
      );
    });
    fake.on("GET", "/repos/acme/repo/pulls/7/comments", () =>
      json({ message: "no" }, { status: 500 }),
    );
    const timeline = await getGitHubPullRequestTimeline(TOKEN, REF, fake.options);
    expect(page).toBe(5);
    expect(timeline.items).toHaveLength(501);
    expect(timeline.truncated).toBe(true);
  });
});

test("an API opened event does not duplicate the synthetic opened row", async () => {
  const fake = createFakeGitHub();
  routeTimeline(fake, [{ event: "opened", id: 777, actor: apiUser("author"), created_at: "t" }]);
  const result = await getGitHubPullRequestTimeline(TOKEN, REF, fake.options);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ kind: "event", event: "opened" });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { refreshMonitoredPullRequest } from "../src/core/commands-registry-github-pull-requests";
import { resetGitHubPullRequestCache } from "../src/core/github-pull-requests";
import { createCommandFixtures } from "./command-fixtures";
import {
  TOKEN,
  createFakeGitHub,
  json,
  routePullRequestDetail,
} from "./github-pull-request-fixtures";

const { createCommandRegistry, createContext, createEnvironment } = await createCommandFixtures();

const project = {
  id: "project-1",
  name: "repo",
  gitUrl: "https://github.com/acme/repo.git",
  localPath: null,
  addedAt: new Date(0).toISOString(),
  order: 0,
};

const originalFetch = globalThis.fetch;

function setup(
  globalConfig: Record<string, unknown> = { useHostGitHubCredentials: false, githubToken: TOKEN },
) {
  const { context } = createContext(createEnvironment(), { project, globalConfig });
  const fake = createFakeGitHub();
  globalThis.fetch = fake.fetchImpl;
  const commands = createCommandRegistry();
  const run = (name: string, args: Record<string, unknown>) => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`Command not registered: ${name}`);
    return Promise.resolve(handler(args, context));
  };
  return { context, fake, run };
}

const ref = { owner: "acme", repo: "repo", number: 7 };

describe("GitHub pull request commands", () => {
  beforeEach(() => resetGitHubPullRequestCache());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetGitHubPullRequestCache();
  });

  test("registers every viewer command", () => {
    const commands = createCommandRegistry();
    for (const name of [
      "list_github_pull_requests",
      "get_github_pull_request",
      "get_github_pull_request_timeline",
      "get_github_pull_request_files",
      "merge_github_pull_request",
      "update_github_pull_request_state",
      "add_github_pull_request_comment",
      "update_github_pull_request_comment",
      "submit_github_pull_request_review",
      "add_github_pull_request_review_comment",
      "reply_github_pull_request_review_thread",
      "set_github_pull_request_thread_resolved",
      "set_github_pull_request_file_viewed",
      "set_github_pull_request_reviewers",
      "set_github_pull_request_labels",
      "change_github_pull_request_label",
      "list_github_repository_assignable_users",
      "list_github_repository_labels",
    ]) {
      expect(commands.has(name)).toBe(true);
    }
  });

  test("loads a pull request with the Settings credential", async () => {
    const { fake, run } = setup();
    routePullRequestDetail(fake);
    const detail = await run("get_github_pull_request", ref);
    expect(detail).toMatchObject({ ref, title: "Add widgets" });
    expect(fake.requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("rejects unexpected arguments and invalid refs before contacting GitHub", async () => {
    const { fake, run } = setup();
    await expect(run("get_github_pull_request", { ...ref, extra: true })).rejects.toThrow(
      "Unexpected arguments field: extra",
    );
    for (const bad of [
      { owner: "..", repo: "repo", number: 7 },
      { owner: "acme", repo: "re/po", number: 7 },
      { owner: "acme", repo: "repo", number: 0 },
      { owner: "acme", repo: "repo", number: "7" },
      { owner: "acme", repo: "repo" },
    ]) {
      await expect(run("get_github_pull_request", bad)).rejects.toThrow(
        "identify a GitHub pull request",
      );
    }
    await expect(
      run("merge_github_pull_request", { ...ref, method: "octopus", deleteBranch: false }),
    ).rejects.toThrow("Expected method to be one of");
    await expect(run("merge_github_pull_request", { ...ref, method: "merge" })).rejects.toThrow(
      "Expected deleteBranch to be a boolean",
    );
    await expect(
      run("submit_github_pull_request_review", {
        ...ref,
        event: "COMMENT",
        body: "x",
        comments: [{ path: "a", line: 1, side: "RIGHT", body: "x", position: 3 }],
      }),
    ).rejects.toThrow("Unexpected comments[0] field: position");
    await expect(
      run("list_github_repository_labels", { owner: "acme", repo: "repo", number: 1 }),
    ).rejects.toThrow("Unexpected arguments field: number");
    await expect(
      run("list_github_pull_requests", { projectId: "project-1", filter: "all" }),
    ).rejects.toThrow("Expected filter to be one of");
    await expect(
      run("list_github_pull_requests", {
        projectId: "project-1",
        filter: "open",
        query: "x".repeat(300),
      }),
    ).rejects.toThrow("at most 256");
    expect(fake.requests).toEqual([]);
  });

  test("explains a missing credential", async () => {
    const { fake, run } = setup({ useHostGitHubCredentials: false });
    await expect(run("get_github_pull_request", ref)).rejects.toThrow(
      "Add a GitHub personal access token in Settings",
    );
    expect(fake.requests).toEqual([]);
  });

  test("never echoes the token in errors", async () => {
    const { fake, run } = setup();
    routePullRequestDetail(fake);
    fake.on("GET", "/repos/acme/repo/pulls/7", () =>
      json({ message: `bad ${TOKEN}` }, { status: 401 }),
    );
    const error = await run("get_github_pull_request", ref).catch((caught: unknown) => caught);
    expect(String(error)).toContain("GitHub authentication failed");
    expect(String(error)).not.toContain(TOKEN);
  });

  test("lists the project's pull requests through one GraphQL search", async () => {
    const { fake, run } = setup();
    fake.onGraphql("PullRequestList", (request) => {
      expect((request.body?.variables as Record<string, unknown> | undefined)?.query).toBe(
        "repo:acme/repo is:pr is:closed fix sort:updated-desc",
      );
      return json({
        data: {
          viewer: { login: "viewer" },
          repository: { nameWithOwner: "acme/repo", url: "https://github.com/acme/repo" },
          search: { issueCount: 0, nodes: [] },
        },
      });
    });
    const result = await run("list_github_pull_requests", {
      projectId: "project-1",
      filter: "closed",
      query: " fix ",
    });
    expect(result).toMatchObject({ filter: "closed", pullRequests: [], hasMore: false });
  });

  test("merges through the REST API", async () => {
    const { fake, run } = setup();
    fake.on("PUT", "/repos/acme/repo/pulls/7/merge", { merged: true });
    const result = await run("merge_github_pull_request", {
      ...ref,
      method: "squash",
      deleteBranch: false,
    });
    expect(result).toMatchObject({ merged: true });
  });
});

describe("refreshMonitoredPullRequest", () => {
  test("refreshes only environments whose PR URL is this pull request", async () => {
    const refresh = mock(async () => undefined);
    const context = {
      storage: {
        loadEnvironments: async () => [
          { id: "match", prUrl: "https://github.com/ACME/repo/pull/7" },
          { id: "other-number", prUrl: "https://github.com/acme/repo/pull/8" },
          { id: "other-repo", prUrl: "https://github.com/acme/other/pull/7" },
          { id: "none", prUrl: null },
        ],
      },
    };
    await refreshMonitoredPullRequest(ref, context as never, refresh as never);
    expect(refresh.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["match"]);
  });

  test("swallows failures so a merge never fails on monitor refresh", async () => {
    const context = {
      storage: {
        loadEnvironments: async () => {
          throw new Error("storage offline");
        },
      },
    };
    await expect(refreshMonitoredPullRequest(ref, context as never)).resolves.toBeUndefined();
  });
});

test("label toggle commands validate input and send only incremental intent", async () => {
  const { fake, run } = setup();
  fake.on("POST", "/repos/acme/repo/issues/7/labels", [{ name: "bug", color: "ff0000" }]);
  await run("change_github_pull_request_label", { ...ref, name: "bug", present: true });
  expect(fake.requests[0]?.body).toEqual({ labels: ["bug"] });
  await expect(
    run("change_github_pull_request_label", { ...ref, name: "bug", present: "yes" }),
  ).rejects.toThrow("boolean");
});

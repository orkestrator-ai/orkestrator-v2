import { describe, expect, mock, test } from "bun:test";
import {
  GITHUB_STATUS_LABELS,
  GitHubApiError,
  closeGitHubIssue,
  ensureGitHubWorkflowLabels,
  getGitHubIssue,
  getGitHubIssueStatus,
  listGitHubIssueComments,
  listGitHubIssues,
  postGitHubIssueComment,
  resolveGitHubRepository,
  sanitizeGitHubError,
  updateGitHubIssue,
  updateGitHubIssueComment,
  updateGitHubIssueStatus,
  type GitHubLabel,
} from "../../../apps/backend/src/core/github";

const token = "github_pat_super_secret";
const repository = { owner: "octo-org", name: "octo-repo" };

function jsonResponse(
  payload: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
}

function apiUser(login: string) {
  return {
    login,
    avatar_url: `https://avatars.example/${login}`,
    html_url: `https://github.com/${login}`,
  };
}

function apiLabel(name: string, color = "ffffff") {
  return { name, color, description: `${name} description` };
}

function apiIssue(
  issueNumber: number,
  options: {
    labels?: unknown[];
    state?: "open" | "closed";
    title?: string;
    pullRequest?: boolean;
  } = {},
) {
  return {
    id: issueNumber * 10,
    number: issueNumber,
    title: options.title ?? `Issue ${issueNumber}`,
    body: `Body ${issueNumber}`,
    html_url: `https://github.com/octo-org/octo-repo/issues/${issueNumber}`,
    state: options.state ?? "open",
    locked: false,
    user: apiUser("ada"),
    assignees: [apiUser("grace")],
    labels: options.labels ?? [],
    comments: 2,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    ...(options.pullRequest ? { pull_request: { url: "https://api.github.com/pulls/1" } } : {}),
  };
}

function apiComment(
  id: number,
  author = "ada",
  options: { issueNumber?: number; body?: string; edited?: boolean } = {},
) {
  const createdAt = "2026-07-03T00:00:00.000Z";
  return {
    id,
    body: options.body ?? `Comment ${id}`,
    html_url: `https://github.com/octo-org/octo-repo/issues/1#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/octo-org/octo-repo/issues/${options.issueNumber ?? 1}`,
    user: apiUser(author),
    created_at: createdAt,
    updated_at: options.edited ? "2026-07-04T00:00:00.000Z" : createdAt,
  };
}

function assertSecureHeaders(init?: RequestInit): void {
  const headers = new Headers(init?.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(headers.get("accept")).toBe("application/vnd.github+json");
  expect(headers.get("x-github-api-version")).toBe("2022-11-28");
}

describe("GitHub repository resolution", () => {
  test("resolves supported HTTPS, SCP-like SSH, and ssh:// project URLs", () => {
    expect(resolveGitHubRepository("https://github.com/octo-org/octo-repo.git")).toEqual(repository);
    expect(resolveGitHubRepository("git@github.com:octo-org/octo-repo.git")).toEqual(repository);
    expect(resolveGitHubRepository("ssh://git@github.com/octo-org/octo-repo.git")).toEqual(repository);
  });

  test("rejects non-GitHub, nested, and malformed repository URLs actionably", () => {
    expect(() => resolveGitHubRepository("https://gitlab.com/octo-org/octo-repo")).toThrow(
      "github.com HTTPS or SSH URL",
    );
    expect(() => resolveGitHubRepository("https://github.com/octo-org/octo-repo/issues/1")).toThrow(
      "owner and name",
    );
    expect(() => resolveGitHubRepository("not a remote")).toThrow("HTTPS or SSH");
  });
});

describe("GitHub issue workflow API", () => {
  test("uses the earliest recognized status label", () => {
    const labels = [
      apiLabel(GITHUB_STATUS_LABELS.review),
      apiLabel(GITHUB_STATUS_LABELS.inprogress),
      apiLabel(GITHUB_STATUS_LABELS.todo),
    ] as GitHubLabel[];
    expect(getGitHubIssueStatus(labels)).toBe("todo");
    expect(getGitHubIssueStatus(labels.slice(0, 2))).toBe("inprogress");
    expect(getGitHubIssueStatus(labels.slice(0, 1))).toBe("review");
    expect(getGitHubIssueStatus([apiLabel("bug")])).toBe("backlog");
  });

  test("creates missing workflow labels once and repeated loading is idempotent", async () => {
    const labels = new Set<string>();
    const posts: string[] = [];
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      assertSecureHeaders(init);
      const url = new URL(String(input));
      if (url.pathname === "/repos/octo-org/octo-repo/labels" && (init?.method ?? "GET") === "GET") {
        return jsonResponse([...labels].map(apiLabel));
      }
      if (url.pathname === "/repos/octo-org/octo-repo/labels" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        posts.push(body.name);
        labels.add(body.name);
        return jsonResponse(apiLabel(body.name), { status: 201 });
      }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
    });

    await ensureGitHubWorkflowLabels(token, repository, fetchMock as typeof fetch);
    await ensureGitHubWorkflowLabels(token, repository, fetchMock as typeof fetch);

    expect(posts).toEqual(["ork:todo", "ork:inprogress", "ork:review"]);
  });

  test("loads every open issue page, excludes pull requests, and returns no credential", async () => {
    const allLabels = Object.values(GITHUB_STATUS_LABELS).map(apiLabel);
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      assertSecureHeaders(init);
      const url = new URL(String(input));
      if (url.pathname === "/repos/octo-org/octo-repo/labels") return jsonResponse(allLabels);
      if (url.pathname === "/user") return jsonResponse(apiUser("viewer"));
      if (url.pathname === "/repos/octo-org/octo-repo" && !url.search) {
        return jsonResponse({
          full_name: "octo-org/octo-repo",
          html_url: "https://github.com/octo-org/octo-repo",
          permissions: { push: false },
        });
      }
      if (url.pathname === "/repos/octo-org/octo-repo/issues" && url.searchParams.get("page") === "1") {
        return jsonResponse(
          [apiIssue(1, { labels: [apiLabel("bug")] })],
          {
            headers: {
              link: '<https://api.github.com/repos/octo-org/octo-repo/issues?state=open&per_page=100&page=2>; rel="next"',
            },
          },
        );
      }
      if (url.pathname === "/repos/octo-org/octo-repo/issues" && url.searchParams.get("page") === "2") {
        return jsonResponse([
          apiIssue(2, { labels: [apiLabel("ork:review")] }),
          apiIssue(3, { pullRequest: true }),
        ]);
      }
      throw new Error(`Unexpected request ${url}`);
    });

    const result = await listGitHubIssues(token, repository, fetchMock as typeof fetch);

    expect(result.repository.fullName).toBe("octo-org/octo-repo");
    expect(result.viewer.login).toBe("viewer");
    expect(result.issues.map((issue) => [issue.number, issue.status])).toEqual([
      [1, "backlog"],
      [2, "review"],
    ]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("status replacement preserves unrelated labels and removes every recognized label", async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse(apiIssue(7, {
          labels: [
            apiLabel("bug"),
            apiLabel("ORK:TODO"),
            apiLabel("ork:inprogress"),
            apiLabel("ork:review"),
          ],
        }));
      }
      const body = JSON.parse(String(init?.body)) as { labels: string[] };
      expect(body.labels).toEqual(["bug", "ork:review"]);
      return jsonResponse(apiIssue(7, { labels: body.labels.map(apiLabel) }));
    });

    const issue = await updateGitHubIssueStatus(
      token,
      repository,
      7,
      "review",
      fetchMock as typeof fetch,
    );
    expect(issue.status).toBe("review");
    expect(issue.labels.map((label) => label.name)).toEqual(["bug", "ork:review"]);
  });

  test("moving to Backlog applies no recognized workflow label", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse(apiIssue(8, { labels: [apiLabel("enhancement"), apiLabel("ork:todo")] }));
      }
      const body = JSON.parse(String(init?.body)) as { labels: string[] };
      expect(body.labels).toEqual(["enhancement"]);
      return jsonResponse(apiIssue(8, { labels: body.labels.map(apiLabel) }));
    });
    await expect(
      updateGitHubIssueStatus(token, repository, 8, "backlog", fetchMock as typeof fetch),
    ).resolves.toMatchObject({ status: "backlog" });
  });

  test("updates issue text and closes an issue through scoped repository endpoints", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      return jsonResponse(apiIssue(9, {
        title: typeof body.title === "string" ? body.title : "Issue 9",
        state: body.state === "closed" ? "closed" : "open",
      }));
    });

    await updateGitHubIssue(
      token,
      repository,
      9,
      { title: " Updated issue ", body: "Updated body" },
      fetchMock as typeof fetch,
    );
    const closed = await closeGitHubIssue(token, repository, 9, fetchMock as typeof fetch);

    expect(requests[0]).toEqual({
      url: "https://api.github.com/repos/octo-org/octo-repo/issues/9",
      body: { title: "Updated issue", body: "Updated body" },
    });
    expect(requests[1]?.body).toEqual({ state: "closed" });
    expect(closed.state).toBe("closed");
  });
});

describe("GitHub issue comments API", () => {
  test("loads every comment page and maps edited state", async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("page") === "1") {
        return jsonResponse([apiComment(1)], {
          headers: {
            link: '<https://api.github.com/repos/octo-org/octo-repo/issues/1/comments?per_page=100&page=2>; rel="next"',
          },
        });
      }
      return jsonResponse([apiComment(2, "grace", { edited: true })]);
    });

    const comments = await listGitHubIssueComments(token, repository, 1, fetchMock as typeof fetch);

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ id: 1, isEdited: false, canEdit: false });
    expect(comments[1]).toMatchObject({ id: 2, isEdited: true, canEdit: false });
  });

  test("detail comments expose edit controls only for the viewer or a maintainer", async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/octo-org/octo-repo/issues/1") return jsonResponse(apiIssue(1));
      if (url.pathname === "/repos/octo-org/octo-repo/issues/1/comments") {
        return jsonResponse([apiComment(1, "viewer"), apiComment(2, "someone-else")]);
      }
      if (url.pathname === "/user") return jsonResponse(apiUser("viewer"));
      if (url.pathname === "/repos/octo-org/octo-repo") {
        return jsonResponse({
          full_name: "octo-org/octo-repo",
          html_url: "https://github.com/octo-org/octo-repo",
          permissions: { push: false },
        });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    });

    const detail = await getGitHubIssue(token, repository, 1, fetchMock as typeof fetch);
    expect(detail.comments.map((comment) => comment.canEdit)).toEqual([true, false]);
  });

  test("adds non-empty comments and rejects empty comments before a request", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ body: "New comment" });
      return jsonResponse(apiComment(5, "viewer", { body: "New comment" }), { status: 201 });
    });

    await expect(
      postGitHubIssueComment(token, repository, 1, "New comment", fetchMock as typeof fetch),
    ).resolves.toMatchObject({ id: 5, body: "New comment", canEdit: true });
    await expect(
      postGitHubIssueComment(token, repository, 1, "   ", fetchMock as typeof fetch),
    ).rejects.toThrow("cannot be empty");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not offer or attempt an edit when the authenticated user lacks permission", async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.method).toBeUndefined();
      if (url.pathname.endsWith("/issues/comments/12")) return jsonResponse(apiComment(12, "other-user"));
      if (url.pathname === "/user") return jsonResponse(apiUser("viewer"));
      return jsonResponse({
        full_name: "octo-org/octo-repo",
        html_url: "https://github.com/octo-org/octo-repo",
        permissions: { push: false },
      });
    });

    await expect(
      updateGitHubIssueComment(token, repository, 1, 12, "Draft", fetchMock as typeof fetch),
    ).rejects.toThrow("does not have permission");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("edits an owned comment only after verifying it belongs to the selected issue", async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/user") return jsonResponse(apiUser("viewer"));
      if (url.pathname === "/repos/octo-org/octo-repo") {
        return jsonResponse({
          full_name: "octo-org/octo-repo",
          html_url: "https://github.com/octo-org/octo-repo",
          permissions: { push: false },
        });
      }
      if (init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ body: "Edited draft" });
        return jsonResponse(apiComment(13, "viewer", { body: "Edited draft", edited: true }));
      }
      return jsonResponse(apiComment(13, "viewer"));
    });

    await expect(
      updateGitHubIssueComment(token, repository, 1, 13, "Edited draft", fetchMock as typeof fetch),
    ).resolves.toMatchObject({ id: 13, body: "Edited draft", canEdit: true });
  });
});

describe("GitHub error handling", () => {
  test("sanitizes GitHub token formats and exact configured secrets", () => {
    const message = sanitizeGitHubError(
      new Error(`Bearer ${token} failed with ghp_anotherSecret and github_pat_moreSecret`),
      token,
    );
    expect(message).not.toContain(token);
    expect(message).not.toContain("ghp_anotherSecret");
    expect(message).not.toContain("github_pat_moreSecret");
    expect(message).toContain("[redacted]");
  });

  test("reports authentication, permission, and rate-limit failures actionably", async () => {
    const unauthorized = mock(async () => jsonResponse({ message: token }, { status: 401 }));
    await expect(
      listGitHubIssueComments(token, repository, 1, unauthorized as typeof fetch),
    ).rejects.toThrow("Update the global GitHub token");

    const forbidden = mock(async () => jsonResponse({ message: "Forbidden" }, { status: 403 }));
    await expect(
      listGitHubIssueComments(token, repository, 1, forbidden as typeof fetch),
    ).rejects.toThrow("Issues write access");

    const limited = mock(async () => jsonResponse(
      { message: "API rate limit exceeded" },
      { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } },
    ));
    await expect(
      listGitHubIssueComments(token, repository, 1, limited as typeof fetch),
    ).rejects.toThrow("Try again in 60 seconds");
  });

  test("maps network failures without reflecting low-level request details", async () => {
    const offline = mock(async () => {
      throw new Error(`fetch failed with ${token}`);
    });
    await expect(
      listGitHubIssueComments(token, repository, 1, offline as typeof fetch),
    ).rejects.toEqual(
      new GitHubApiError(
        "Unable to reach GitHub. Check your network connection and try again.",
        { code: "network" },
      ),
    );
  });
});

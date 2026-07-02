import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  getLinearIssue,
  listLinearIssues,
  postLinearCompletionComment,
  postLinearIssueComment,
  sanitizeLinearError,
  verifyLinearConnection,
} from "../../../electron/backend/linear";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Linear backend API", () => {
  test("redacts Linear tokens, bearer tokens, and exact submitted secrets from errors", () => {
    const message = sanitizeLinearError(
      new Error("Linear rejected lin_api_secret and Bearer token-value plus custom-secret"),
      "custom-secret",
    );

    expect(message).not.toContain("lin_api_secret");
    expect(message).not.toContain("token-value");
    expect(message).not.toContain("custom-secret");
    expect(message).toContain("[redacted]");
  });

  test("verifies the connection from the viewer response", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "lin_api_secret" });
      return jsonResponse({
        data: {
          viewer: { id: "viewer-1", name: "Ada", email: "ada@example.com" },
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(verifyLinearConnection("lin_api_secret")).resolves.toEqual({
      id: "viewer-1",
      name: "Ada",
      email: "ada@example.com",
    });
  });

  test("reports non-JSON Linear responses without exposing request secrets", async () => {
    globalThis.fetch = mock(async () => new Response("not-json lin_api_secret", { status: 502 })) as unknown as typeof fetch;

    await expect(verifyLinearConnection("lin_api_secret")).rejects.toThrow("Linear returned HTTP 502");
  });

  test("loads every Linear issue page until Linear reports completion", async () => {
    const pageCount = 26;
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { after: string | null };
      };
      expect(request.query).toContain("sort: [{ manual: { order: Ascending } }]");
      expect(request.query).toContain("sortOrder");
      const pageIndex = request.variables.after ? Number(request.variables.after.replace("cursor-", "")) : 0;
      const nextPage = pageIndex + 1;

      return jsonResponse({
        data: {
          issues: {
            nodes: [{
              id: `issue-${pageIndex}`,
              identifier: `ENG-${pageIndex}`,
              title: `Issue ${pageIndex}`,
              sortOrder: pageCount - pageIndex,
              updatedAt: `2026-06-${String(pageCount - pageIndex).padStart(2, "0")}T12:00:00.000Z`,
              state: { name: pageIndex % 2 === 0 ? "Todo" : "Done", type: "unstarted" },
              team: { key: "ENG", name: "Engineering" },
              assignee: { name: "Ada" },
              priorityLabel: "High",
            }],
            pageInfo: {
              hasNextPage: nextPage < pageCount,
              endCursor: nextPage < pageCount ? `cursor-${nextPage}` : null,
            },
          },
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const issues = await listLinearIssues("lin_api_secret");

    expect(fetchMock).toHaveBeenCalledTimes(pageCount);
    expect(issues).toHaveLength(pageCount);
    expect(issues[0]).toMatchObject({ identifier: "ENG-25", status: "Done", teamKey: "ENG" });
    expect(issues.at(-1)).toMatchObject({ identifier: "ENG-0", status: "Todo" });
  });

  test("orders issues by sortOrder with updatedAt and identifier tie-breakers", async () => {
    // Nodes are intentionally supplied out of order to exercise the full comparator.
    const nodes = [
      { identifier: "ENG-UND-OLD", updatedAt: "2026-06-05T12:00:00.000Z" }, // no sortOrder
      { identifier: "ENG-TIE-B", sortOrder: 5, updatedAt: "2026-06-02T12:00:00.000Z" },
      { identifier: "ENG-3", sortOrder: 2, updatedAt: "2026-06-01T12:00:00.000Z" },
      { identifier: "ENG-TIE-C", sortOrder: 5, updatedAt: "2026-06-09T12:00:00.000Z" }, // newer updatedAt
      { identifier: "ENG-UND-NEW", updatedAt: "2026-06-20T12:00:00.000Z" }, // no sortOrder
      { identifier: "ENG-1", sortOrder: 1, updatedAt: "2026-06-01T12:00:00.000Z" },
      { identifier: "ENG-TIE-A", sortOrder: 5, updatedAt: "2026-06-02T12:00:00.000Z" }, // equal sortOrder+updatedAt as ENG-TIE-B
    ].map((node, index) => ({
      id: `issue-${index}`,
      title: `Issue ${node.identifier}`,
      state: { name: "Todo", type: "unstarted" },
      team: { key: "ENG", name: "Engineering" },
      assignee: { name: "Ada" },
      priorityLabel: "High",
      ...node,
    }));

    globalThis.fetch = mock(async () => jsonResponse({
      data: {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })) as unknown as typeof fetch;

    const issues = await listLinearIssues("lin_api_secret");

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "ENG-1", // sortOrder 1
      "ENG-3", // sortOrder 2
      "ENG-TIE-C", // sortOrder 5, newest updatedAt wins
      "ENG-TIE-A", // sortOrder 5, older updatedAt, identifier tie-break before B
      "ENG-TIE-B", // sortOrder 5, older updatedAt, same updatedAt as A
      "ENG-UND-NEW", // missing sortOrder sorts last, newest updatedAt first
      "ENG-UND-OLD", // missing sortOrder sorts last
    ]);
  });

  test("fails issue pagination when Linear reports another page without a cursor", async () => {
    globalThis.fetch = mock(async () => jsonResponse({
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    })) as unknown as typeof fetch;

    await expect(listLinearIssues("lin_api_secret")).rejects.toThrow(
      "Linear issues pagination did not return a cursor",
    );
  });

  test("fails issue pagination when Linear repeats a cursor", async () => {
    const fetchMock = mock(async () => jsonResponse({
      data: {
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(listLinearIssues("lin_api_secret")).rejects.toThrow(
      "Linear issues pagination cursor repeated",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("maps Linear issue details, labels, and comments", async () => {
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("OrkestratorLinearIssueComments")) {
        return jsonResponse({
          data: {
            issue: {
              comments: {
                nodes: [{
                  id: "comment-2",
                  body: "Second comment",
                  createdAt: "2026-06-28T12:05:00.000Z",
                  updatedAt: "2026-06-28T12:05:00.000Z",
                  user: { name: "Ada" },
                }, {
                  id: "comment-1",
                  body: "First comment",
                  createdAt: "2026-06-28T12:01:00.000Z",
                  updatedAt: "2026-06-28T12:01:00.000Z",
                  user: { name: "Grace" },
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }

      return jsonResponse({
        data: {
          issue: {
            id: "issue-1",
            identifier: "ENG-123",
            title: "Ship Linear integration",
            description: "Build the integration",
            sortOrder: 42,
            updatedAt: "2026-06-28T12:00:00.000Z",
            createdAt: "2026-06-20T12:00:00.000Z",
            url: "https://linear.app/acme/issue/ENG-123",
            priorityLabel: "High",
            state: { name: "Todo", type: "unstarted" },
            team: { key: "ENG", name: "Engineering" },
            assignee: { name: "Ada" },
            creator: { name: "Grace" },
            project: { name: "Integrations" },
            cycle: { name: "Cycle 1" },
            labels: { nodes: [{ name: "linear" }, { name: "pipeline" }] },
          },
        },
      });
    }) as unknown as typeof fetch;

    await expect(getLinearIssue("lin_api_secret", "issue-1")).resolves.toMatchObject({
      id: "issue-1",
      identifier: "ENG-123",
      description: "Build the integration",
      sortOrder: 42,
      creatorName: "Grace",
      projectName: "Integrations",
      cycleName: "Cycle 1",
      labels: ["linear", "pipeline"],
      comments: [
        { id: "comment-1", body: "First comment", authorName: "Grace" },
        { id: "comment-2", body: "Second comment", authorName: "Ada" },
      ],
    });
  });

  test("creates issue comments and maps the created comment", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      expect(request.query).toContain("OrkestratorLinearIssueComment");
      expect(request.variables).toMatchObject({
        issueId: "issue-1",
        body: "New comment",
      });
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-new",
              body: "New comment",
              createdAt: "2026-06-28T12:10:00.000Z",
              updatedAt: "2026-06-28T12:10:00.000Z",
              user: { name: "Ada" },
            },
          },
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(postLinearIssueComment("lin_api_secret", {
      issueId: "issue-1",
      body: " New comment ",
    })).resolves.toEqual({
      id: "comment-new",
      body: "New comment",
      createdAt: "2026-06-28T12:10:00.000Z",
      updatedAt: "2026-06-28T12:10:00.000Z",
      authorName: "Ada",
    });
  });

  test("returns existing completion comments without creating duplicates", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      expect(request.query).toContain("OrkestratorLinearCompletionComments");
      return jsonResponse({
        data: {
          issue: {
            comments: {
              nodes: [{
                id: "comment-existing",
                body: "Done\n\n<!-- orkestrator-linear-run:pipeline-1 -->",
                createdAt: "2026-06-28T12:00:00.000Z",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(postLinearCompletionComment("lin_api_secret", {
      pipelineId: "pipeline-1",
      issueId: "issue-1",
      body: "Done",
    })).resolves.toEqual({
      status: "already-posted",
      commentId: "comment-existing",
      postedAt: "2026-06-28T12:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("creates completion comments with the pipeline marker when no marker exists", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      if (request.query.includes("OrkestratorLinearCompletionComments")) {
        return jsonResponse({
          data: {
            issue: {
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }

      expect(request.query).toContain("OrkestratorLinearCompletionComment");
      expect(request.variables.body).toContain("Build complete");
      expect(request.variables.body).toContain("<!-- orkestrator-linear-run:pipeline-1 -->");
      return jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-new", createdAt: "2026-06-28T12:05:00.000Z" },
          },
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(postLinearCompletionComment("lin_api_secret", {
      pipelineId: "pipeline-1",
      issueId: "issue-1",
      body: "Build complete",
    })).resolves.toEqual({
      status: "posted",
      commentId: "comment-new",
      postedAt: "2026-06-28T12:05:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("fails completion-comment pagination when Linear omits the next cursor", async () => {
    globalThis.fetch = mock(async () => jsonResponse({
      data: {
        issue: {
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      },
    })) as unknown as typeof fetch;

    await expect(postLinearCompletionComment("lin_api_secret", {
      pipelineId: "pipeline-1",
      issueId: "issue-1",
      body: "Build complete",
    })).rejects.toThrow("Linear comments pagination did not return a cursor");
  });
});

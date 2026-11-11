import { describe, expect, mock, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { createCommandRegistry, createContext, createEnvironment } = await createCommandFixtures();

describe("Electron backend command registry", () => {
  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.

  test("verifies, stores, and disconnects Linear auth through command handlers", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    // Assigned inside storage mocks, so widen past the initial null narrowing.
    let auth = null as {
      apiKey: string;
      connectedAt: string;
      viewer?: { id: string; name: string; email?: string };
    } | null;
    const revocations: unknown[] = [];

    Object.assign(context.storage.kanban, {
      getLinearAuth: mock(async () => auth),
      saveLinearAuth: mock(
        async (
          apiKey: string,
          viewer?: { id: string; name: string; email?: string },
          connectedAt?: string,
        ) => {
          auth = { apiKey, viewer, connectedAt: connectedAt ?? "2026-11-11T10:00:00.000Z" };
          return auth;
        },
      ),
      clearLinearAuth: mock(async () => {
        auth = null;
      }),
    });
    Object.assign(context.storage.linear, {
      mergeLinearRevocations: mock((list: unknown[]) => {
        revocations.push(...list);
        return list.length;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "lin_api_secret" });
      return new Response(
        JSON.stringify({
          data: {
            viewer: { id: "viewer-1", name: "Ada", email: "ada@example.com" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const connected = {
      connected: true,
      hasToken: true,
      viewer: { id: "viewer-1", name: "Ada", email: "ada@example.com" },
      keyFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
      connectedAt: "2026-11-11T10:00:00.000Z",
    };

    try {
      await expect(commands.get("get_linear_connection")?.({}, context)).resolves.toEqual({
        connected: false,
        hasToken: false,
      });

      const status = (await commands.get("connect_linear")?.(
        { apiKey: " lin_api_secret " },
        context,
      )) as { keyFingerprint?: string };
      expect(status).toEqual(connected);
      expect(JSON.stringify(status)).not.toContain("lin_api_secret");
      expect(auth?.apiKey).toBe("lin_api_secret");

      // A status read refreshes the viewer but keeps when the key was connected,
      // so a disconnect made on another machine since still applies.
      await expect(commands.get("get_linear_connection")?.({}, context)).resolves.toEqual(
        connected,
      );
      expect(auth?.connectedAt).toBe("2026-11-11T10:00:00.000Z");

      await expect(commands.get("disconnect_linear")?.({}, context)).resolves.toEqual({
        connected: false,
        hasToken: false,
      });
      expect(auth).toBeNull();
      // The disconnect is recorded by the key's fingerprint, never the key.
      expect(revocations).toEqual([
        { keyFingerprint: status.keyFingerprint, revokedAt: expect.any(String) },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("posts Linear issue comments through command handlers", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    Object.assign(context.storage.kanban, {
      getLinearAuth: mock(async () => ({ apiKey: "lin_api_secret" })),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, string>;
      };
      expect(init?.headers).toMatchObject({ Authorization: "lin_api_secret" });
      expect(request.query).toContain("OrkestratorLinearIssueComment");
      expect(request.variables).toMatchObject({
        issueId: "issue-1",
        body: "Looks good",
      });
      return new Response(
        JSON.stringify({
          data: {
            commentCreate: {
              success: true,
              comment: {
                id: "comment-1",
                body: "Looks good",
                createdAt: "2026-06-28T12:10:00.000Z",
                updatedAt: "2026-06-28T12:10:00.000Z",
                user: { name: "Ada" },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      await expect(
        commands.get("post_linear_issue_comment")?.(
          {
            issueId: "issue-1",
            body: " Looks good ",
          },
          context,
        ),
      ).resolves.toEqual({
        id: "comment-1",
        body: "Looks good",
        createdAt: "2026-06-28T12:10:00.000Z",
        updatedAt: "2026-06-28T12:10:00.000Z",
        authorName: "Ada",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("serializes concurrent Linear completion comments by pipeline ID", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: {
      pipelineId: string;
      issueId: string;
      status: "posted" | "failed";
      commentId?: string;
      postedAt?: string;
      error?: string;
    } | null = null;
    let commentCreateCalls = 0;

    Object.assign(context.storage.kanban, {
      getLinearAuth: mock(async () => ({ apiKey: "lin_api_secret" })),
      getLinearCompletionComment: mock(async () => completionRecord),
      saveLinearCompletionComment: mock(async (record: typeof completionRecord) => {
        completionRecord = record;
        return record;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("OrkestratorLinearCompletionComments")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      commentCreateCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(
        JSON.stringify({
          data: {
            commentCreate: {
              success: true,
              comment: { id: "comment-1", createdAt: "2026-06-28T12:00:00.000Z" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const [first, second] = await Promise.all([
        commands.get("post_linear_completion_comment")?.(
          {
            pipelineId: "pipeline-1",
            issueId: "issue-1",
            body: "Done",
          },
          context,
        ),
        commands.get("post_linear_completion_comment")?.(
          {
            pipelineId: "pipeline-1",
            issueId: "issue-1",
            body: "Done",
          },
          context,
        ),
      ]);

      expect(commentCreateCalls).toBe(1);
      expect(first).toEqual({
        status: "posted",
        commentId: "comment-1",
        postedAt: "2026-06-28T12:00:00.000Z",
      });
      expect(second).toEqual({
        status: "already-posted",
        commentId: "comment-1",
        postedAt: "2026-06-28T12:00:00.000Z",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not retry queued concurrent Linear completion comments after a failure", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: {
      pipelineId: string;
      issueId: string;
      status: "posted" | "failed";
      commentId?: string;
      postedAt?: string;
      error?: string;
    } | null = null;
    let commentCreateCalls = 0;

    Object.assign(context.storage.kanban, {
      getLinearAuth: mock(async () => ({ apiKey: "lin_api_secret" })),
      getLinearCompletionComment: mock(async () => completionRecord),
      saveLinearCompletionComment: mock(async (record: typeof completionRecord) => {
        completionRecord = record;
        return record;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("OrkestratorLinearCompletionComments")) {
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      commentCreateCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(
        JSON.stringify({
          errors: [{ message: "Linear unavailable" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const [first, second] = await Promise.allSettled([
        commands.get("post_linear_completion_comment")?.(
          {
            pipelineId: "pipeline-1",
            issueId: "issue-1",
            body: "Done",
          },
          context,
        ),
        commands.get("post_linear_completion_comment")?.(
          {
            pipelineId: "pipeline-1",
            issueId: "issue-1",
            body: "Done",
          },
          context,
        ),
      ]);

      expect(commentCreateCalls).toBe(1);
      expect(first.status).toBe("rejected");
      expect(second.status).toBe("rejected");
      if (first.status === "rejected") expect(first.reason.message).toBe("Linear unavailable");
      if (second.status === "rejected") expect(second.reason.message).toBe("Linear unavailable");
      expect(completionRecord).toMatchObject({
        pipelineId: "pipeline-1",
        issueId: "issue-1",
        status: "failed",
        error: "Linear unavailable",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

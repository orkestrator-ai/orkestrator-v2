import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  APP_SLUG,
  APP_VERSION,
  ASYNC_TEST_BUDGET_MS,
  ASYNC_TEST_WAIT_TIMEOUT_MS,
  CONTAINER_UNTRACKED_STATS_SCANNER,
  CommandFailedError,
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  EnvironmentLifecycleTaskTracker,
  LOCAL_PROJECT_FOR_CREATE,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  RUNNING_CONTAINER_DOCKER_SCRIPT,
  SETUP_DONE_OSC,
  SETUP_FAILED_OSC,
  TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  closeLocalServerAdmission,
  codexSlugScript,
  commandTesting,
  configuredGitPushBehaviour,
  configuredGitUpstream,
  createCommandRegistry,
  createContext,
  createDeferred,
  createEnvironment,
  createFakeChild,
  createGitRepoOnBranch,
  createGitWorktreeWithOrigin,
  createHash,
  createReviewPackageWorktree,
  createTempDir,
  currentGitBranch,
  currentGitCommit,
  dockerOwnerNamespace,
  execFile,
  execFileAsync,
  existsSync,
  expectClearsPendingAgentLaunch,
  expectLocalWorktreeRolledBack,
  expectedLocalShellPath,
  expectedManagedWorktreePath,
  framedContainerGitStatus,
  freshFetchedAt,
  fs,
  gitOutput,
  http,
  isImmutableCommitRef,
  isLoopedReviewWorkflow,
  isPaneLayoutRevisionConflict,
  isProcessRunning,
  isolateCodexBinaryLookup,
  liveDockerTest,
  loopedReviewWorkflowAround,
  os,
  paneLayoutRevisionConflictMessage,
  path,
  pathToFileURL,
  promisify,
  ptyProcesses,
  ptySpawn,
  randomUUID,
  readFileSync,
  readTestCredential,
  requestOk,
  reserveFreePort,
  resolveBrowserOpenCommand,
  resolveFileManagerRevealCommands,
  runGit,
  setAgentSkillsHomeForTesting,
  showOpenDialog,
  shutdownDiffStatsTracking,
  shutdownLocalServers,
  shutdownPrMonitorTracking,
  spawnCommand,
  spawnSync,
  startAuthenticatedContainerServer,
  startControllableHealthServer,
  tempDirs,
  terminalSessionResult,
  toClientEnvironment,
  updatesWithStatus,
  waitForCondition,
  waitForPtyProcessCount,
  withFailingGitSubcommand,
  withFakeCodex,
  withFakeDocker,
  withFakeGh,
  withFakeGitSubcommandOutput,
  withFixedDate,
  withGitArgumentStub,
  withGitSubcommandLog,
  withGnuBase64Shim,
  writeBridgeEntrypoint,
  writeBridgeServer,
} = await createCommandFixtures();

import type {
  ChildProcessWithoutNullStreams,
  CommandContext,
  Environment,
  MockPtyProcess,
  PtyExitEvent,
  RepositoryConfig,
} from "./command-fixtures";



describe("GitHub issue commands", () => {
  test("loads and mutates only the selected project's GitHub issues", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment(), {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();
    const requests: Array<{ method: string; pathname: string; body: unknown }> = [];
    let issueTitle = "Original issue";
    let issueBody = "Original body";
    let issueState = "open";
    let issueLabels = [{ name: "bug", color: "ff0000" }];
    let commentBody = "Original comment";

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
    });

    const issuePayload = () => ({
      id: 420,
      number: 42,
      title: issueTitle,
      body: issueBody,
      html_url: "https://github.com/acme/repo/issues/42",
      state: issueState,
      locked: false,
      user: {
        login: "viewer",
        avatar_url: "https://avatars.example/viewer",
        html_url: "https://github.com/viewer",
      },
      assignees: [],
      labels: issueLabels,
      comments: 1,
      created_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-24T10:00:00.000Z",
    });
    const commentPayload = () => ({
      id: 7,
      body: commentBody,
      html_url: "https://github.com/acme/repo/issues/42#issuecomment-7",
      issue_url: "https://api.github.com/repos/acme/repo/issues/42",
      user: { login: "viewer" },
      created_at: "2026-07-21T10:00:00.000Z",
      updated_at: "2026-07-21T10:00:00.000Z",
    });

    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method, pathname: `${url.pathname}${url.search}`, body });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer github_secret_token");

      if (url.pathname === "/user") {
        return Response.json({ login: "viewer", html_url: "https://github.com/viewer" });
      }
      if (url.pathname === "/repos/acme/repo") {
        return Response.json({
          full_name: "acme/repo",
          html_url: "https://github.com/acme/repo",
          permissions: { push: false },
        });
      }
      if (url.pathname === "/repos/acme/repo/labels" && method === "GET") {
        return Response.json([
          { name: "ork:todo", color: "D4C5F9" },
          { name: "ork:inprogress", color: "FBCA04" },
          { name: "ork:review", color: "0E8A16" },
        ]);
      }
      if (url.pathname === "/repos/acme/repo/issues" && method === "GET") {
        return Response.json([issuePayload()]);
      }
      if (url.pathname === "/repos/acme/repo/issues/42/comments" && method === "GET") {
        return Response.json([commentPayload()]);
      }
      if (url.pathname === "/repos/acme/repo/issues/42/comments" && method === "POST") {
        commentBody = String((body as { body: string }).body);
        return Response.json(commentPayload(), { status: 201 });
      }
      if (url.pathname === "/repos/acme/repo/issues/comments/7" && method === "GET") {
        return Response.json(commentPayload());
      }
      if (url.pathname === "/repos/acme/repo/issues/comments/7" && method === "PATCH") {
        commentBody = String((body as { body: string }).body);
        return Response.json({ ...commentPayload(), updated_at: "2026-07-24T11:00:00.000Z" });
      }
      if (url.pathname.startsWith("/repos/acme/repo/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        issueLabels = issueLabels.filter((candidate) => candidate.name !== label);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/repos/acme/repo/issues/42/labels" && method === "POST") {
        const labels = (body as { labels: string[] }).labels;
        issueLabels = [
          ...issueLabels,
          ...labels.map((name) => ({ name, color: "D4C5F9" })),
        ];
        return Response.json(issueLabels);
      }
      if (url.pathname === "/repos/acme/repo/issues/42" && method === "PATCH") {
        const update = body as { title?: string; body?: string; state?: string };
        if (update.title !== undefined) issueTitle = update.title;
        if (update.body !== undefined) issueBody = update.body;
        if (update.state !== undefined) issueState = update.state;
        return Response.json(issuePayload());
      }
      if (url.pathname === "/repos/acme/repo/issues/42" && method === "GET") {
        return Response.json(issuePayload());
      }
      throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}${url.search}`);
    }) as unknown as typeof fetch;

    try {
      const snapshot = await commands.get("get_github_issues")?.({ projectId: "project-1" }, context);
      expect(snapshot).toMatchObject({
        repository: { owner: "acme", name: "repo" },
        viewer: { login: "viewer" },
        issues: [{ number: 42, title: "Original issue", status: "backlog" }],
      });
      await expect(commands.get("get_github_issue")?.({
        projectId: "project-1",
        issueNumber: 42,
      }, context)).resolves.toMatchObject({
        number: 42,
        comments: [{ id: 7, body: "Original comment", canEdit: true }],
      });
      await expect(commands.get("update_github_issue")?.({
        projectId: "project-1",
        issueNumber: 42,
        title: "Updated issue",
        body: "Updated body",
      }, context)).resolves.toMatchObject({ title: "Updated issue", body: "Updated body" });
      const statusIssue = await commands.get("update_github_issue_status")?.({
        projectId: "project-1",
        issueNumber: 42,
        status: "todo",
      }, context) as { status: string; labels: Array<{ name: string }> };
      expect(statusIssue.status).toBe("todo");
      expect(statusIssue.labels.map((label) => label.name)).toEqual(["bug", "ork:todo"]);
      await expect(commands.get("add_github_issue_comment")?.({
        projectId: "project-1",
        issueNumber: 42,
        body: "New comment",
      }, context)).resolves.toMatchObject({ body: "New comment", canEdit: true });
      await expect(commands.get("update_github_issue_comment")?.({
        projectId: "project-1",
        issueNumber: 42,
        commentId: 7,
        body: "Edited comment",
      }, context)).resolves.toMatchObject({ body: "Edited comment", canEdit: true, isEdited: true });
      await expect(commands.get("close_github_issue")?.({
        projectId: "project-1",
        issueNumber: 42,
      }, context)).resolves.toMatchObject({ state: "closed" });

      expect(requests.filter((request) =>
        request.method === "DELETE" && request.pathname.includes("/issues/42/labels/")
      )).toHaveLength(3);
      expect(requests).toContainEqual({
        method: "POST",
        pathname: "/repos/acme/repo/issues/42/labels",
        body: { labels: ["ork:todo"] },
      });
      expect(JSON.stringify(await commands.get("get_github_issues")?.({
        projectId: "project-1",
      }, context))).not.toContain("github_secret_token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports actionable GitHub setup and sanitized API failures", async () => {
    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment());

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({ version: "1.0.0", global: {}, repositories: {} })),
    });
    await expect(commands.get("get_github_issues")?.({ projectId: "project-1" }, context))
      .rejects.toThrow("GitHub is not configured");

    Object.assign(context.storage, {
      getProject: mock(async () => null),
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
    });
    await expect(commands.get("get_github_issues")?.({ projectId: "missing" }, context))
      .rejects.toThrow("Project not found: missing");

    Object.assign(context.storage, {
      getProject: mock(async () => ({
        id: "project-1",
        name: "bad",
        gitUrl: "https://gitlab.com/acme/repo.git",
      })),
    });
    await expect(commands.get("get_github_issues")?.({ projectId: "project-1" }, context))
      .rejects.toThrow(/github\.com HTTPS or SSH URL/i);

    const originalFetch = globalThis.fetch;
    Object.assign(context.storage, {
      getProject: mock(async () => ({
        id: "project-1",
        name: "repo",
        gitUrl: "git@github.com:acme/repo.git",
      })),
    });
    globalThis.fetch = mock(async () =>
      Response.json(
        { message: "Bad credentials github_secret_token" },
        { status: 401, headers: { "x-ratelimit-remaining": "1" } },
      )
    ) as unknown as typeof fetch;
    try {
      let failure: Error | null = null;
      try {
        await commands.get("get_github_issues")?.({ projectId: "project-1" }, context);
      } catch (error) {
        failure = error as Error;
      }
      expect(failure?.message).toContain("GitHub authentication failed");
      expect(failure?.message).not.toContain("github_secret_token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Electron backend command registry", () => {



  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.
  const CLAUDE_CREDENTIAL_SYNC_DOCKER_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "start" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  if [ "$2" = "--user" ]; then exit 0; fi
  cat >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  printf '\\n--sync--\\n' >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 1
`;



  function claudeCredentialSyncContext(
    globalConfig: Record<string, unknown> = {},
  ): ReturnType<typeof createContext> {
    const environment = createEnvironment({
      id: "env-claude-cred",
      environmentType: "containerized",
      containerId: "container-1",
      status: "stopped",
    });
    const created = createContext(environment);
    created.context.storage.loadConfig = mock(async () => ({
      version: "1.0.0",
      global: { useHostGitHubCredentials: false, githubToken: "", ...globalConfig },
      repositories: {},
    }));
    return created;
  }



  test("serializes and persists idempotent GitHub completion comments", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: {
      pipelineId: string;
      repositoryOwner: string;
      repositoryName: string;
      issueNumber: number;
      status: "posted" | "failed";
      commentId?: string;
      postedAt?: string;
      error?: string;
    } | null = null;
    let commentCreateCalls = 0;

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
      getGitHubCompletionComment: mock(async () => completionRecord),
      saveGitHubCompletionComment: mock(async (record: typeof completionRecord) => {
        completionRecord = record;
        return record;
      }),
    });

    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      commentCreateCalls += 1;
      const payload = JSON.parse(String(init?.body)) as { body: string };
      expect(payload.body).toContain("<!-- orkestrator-github-run:pipeline-github -->");
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        id: 9001,
        body: payload.body,
        html_url: "https://github.com/acme/widget/issues/42#issuecomment-9001",
        created_at: "2026-07-24T12:00:00.000Z",
        updated_at: "2026-07-24T12:00:00.000Z",
        user: { login: "ork-user" },
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const args = {
      pipelineId: "pipeline-github",
      projectId: "project-1",
      repositoryOwner: "acme",
      repositoryName: "project",
      issueNumber: 42,
      body: "Result: Complete",
    };
    try {
      const [first, second] = await Promise.all([
        commands.get("post_github_completion_comment")?.(args, context),
        commands.get("post_github_completion_comment")?.(args, context),
      ]);

      expect(commentCreateCalls).toBe(1);
      expect(first).toEqual({
        status: "posted",
        commentId: "9001",
        postedAt: "2026-07-24T12:00:00.000Z",
      });
      expect(second).toEqual({
        status: "already-posted",
        commentId: "9001",
        postedAt: "2026-07-24T12:00:00.000Z",
      });
      expect(completionRecord).toMatchObject({
        pipelineId: "pipeline-github",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        status: "posted",
        commentId: "9001",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });



  test("recovers a GitHub completion comment accepted before local persistence", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    let completionRecord: Record<string, unknown> | null = {
      pipelineId: "pipeline-retry",
      repositoryOwner: "acme",
      repositoryName: "project",
      issueNumber: 42,
      status: "failed",
      error: "Connection reset",
    };
    let commentCreateCalls = 0;

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
      getGitHubCompletionComment: mock(async () => completionRecord),
      saveGitHubCompletionComment: mock(async (record: Record<string, unknown>) => {
        completionRecord = record;
        return record;
      }),
    });
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") commentCreateCalls += 1;
      return new Response(JSON.stringify([{
        id: 9002,
        body: "Done\n\n<!-- orkestrator-github-run:pipeline-retry -->",
        html_url: "https://github.com/acme/widget/issues/42#issuecomment-9002",
        created_at: "2026-07-24T12:05:00.000Z",
        updated_at: "2026-07-24T12:05:00.000Z",
        user: { login: "ork-user" },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      await expect(commands.get("post_github_completion_comment")?.({
        pipelineId: "pipeline-retry",
        projectId: "project-1",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        body: "Result: Complete",
      }, context)).resolves.toEqual({
        status: "already-posted",
        commentId: "9002",
        postedAt: "2026-07-24T12:05:00.000Z",
      });
      expect(commentCreateCalls).toBe(0);
      expect(completionRecord).toMatchObject({
        status: "posted",
        commentId: "9002",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });



  test("persists a sanitized GitHub completion API failure for retry", async () => {
    const originalFetch = globalThis.fetch;
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    const secret = "github_secret_token";
    let completionRecord: Record<string, unknown> | null = null;

    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: secret },
        repositories: {},
      })),
      getGitHubCompletionComment: mock(async () => completionRecord),
      saveGitHubCompletionComment: mock(async (record: Record<string, unknown>) => {
        completionRecord = record;
        return record;
      }),
    });
    globalThis.fetch = mock(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        message: `Forbidden for Bearer ${secret}`,
      }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await expect(commands.get("post_github_completion_comment")?.({
        pipelineId: "pipeline-failed",
        projectId: "project-1",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        body: "Result: Failed",
      }, context)).rejects.toThrow("GitHub denied permission");
      expect(completionRecord).toMatchObject({
        pipelineId: "pipeline-failed",
        repositoryOwner: "acme",
        repositoryName: "project",
        issueNumber: 42,
        status: "failed",
      });
      expect(String(completionRecord?.error)).toContain("Issues write access");
      expect(JSON.stringify(completionRecord)).not.toContain(secret);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });



  test("rejects a GitHub completion target outside the selected project repository", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();
    const getCompletion = mock(async () => null);
    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { githubToken: "github_secret_token" },
        repositories: {},
      })),
      getGitHubCompletionComment: getCompletion,
    });

    await expect(commands.get("post_github_completion_comment")?.({
      pipelineId: "pipeline-out-of-scope",
      projectId: "project-1",
      repositoryOwner: "other",
      repositoryName: "repository",
      issueNumber: 1,
      body: "Result: Complete",
    }, context)).rejects.toThrow("does not match the selected project");
    expect(getCompletion).not.toHaveBeenCalled();
  });

});

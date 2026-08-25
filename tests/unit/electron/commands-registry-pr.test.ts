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

  test("detects local PRs by listing all PRs for the environment branch", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-worktree-");
    const environment = createEnvironment({ worktreePath, branch: "feature/pr" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '[{"url":"https://github.com/acme/repo/pull/1","state":"CLOSED","mergeable":"MERGEABLE","updatedAt":"2026-01-01T00:00:00Z"},{"url":"https://github.com/acme/repo/pull/2","state":"OPEN","mergeable":"CONFLICTING","updatedAt":"2026-01-02T00:00:00Z"}]'
`,
      async (logPath) => {
        await expect(
          commands.get("detect_pr_local")?.(
            { environmentId: environment.id, branch: environment.branch },
            context,
          ),
        ).resolves.toEqual({
          url: "https://github.com/acme/repo/pull/2",
          state: "open",
          hasMergeConflicts: true,
        });

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain(
          "pr list --head feature/pr --state all --limit 30 --json url,state,mergeable,updatedAt",
        );
      },
    );
  });

  test("returns null when local PR listing reports no PRs", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-empty-");
    const environment = createEnvironment({ worktreePath, branch: "feature/no-pr" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '[]\\n'
`,
      async () => {
        await expect(
          commands.get("detect_pr_local")?.(
            { environmentId: environment.id, branch: environment.branch },
            context,
          ),
        ).resolves.toBeNull();
      },
    );
  });

  test("detects a PR from the live branch after stored branch drift from a rename", async () => {
    const worktreePath = await createGitRepoOnBranch("live-branch");
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath,
      branch: "renamed-environment",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '[{"url":"https://github.com/acme/repo/pull/17","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-08-25T17:43:11Z"}]'
`,
      async (logPath) => {
        await expect(
          commands.get("detect_pr_local")?.(
            { environmentId: environment.id, branch: environment.branch },
            context,
          ),
        ).resolves.toMatchObject({
          url: "https://github.com/acme/repo/pull/17",
          state: "open",
        });

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain("pr list --head live-branch");
        expect(ghLog).not.toContain("--head renamed-environment");
      },
    );
  });

  test.each([
    ["UNKNOWN mergeability", '"mergeable":"UNKNOWN"', null],
    ["missing mergeability", "", null],
    ["non-string mergeability", '"mergeable":42', null],
    ["lowercase mergeability", '"mergeable":"conflicting"', true],
  ] as const)(
    "preserves %s from local PR list detection",
    async (_label, mergeableField, expected) => {
      const worktreePath = await createTempDir("ork-electron-pr-mergeability-");
      const environment = createEnvironment({ worktreePath, branch: "feature/mergeability" });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const comma = mergeableField ? `,${mergeableField}` : "";

      await withFakeGh(
        `#!/bin/sh
printf '%s\n' '[{"url":"https://github.com/acme/repo/pull/3","state":"OPEN"${comma},"updatedAt":"2026-01-03T00:00:00Z"}]'
`,
        async () => {
          await expect(
            commands.get("detect_pr_local")?.(
              { environmentId: environment.id, branch: environment.branch },
              context,
            ),
          ).resolves.toEqual({
            url: "https://github.com/acme/repo/pull/3",
            state: "open",
            hasMergeConflicts: expected,
          });
        },
      );
    },
  );

  test("surfaces gh failures during local PR detection", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-fail-");
    const environment = createEnvironment({ worktreePath, branch: "feature/fail" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf 'auth required\\n' >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("detect_pr_local")?.(
            { environmentId: environment.id, branch: environment.branch },
            context,
          ),
        ).rejects.toThrow("auth required");
      },
    );
  });

  test("throws when local PR detection output is not valid JSON", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-badjson-");
    const environment = createEnvironment({ worktreePath, branch: "feature/bad" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf 'not-json{\\n'
`,
      async () => {
        await expect(
          commands.get("detect_pr_local")?.(
            { environmentId: environment.id, branch: environment.branch },
            context,
          ),
        ).rejects.toThrow("Failed to parse gh pr list output");
      },
    );
  });

  test("throws when local PR detection output is not a JSON array", async () => {
    const worktreePath = await createTempDir("ork-electron-pr-object-");
    const environment = createEnvironment({ worktreePath, branch: "feature/object" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/1"}'
`,
      async () => {
        await expect(
          commands.get("detect_pr_local")?.(
            { environmentId: environment.id, branch: environment.branch },
            context,
          ),
        ).rejects.toThrow("Failed to parse gh pr list output");
      },
    );
  });

  test("detects container PRs with gh pr list instead of gh pr view", async () => {
    const { context } = createContext(
      createEnvironment({
        id: "env-container",
        environmentType: "containerized",
        containerId: "container-1",
        status: "running",
        branch: "feature/container-pr",
      }),
    );
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *"git -C /workspace branch --show-current"*) printf '%s\\n' 'feature/container-pr'; exit 0 ;;
  esac
  printf '%s\\n' '[{"url":"https://github.com/acme/repo/pull/9","state":"MERGED","mergeable":"MERGEABLE","updatedAt":"2026-01-03T00:00:00Z"}]'
  exit 0
fi
exit 0
`,
      async (logs) => {
        await expect(
          commands.get("detect_pr")?.(
            { containerId: "container-1", branch: "feature/container-pr" },
            context,
          ),
        ).resolves.toEqual({
          url: "https://github.com/acme/repo/pull/9",
          state: "merged",
          hasMergeConflicts: false,
        });

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain(
          "gh pr list --head 'feature/container-pr' --state all --limit 30 --json url,state,mergeable,updatedAt",
        );
        expect(execLog).toContain("source /usr/local/bin/orkestrator-runtime-env.sh");
        expect(execLog).toContain("orkestrator_source_runtime_env");
        expect(execLog).not.toContain("gh pr view");
      },
    );
  });

  test("reports a container PR as merged only after verifying the captured PR URL", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'MERGED'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`,
      async (logs) => {
        await expect(
          commands.get("merge_pr")?.(
            { containerId: "container-1", method: "squash", deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "merged" });

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain(
          "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'",
        );
        expect(execLog).toContain(
          "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state'",
        );
      },
    );
  });

  test("marks a draft container PR ready before merging it", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'true'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'ready' 'https://github.com/acme/repo/pull/42'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'MERGED'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`,
      async (logs) => {
        await expect(
          commands.get("merge_pr")?.(
            { containerId: "container-1", method: "squash", deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "merged" });

        const execLog = await fs.readFile(logs.exec, "utf8");
        const readyCommand = "'gh' 'pr' 'ready' 'https://github.com/acme/repo/pull/42'";
        const mergeCommand = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--squash'";
        expect(execLog).toContain(readyCommand);
        expect(execLog.indexOf(readyCommand)).toBeLessThan(execLog.indexOf(mergeCommand));
      },
    );
  });

  test("stops container merges when draft inspection or readiness fails", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    for (const failure of ["draft-status", "ready"] as const) {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  ${failure === "draft-status" ? "printf 'draft lookup failed\\n' >&2; exit 41" : "printf 'true\\n'; exit 0"}
fi
if [ "$command" = "'gh' 'pr' 'ready' 'https://github.com/acme/repo/pull/42'" ]; then
  printf 'ready failed\\n' >&2
  exit 42
fi
printf 'merge must not be submitted: %s\\n' "$command" >&2
exit 43
`,
        async (logs) => {
          await expect(
            commands.get("merge_pr")?.(
              { containerId: "container-1", method: "squash", deleteBranch: false },
              context,
            ),
          ).rejects.toThrow(failure === "draft-status" ? "draft lookup failed" : "ready failed");

          const execLog = await fs.readFile(logs.exec, "utf8");
          expect(execLog).not.toContain("'gh' 'pr' 'merge'");
        },
      );
    }
  });

  test("reports a queued container PR as pending when the captured PR remains open", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--rebase' '--delete-branch'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'OPEN'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("merge_pr")?.(
            { containerId: "container-1", method: "rebase", deleteBranch: true },
            context,
          ),
        ).resolves.toEqual({ outcome: "pending" });
      },
    );
  });

  test("reports an unknown container merge outcome when post-submit verification fails", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--merge'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'temporary verification failure' >&2
  exit 1
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("merge_pr")?.(
            { containerId: "container-1", method: "merge", deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "unknown" });
      },
    );
  });

  test("merges local PRs through the GitHub API without updating worktree branches", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "squash", deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "merged" });

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain(
          "api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash",
        );
        expect(ghLog).not.toContain("pr merge");
        expect(ghLog).not.toContain("--delete-branch");
      },
    );
  });

  test("marks a draft local PR ready before merging it through the GitHub API", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-draft-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'true'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "squash", deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "merged" });

        const ghLog = await fs.readFile(logPath, "utf8");
        const readyCommand = "pr ready https://github.com/acme/repo/pull/42";
        const mergeCommand = "api repos/acme/repo/pulls/42/merge";
        expect(ghLog).toContain(readyCommand);
        expect(ghLog.indexOf(readyCommand)).toBeLessThan(ghLog.indexOf(mergeCommand));
      },
    );
  });

  test("stops local merges when draft inspection or readiness fails", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-failure-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    for (const failure of ["draft-status", "ready"] as const) {
      await withFakeGh(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  ${failure === "draft-status" ? "printf 'draft lookup failed\\n' >&2; exit 41" : "printf 'true\\n'; exit 0"}
fi
if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then
  printf 'ready failed\\n' >&2
  exit 42
fi
printf 'merge must not be submitted: %s\\n' "$*" >&2
exit 43
`,
        async (logPath) => {
          await expect(
            commands.get("merge_pr_local")?.(
              { environmentId: environment.id, method: "squash", deleteBranch: false },
              context,
            ),
          ).rejects.toThrow(failure === "draft-status" ? "draft lookup failed" : "ready failed");

          const ghLog = await fs.readFile(logPath, "utf8");
          expect(ghLog).not.toContain("api repos/acme/repo/pulls/42/merge");
        },
      );
    }
  });

  test("treats empty, null, and non-boolean draft output as non-draft", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-malformed-draft-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previousStatus = process.env.FAKE_DRAFT_STATUS;

    try {
      for (const status of ["", "null", "unexpected"]) {
        process.env.FAKE_DRAFT_STATUS = status;
        await withFakeGh(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' "$FAKE_DRAFT_STATUS"
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
          async (logPath) => {
            await expect(
              commands.get("merge_pr_local")?.(
                { environmentId: environment.id, method: "squash", deleteBranch: false },
                context,
              ),
            ).resolves.toEqual({ outcome: "merged" });

            const ghLog = await fs.readFile(logPath, "utf8");
            expect(ghLog).not.toContain("pr ready");
            expect(ghLog).toContain("api repos/acme/repo/pulls/42/merge");
          },
        );
      }
    } finally {
      if (previousStatus === undefined) delete process.env.FAKE_DRAFT_STATUS;
      else process.env.FAKE_DRAFT_STATUS = previousStatus;
    }
  });

  test("deletes the remote head branch after local API merge when requested", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/local-work","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/local-work" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "rebase", deleteBranch: true },
            context,
          ),
        ).resolves.toEqual({ outcome: "merged" });

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain("api repos/acme/repo/pulls/42");
        expect(ghLog).toContain(
          "api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=rebase",
        );
        expect(ghLog).toContain(
          "api repos/acme/repo/git/refs/heads/feature/local-work --method DELETE",
        );
        expect(ghLog).not.toContain("pr merge");
      },
    );
  });

  test("defaults local API merge method to squash", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-default-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "merged" });

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain(
          "api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash",
        );
      },
    );
  });

  test("does not report a local API merge as successful without an explicit merged response", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-unconfirmed-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":false,"message":"Merge is pending"}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "squash", deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "unknown" });
      },
    );
  });

  test("reports an unknown local API merge outcome when the response cannot be parsed", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-malformed-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' 'not-json'
  exit 0
fi
exit 1
`,
      async () => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "squash", deleteBranch: false },
            context,
          ),
        ).resolves.toEqual({ outcome: "unknown" });
      },
    );
  });

  test("rejects local API merge when the environment has no PR URL", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-no-pr-worktree-");
    const environment = createEnvironment({ worktreePath, prUrl: null });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("merge_pr_local")?.(
        { environmentId: environment.id, method: "squash", deleteBranch: false },
        context,
      ),
    ).rejects.toThrow("Local environment PR URL is not available");
  });

  test("rejects invalid local API merge inputs before invoking gh", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-invalid-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf 'gh should not be called\\n' >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "fast-forward", deleteBranch: false },
            context,
          ),
        ).rejects.toThrow("Invalid merge method: fast-forward");

        environment.prUrl = "https://example.com/acme/repo/pull/42";
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "squash", deleteBranch: false },
            context,
          ),
        ).rejects.toThrow("Invalid PR URL: https://example.com/acme/repo/pull/42");

        expect(existsSync(logPath)).toBe(false);
      },
    );
  });

  test("ignores a 404 while deleting the remote head branch after local API merge", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-404-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/already-deleted","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/already-deleted" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  printf '%s\\n' 'HTTP 404: Not Found' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "merge", deleteBranch: true },
            context,
          ),
        ).resolves.toEqual({ outcome: "merged" });

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain(
          "api repos/acme/repo/git/refs/heads/feature/already-deleted --method DELETE",
        );
      },
    );
  });

  test("propagates non-404 remote branch delete failures after local API merge", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-fail-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "isDraft" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ] && [ "$3" = "" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/protected","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ] && [ "$3" = "--method" ] && [ "$4" = "PUT" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/protected" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  printf '%s\\n' 'HTTP 403: Resource protected' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("merge_pr_local")?.(
            { environmentId: environment.id, method: "merge", deleteBranch: true },
            context,
          ),
        ).rejects.toThrow("HTTP 403: Resource protected");
      },
    );
  });

  test("persists merge cleanup intent before dispatch and completes local cleanup in the backend", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-cleanup-local-");
    const environment = createEnvironment({
      id: "env-merge-cleanup-local",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();
    const task = {
      id: "task-merge-cleanup",
      environmentId: environment.id,
      status: "in-progress",
      prUrl: environment.prUrl,
      prState: "open",
      prMergeCommented: false,
      comments: [] as Array<{ text: string }>,
    };
    context.storage.getKanbanTasks = mock(async () => [
      task,
    ]) as typeof context.storage.getKanbanTasks;
    context.storage.updateKanbanTask = mock(
      async (_taskId: string, taskUpdates: Record<string, unknown>) => ({
        ...task,
        ...taskUpdates,
      }),
    ) as typeof context.storage.updateKanbanTask;
    context.storage.addKanbanComment = mock(async (_taskId: string, text: string) => ({
      ...task,
      comments: [{ text }],
    })) as typeof context.storage.addKanbanComment;

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/backend-cleanup","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/backend-cleanup" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("merge_environment_pr")?.(
            {
              environmentId: environment.id,
              method: "squash",
              deleteBranch: true,
              cleanupAfterMerge: true,
            },
            context,
          ),
        ).resolves.toEqual({
          outcome: "merged",
          cleanupOutcome: "completed",
        });

        const intentIndex = updates.findIndex(
          (update) => typeof update.cleanupAfterMergeRequestedAt === "string",
        );
        const mergingIndex = updates.findIndex((update) => update.lifecycleOperation === "merging");
        expect(intentIndex).toBeGreaterThanOrEqual(0);
        expect(mergingIndex).toBeGreaterThan(intentIndex);
        expect(updates).toContainEqual(
          expect.objectContaining({
            prState: "merged",
            hasMergeConflicts: false,
          }),
        );
        expect(context.storage.updateKanbanTask).toHaveBeenCalledWith(task.id, {
          status: "review",
        });
        expect(context.storage.addKanbanComment).toHaveBeenCalledWith(
          task.id,
          `🎉 PR merged: ${environment.prUrl}`,
        );
        expect(context.storage.updateKanbanTask).toHaveBeenLastCalledWith(task.id, {
          prUrl: environment.prUrl,
          prState: "merged",
          prMergeCommented: true,
        });
        await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain(
          "api repos/acme/repo/pulls/42/merge --method PUT -f merge_method=squash",
        );
        expect(ghLog).toContain(
          "api repos/acme/repo/git/refs/heads/feature/backend-cleanup --method DELETE",
        );
      },
    );
  });

  test("keeps an unconfirmed container merge cleanup pending without deleting the environment", async () => {
    const environment = createEnvironment({
      id: "env-merge-cleanup-container-pending",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-pending",
      status: "stopped",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
command=""
for arg in "$@"; do command="$arg"; done
command="$(printf '%s\\n' "$command" | tail -n 1)"
if [ "$command" = "'gh' 'pr' 'view' '--json' 'url' '--jq' '.url'" ]; then
  printf '%s\\n' 'https://github.com/acme/repo/pull/42'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'isDraft' '--jq' '.isDraft'" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--rebase'" ]; then
  exit 0
fi
if [ "$command" = "'gh' 'pr' 'view' 'https://github.com/acme/repo/pull/42' '--json' 'state' '--jq' '.state'" ]; then
  printf '%s\\n' 'OPEN'
  exit 0
fi
printf 'unexpected docker command: %s\\n' "$command" >&2
exit 1
`,
      async (logs) => {
        const result = await commands.get("merge_environment_pr")?.(
          {
            environmentId: environment.id,
            method: "rebase",
            deleteBranch: true,
            cleanupAfterMerge: true,
          },
          context,
        );
        expect(result).toEqual({
          outcome: "pending",
          cleanupOutcome: "pending",
        });

        await expect(context.storage.getEnvironment(environment.id)).resolves.toMatchObject({
          cleanupAfterMergeRequestedAt: expect.any(String),
          cleanupAfterMergeError: null,
          prState: "open",
        });
        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain(
          "'gh' 'pr' 'merge' 'https://github.com/acme/repo/pull/42' '--rebase'",
        );
        expect(execLog).not.toContain("--delete-branch");
        expect(existsSync(logs.rm)).toBe(false);
      },
    );
  });

  test("continues confirmed cleanup when persisting merged PR state fails once", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-cleanup-persist-fail-");
    const environment = createEnvironment({
      id: "env-merge-cleanup-persist-fail",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    let rejectedMergedState = false;
    context.storage.updateEnvironment = mock(
      async (environmentId: string, updates: Partial<Environment>) => {
        if (updates.prState === "merged" && !rejectedMergedState) {
          rejectedMergedState = true;
          throw new Error("storage temporarily unavailable");
        }
        return updateEnvironment(environmentId, updates);
      },
    );

    await withFakeGh(
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/persist-fail","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/persist-fail" ]; then
  exit 0
fi
exit 1
`,
      async () => {
        await expect(
          commands.get("merge_environment_pr")?.(
            {
              environmentId: environment.id,
              method: "merge",
              deleteBranch: true,
              cleanupAfterMerge: true,
            },
            context,
          ),
        ).resolves.toEqual({
          outcome: "merged",
          cleanupOutcome: "completed",
        });
        expect(rejectedMergedState).toBe(true);
        await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();
      },
    );
  });

  test("verifies a PR against the trusted project and environment branches", async () => {
    const worktreePath = await createTempDir("ork-electron-verify-pr-");
    const environment = createEnvironment({
      worktreePath,
      branch: "feature/local",
    });
    const { context } = createContext(environment, {
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

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/42","headRefName":"feature/local","baseRefName":"main","state":"OPEN"}'
`,
      async (logPath) => {
        const verified = await commands.get("verify_environment_pr")?.(
          {
            environmentId: environment.id,
            prUrl: "https://github.com/acme/repo/pull/42",
            targetBranch: "main",
          },
          context,
        );
        expect(verified).toEqual({
          url: "https://github.com/acme/repo/pull/42",
          headRefName: "feature/local",
          baseRefName: "main",
          state: "OPEN",
        });
        expect(await fs.readFile(logPath, "utf8")).toContain(
          "pr view https://github.com/acme/repo/pull/42 --json url,headRefName,baseRefName,state",
        );
      },
    );

    await expect(
      commands.get("verify_environment_pr")?.(
        {
          environmentId: environment.id,
          prUrl: "https://github.com/other/repo/pull/42",
          targetBranch: "main",
        },
        context,
      ),
    ).rejects.toThrow("different repository");
    await expect(
      commands.get("verify_environment_pr")?.(
        {
          environmentId: environment.id,
          prUrl: "https://github.com/acme/repo/pull/42/",
          targetBranch: "main",
        },
        context,
      ),
    ).rejects.toThrow("canonical github.com URL");

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/42","headRefName":"other-branch","baseRefName":"main","state":"OPEN"}'
`,
      async () => {
        await expect(
          commands.get("verify_environment_pr")?.(
            {
              environmentId: environment.id,
              prUrl: "https://github.com/acme/repo/pull/42",
              targetBranch: "main",
            },
            context,
          ),
        ).rejects.toThrow("head branch does not match");
      },
    );
  });

  test(
    "deterministically generates refs, diff, Git-object contents, hashes, and validation evidence",
    async () => {
      const packageId = "package-1";
      const { worktreePath, artifactDirectory, baseRef, headRef, content } =
        await createReviewPackageWorktree({
          packageId,
          extraCommittedFiles: { "binary.dat": Buffer.from([0, 1, 2, 255]) },
        });
      await fs.writeFile(
        path.join(artifactDirectory, "validation-01.stdout.txt"),
        "TOKEN=visible-for-review\nall tests passed\n",
      );
      await fs.writeFile(
        path.join(artifactDirectory, "validation-01.stderr.txt"),
        "exact warning output\n",
      );
      await fs.writeFile(path.join(worktreePath, "review.txt"), "later worktree edit\n");
      await fs.writeFile(path.join(worktreePath, "unrelated.txt"), "leave me alone\n");
      const environment = createEnvironment({
        worktreePath,
        branch: "feature/local",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const args = {
        environmentId: environment.id,
        packageId,
        round: 2,
        targetBranch: "main",
        preparation: {
          validation: [
            {
              command: "bun test tests --parallel",
              status: "passed",
              exitCode: 0,
              stdoutPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
              stderrPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
              durationMs: 123,
              limitation: null,
            },
          ],
          uncommittedFiles: [
            {
              path: "review.txt",
              reason: "Later user edit after the prepared commit.",
            },
            {
              path: "unrelated.txt",
              reason: "Unrelated user file.",
            },
          ],
          limitations: [],
        },
      };

      const command = commands.get("generate_looped_review_package")!;
      const first = (await command(args, context)) as Record<string, unknown>;
      const second = (await command(args, context)) as Record<string, unknown>;
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        id: packageId,
        round: 2,
        targetBranch: "main",
        baseRef,
        headRef,
        commit: {
          sha: headRef,
          subject: "change",
          committedFiles: ["binary.dat", "review.txt"],
        },
        changedFiles: [
          {
            path: "binary.dat",
            status: "A",
            content: null,
            contentSha256: null,
            omittedReason: "Binary content is represented by the complete binary Git diff.",
          },
          {
            path: "review.txt",
            status: "M",
            content,
            contentSha256: createHash("sha256").update(content).digest("hex"),
            omittedReason: null,
          },
        ],
        validation: [
          {
            command: "bun test tests --parallel",
            status: "passed",
            exitCode: 0,
            stdout: "TOKEN=visible-for-review\nall tests passed\n",
            stderr: "exact warning output\n",
            durationMs: 123,
          },
        ],
        skippedFiles: [
          {
            path: "binary.dat",
            reason: "Binary content is represented by the complete binary Git diff.",
          },
        ],
        uncommittedFiles: [
          {
            path: "review.txt",
            reason: "Later user edit after the prepared commit.",
          },
          {
            path: "unrelated.txt",
            reason: "Unrelated user file.",
          },
        ],
        limitations: [],
      });
      // The context key is deliberately absent rather than null. The workflow
      // supplies it, and a null is not a valid ReviewPackageContext — persisting
      // one made the snapshot fail validation on its very next read.
      expect(first).not.toHaveProperty("context");
      // Same reason, for the same reason it is easy to miss: the preparation
      // agent reports `limitation: null` for a command that ran without one, but
      // the persisted contract is `limitation?: string`. Carrying that null
      // through made every package with an executed validation command
      // unpersistable, failing the round at `package` on a loop no retry escaped.
      expect((first.validation as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
        "limitation",
      );
      // The whole point of the shape assertions above: a generated package has to
      // survive the guard the backend runs before it saves the snapshot.
      expect(
        isLoopedReviewWorkflow(
          loopedReviewWorkflowAround(first, { round: 2, targetBranch: "main" }),
        ),
      ).toBe(true);
      expect(first.completeDiff).toContain("diff --git a/review.txt b/review.txt");
      expect(first.completeDiff).toContain("GIT binary patch");
      expect(first.completeDiff).toMatch(/index [a-f0-9]{40}\.\.[a-f0-9]{40}/);

      await expect(
        command(
          {
            ...args,
            preparation: {
              ...args.preparation,
              uncommittedFiles: [],
            },
          },
          context,
        ),
      ).rejects.toThrow("account for every uncommitted file");
      await expect(
        command(
          {
            ...args,
            preparation: {
              ...args.preparation,
              validation: [
                {
                  ...args.preparation.validation[0],
                  stdoutPath: "../validation.stdout.txt",
                },
              ],
            },
          },
          context,
        ),
      ).rejects.toThrow("parent directory traversal");

      // Agents commonly return the filename relative to the artifact directory
      // they were told to write into. Every spelling below names the same evidence
      // file, so all of them must produce the identical package.
      for (const [stdoutPath, stderrPath] of [
        ["validation-01.stdout.txt", "validation-01.stderr.txt"],
        ["./validation-01.stdout.txt", "./validation-01.stderr.txt"],
        [
          `.orkestrator\\review-artifacts\\${packageId}\\validation-01.stdout.txt`,
          `.orkestrator\\review-artifacts\\${packageId}\\validation-01.stderr.txt`,
        ],
        [
          `.orkestrator/review-artifacts/${packageId}/./validation-01.stdout.txt`,
          `.orkestrator/review-artifacts/${packageId}/./validation-01.stderr.txt`,
        ],
        // Only one of the pair needs rewriting for the package to stay identical.
        [
          "validation-01.stdout.txt",
          `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
        ],
      ]) {
        expect(
          await command(
            {
              ...args,
              preparation: {
                ...args.preparation,
                validation: [
                  {
                    ...args.preparation.validation[0],
                    stdoutPath,
                    stderrPath,
                  },
                ],
              },
            },
            context,
          ),
        ).toEqual(first);
      }

      // Anchoring a bare filename must not widen which file the backend reads: the
      // resolved path is still compared against the one the backend computed.
      for (const stdoutPath of [
        "validation-02.stdout.txt",
        "validation-1.stdout.txt",
        "validation-01.stdout.text",
        ".orkestrator/review-artifacts/other-package/validation-01.stdout.txt",
        `.orkestrator/review-artifacts/${packageId}/nested/validation-01.stdout.txt`,
      ]) {
        await expect(
          command(
            {
              ...args,
              preparation: {
                ...args.preparation,
                validation: [{ ...args.preparation.validation[0], stdoutPath }],
              },
            },
            context,
          ),
        ).rejects.toThrow("artifact paths are not deterministic");
      }

      // The rejection has to say what was expected, or a retrying agent has no way
      // to correct the path it sent.
      await expect(
        command(
          {
            ...args,
            preparation: {
              ...args.preparation,
              validation: [
                {
                  ...args.preparation.validation[0],
                  stdoutPath: "validation-02.stdout.txt",
                },
              ],
            },
          },
          context,
        ),
      ).rejects.toThrow(
        `expected .orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
      );

      for (const stdoutPath of ["/etc/passwd", ".git/config", ""]) {
        await expect(
          command(
            {
              ...args,
              preparation: {
                ...args.preparation,
                validation: [{ ...args.preparation.validation[0], stdoutPath }],
              },
            },
            context,
          ),
        ).rejects.toThrow(/Invalid validation\[0\]\.stdoutPath/);
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("hydrates validation evidence by array position, counting skipped commands", async () => {
    const packageId = "package-ordinals";
    const { worktreePath, artifactDirectory } = await createReviewPackageWorktree({
      packageId,
    });
    // Entry 1 is skipped and writes nothing, so the commands that did run own
    // ordinals 02 and 03 rather than 01 and 02.
    await fs.writeFile(
      path.join(artifactDirectory, "validation-02.stdout.txt"),
      "all tests passed\n",
    );
    await fs.writeFile(path.join(artifactDirectory, "validation-02.stderr.txt"), "");
    await fs.writeFile(path.join(artifactDirectory, "validation-03.stdout.txt"), "build output\n");
    await fs.writeFile(
      path.join(artifactDirectory, "validation-03.stderr.txt"),
      "error TS2345: build failed\n",
    );
    const environment = createEnvironment({
      worktreePath,
      branch: "feature/local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const command = commands.get("generate_looped_review_package")!;
    const skipped = {
      command: "bun run --cwd apps/ios typecheck",
      status: "skipped",
      exitCode: null,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      limitation: "Xcode is unavailable in this environment.",
    };
    const passed = {
      command: "bun test tests --parallel",
      status: "passed",
      exitCode: 0,
      stdoutPath: `.orkestrator/review-artifacts/${packageId}/validation-02.stdout.txt`,
      stderrPath: `.orkestrator/review-artifacts/${packageId}/validation-02.stderr.txt`,
      durationMs: 4200,
      limitation: null,
    };
    const failed = {
      command: "bun run build",
      status: "failed",
      exitCode: 2,
      // Bare filenames resolve against the artifact directory at their own
      // ordinal, not against the first entry's.
      stdoutPath: "validation-03.stdout.txt",
      stderrPath: "validation-03.stderr.txt",
      durationMs: 900,
      limitation: "Build ran against a stale cache.",
    };
    const args = {
      environmentId: environment.id,
      packageId,
      round: 1,
      targetBranch: "main",
      preparation: {
        validation: [skipped, passed, failed],
        uncommittedFiles: [],
        limitations: [],
      },
    };

    const generated = (await command(args, context)) as Record<string, unknown>;
    expect(generated.validation).toEqual([
      {
        command: "bun run --cwd apps/ios typecheck",
        status: "skipped",
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        limitation: "Xcode is unavailable in this environment.",
      },
      {
        command: "bun test tests --parallel",
        status: "passed",
        exitCode: 0,
        stdout: "all tests passed\n",
        stderr: "",
        durationMs: 4200,
        // No `limitation` key at all. The agent reports null for a command that
        // ran without one, but the persisted contract is `limitation?: string`
        // and its guard rejects null — see the assertion below.
      },
      {
        command: "bun run build",
        status: "failed",
        exitCode: 2,
        stdout: "build output\n",
        stderr: "error TS2345: build failed\n",
        durationMs: 900,
        limitation: "Build ran against a stale cache.",
      },
    ]);
    expect(
      isLoopedReviewWorkflow(
        loopedReviewWorkflowAround(generated, { round: 1, targetBranch: "main" }),
      ),
    ).toBe(true);

    // Dropping the skipped entry shifts every later entry's ordinal. Numbering
    // by execution order instead of array position would accept this.
    await expect(
      command(
        {
          ...args,
          preparation: { ...args.preparation, validation: [passed, failed] },
        },
        context,
      ),
    ).rejects.toThrow(
      `expected .orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
    );
  });

  test("reports a validation artifact the preparation agent never wrote", async () => {
    const packageId = "package-missing";
    const { worktreePath, artifactDirectory } = await createReviewPackageWorktree({
      packageId,
    });
    await fs.writeFile(
      path.join(artifactDirectory, "validation-01.stdout.txt"),
      "all tests passed\n",
    );
    const environment = createEnvironment({
      worktreePath,
      branch: "feature/local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const command = commands.get("generate_looped_review_package")!;
    const args = {
      environmentId: environment.id,
      packageId,
      round: 1,
      targetBranch: "main",
      preparation: {
        validation: [
          {
            command: "bun test tests --parallel",
            status: "passed",
            exitCode: 0,
            stdoutPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
            stderrPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
            durationMs: 123,
            limitation: null,
          },
        ],
        uncommittedFiles: [],
        limitations: [],
      },
    };

    // The stderr artifact is missing. Accepting a bare filename means a path can
    // now pass validation and still not exist, so the read has to say so in
    // review terms rather than surfacing a bare ENOENT.
    await expect(command(args, context)).rejects.toThrow(
      `Review artifact was not written by preparation: ` +
        `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
    );

    const stderrArtifact = path.join(artifactDirectory, "validation-01.stderr.txt");
    await fs.mkdir(stderrArtifact);
    await expect(command(args, context)).rejects.toThrow("Review artifact is not a regular file");
    await fs.rmdir(stderrArtifact);

    const outsideDirectory = await createTempDir("ork-electron-outside-artifact-");
    const outsideFile = path.join(outsideDirectory, "stderr.txt");
    await fs.writeFile(outsideFile, "escaped\n");
    await fs.symlink(outsideFile, stderrArtifact);
    await expect(command(args, context)).rejects.toThrow(
      "Review artifact escapes the environment worktree",
    );
    await fs.unlink(stderrArtifact);

    // Kept inside the artifact directory so it stays out of the uncommitted-file
    // reconciliation this test is not exercising.
    const insideFile = path.join(artifactDirectory, "real-stderr.txt");
    await fs.writeFile(insideFile, "inside\n");
    await fs.symlink(insideFile, stderrArtifact);
    await expect(command(args, context)).rejects.toThrow(
      "Review artifact must not traverse symbolic links",
    );
  });

  test("rejects preparation validation metadata that breaks the evidence contract", async () => {
    const environment = createEnvironment({
      worktreePath: "/tmp/worktree-unused",
      branch: "feature/local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const command = commands.get("generate_looped_review_package")!;
    const packageId = "package-contract";
    const ran = {
      command: "bun test tests --parallel",
      status: "passed",
      exitCode: 0,
      stdoutPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stdout.txt`,
      stderrPath: `.orkestrator/review-artifacts/${packageId}/validation-01.stderr.txt`,
      durationMs: 123,
      limitation: null,
    };
    const skipped = {
      command: "bun run --cwd apps/ios typecheck",
      status: "skipped",
      exitCode: null,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      limitation: "Xcode is unavailable in this environment.",
    };
    // Every case below is rejected while parsing the arguments, before any Git
    // command runs, so the worktree above is never touched.
    const call = (validation: unknown) =>
      command(
        {
          environmentId: environment.id,
          packageId,
          round: 1,
          targetBranch: "main",
          preparation: { validation, uncommittedFiles: [], limitations: [] },
        },
        context,
      );

    await expect(call({})).rejects.toThrow("Expected validation to be an array");
    await expect(call([null])).rejects.toThrow("Expected validation[0] to be an object");
    await expect(call([{ ...ran, extra: 1 }])).rejects.toThrow(
      "Unexpected validation[0] field: extra",
    );
    await expect(call([{ ...ran, command: "   " }])).rejects.toThrow(
      "Expected validation[0].command to be non-empty",
    );
    await expect(call([{ ...ran, status: "errored" }])).rejects.toThrow(
      "Invalid validation[0].status",
    );
    for (const durationMs of [-1, 1.5, "123", null]) {
      await expect(call([{ ...ran, durationMs }])).rejects.toThrow(
        "Expected validation[0].durationMs to be a non-negative integer",
      );
    }
    for (const limitation of ["", "   ", 7]) {
      await expect(call([{ ...ran, limitation }])).rejects.toThrow(
        "Expected validation[0].limitation to be a non-empty string or null",
      );
    }
    for (const override of [
      { exitCode: 0 },
      { stdoutPath: ran.stdoutPath },
      { stderrPath: ran.stderrPath },
      { limitation: null },
    ]) {
      await expect(call([{ ...skipped, ...override }])).rejects.toThrow(
        "Skipped validation[0] has incompatible evidence metadata",
      );
    }
    for (const exitCode of [null, "0", 1.5]) {
      await expect(call([{ ...ran, exitCode }])).rejects.toThrow(
        "Expected validation[0].exitCode to be an integer",
      );
    }
    await expect(call([{ ...ran, exitCode: 1 }])).rejects.toThrow(
      "Validation[0] status does not match its exit code",
    );
    await expect(call([{ ...ran, status: "failed", exitCode: 0 }])).rejects.toThrow(
      "Validation[0] status does not match its exit code",
    );
    await expect(call([{ ...ran, stderrPath: null }])).rejects.toThrow(
      "Expected validation[0].stderrPath to be a string",
    );
    // The index in the message is the entry's own position, not the first one's.
    await expect(call([skipped, { ...ran, exitCode: 1 }])).rejects.toThrow(
      "Validation[1] status does not match its exit code",
    );
  });

  test("waits for a local bridge server to pass health before persisting pid and port", async () => {
    const appRoot = await createTempDir("ork-electron-app-");
    const toolchainBinDir = await createTempDir("ork-electron-toolchain-");
    const worktreePath = await createTempDir("ork-electron-worktree-");
    const markerPath = path.join(appRoot, "codex-path.log");
    const versionMarkerPath = path.join(appRoot, "codex-version.log");
    const maxConcurrentThreadsMarkerPath = path.join(appRoot, "codex-max-threads.log");
    const managedCodexPath = path.join(toolchainBinDir, "codex");
    await fs.writeFile(managedCodexPath, "managed codex");
    await writeBridgeServer(
      appRoot,
      "codex-bridge",
      markerPath,
      undefined,
      versionMarkerPath,
      maxConcurrentThreadsMarkerPath,
    );

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment, {
      globalConfig: { codexMaxConcurrentThreads: 8 },
    });
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;

    const commands = createCommandRegistry();
    const result = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as {
      port: number;
      pid: number;
      wasRunning: boolean;
      authToken: string;
    };

    expect(result.wasRunning).toBe(false);
    expect(result.port).toBeGreaterThan(0);
    expect(result.pid).toBeGreaterThan(0);
    expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(updates).toContainEqual({ localCodexPort: result.port, codexBridgePid: result.pid });
    await expect(
      commands.get("get_local_codex_server_status")?.({ environmentId: environment.id }, context),
    ).resolves.toMatchObject({
      running: true,
      port: result.port,
      pid: result.pid,
      authToken: result.authToken,
    });
    await expect(requestOk(result.port, "/global/health")).resolves.toBe(true);
    expect(await fs.readFile(markerPath, "utf8")).toBe(managedCodexPath);
    expect(await fs.readFile(versionMarkerPath, "utf8")).toBe(APP_VERSION);
    expect(await fs.readFile(maxConcurrentThreadsMarkerPath, "utf8")).toBe("8");

    await commands.get("stop_local_codex_server_cmd")?.({ environmentId: environment.id }, context);
    await expect(
      commands.get("get_local_codex_server_status")?.({ environmentId: environment.id }, context),
    ).resolves.toEqual({
      running: false,
      port: null,
      pid: null,
    });

    const fallbackEnvironment = createEnvironment({
      id: "env-local-codex-fallback",
      worktreePath,
    });
    const { context: fallbackContext } = createContext(fallbackEnvironment, {
      globalConfig: { codexMaxConcurrentThreads: "invalid" },
    });
    fallbackContext.appRoot = appRoot;
    fallbackContext.resourceRoot = appRoot;
    fallbackContext.toolchainBinDir = toolchainBinDir;
    const fallbackResult = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: fallbackEnvironment.id },
      fallbackContext,
    )) as { port: number; pid: number; wasRunning: boolean };
    try {
      expect(fallbackResult.wasRunning).toBe(false);
      expect(await fs.readFile(maxConcurrentThreadsMarkerPath, "utf8")).toBe("5");
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: fallbackEnvironment.id },
        fallbackContext,
      );
    }
  });

  test(
    "does not report a child that exits while local status awaits storage as running",
    async () => {
      const appRoot = await createTempDir("ork-electron-app-status-exit-race-");
      const worktreePath = await createTempDir("ork-electron-worktree-status-exit-race-");
      await writeBridgeServer(appRoot, "codex-bridge");
      const environment = createEnvironment({ worktreePath });
      const { context } = createContext(environment);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commands = createCommandRegistry();

      const started = (await commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      )) as { port: number; pid: number };
      const lookupStarted = createDeferred();
      const releaseLookup = createDeferred();
      const getEnvironment = context.storage.getEnvironment.bind(context.storage);
      context.storage.getEnvironment = mock(async (environmentId: string) => {
        lookupStarted.resolve(undefined);
        await releaseLookup.promise;
        return getEnvironment(environmentId);
      });

      const statusPromise = commands.get("get_local_codex_server_status")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<unknown>;
      await lookupStarted.promise;
      try {
        process.kill(started.pid, "SIGTERM");
        await waitForCondition(
          () => commandTesting.getLocalServerProcess(`codex:${environment.id}`) === undefined,
          "exited Codex bridge ownership release",
        );
      } finally {
        releaseLookup.resolve(undefined);
      }

      await expect(statusPromise).resolves.toEqual({
        running: false,
        port: started.port,
        pid: started.pid,
      });
      expect(commandTesting.getLocalCodexBridgeToken(environment.id)).toBeUndefined();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("serializes simultaneous starts so one local server owns the key", async () => {
    const appRoot = await createTempDir("ork-electron-app-concurrent-start-");
    const worktreePath = await createTempDir("ork-electron-worktree-concurrent-start-");
    await writeBridgeServer(appRoot, "codex-bridge");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const [first, second] = await Promise.all([
      commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ port: number; pid: number; wasRunning: boolean }>,
      commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ port: number; pid: number; wasRunning: boolean }>,
    ]);

    try {
      expect(first.pid).toBe(second.pid);
      expect(first.port).toBe(second.port);
      expect([first.wasRunning, second.wasRunning].sort()).toEqual([false, true]);
      expect(isProcessRunning(first.pid)).toBe(true);
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test(
    "holds local server status behind an in-flight startup until its ready port is committed",
    async () => {
      const appRoot = await createTempDir("ork-electron-app-start-status-");
      const worktreePath = await createTempDir("ork-electron-worktree-start-status-");
      await writeBridgeServer(appRoot, "codex-bridge");
      const environment = createEnvironment({ worktreePath });
      const { context } = createContext(environment);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commitStarted = createDeferred();
      const releaseCommit = createDeferred();
      const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
      context.storage.updateEnvironment = mock(
        async (environmentId: string, update: Record<string, unknown>) => {
          if (typeof update.localCodexPort === "number") {
            commitStarted.resolve(undefined);
            await releaseCommit.promise;
          }
          return updateEnvironment(environmentId, update);
        },
      );
      const commands = createCommandRegistry();

      const startPromise = commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ port: number; pid: number; authToken: string }>;
      await commitStarted.promise;

      let statusReadStarted = false;
      const getEnvironment = context.storage.getEnvironment.bind(context.storage);
      context.storage.getEnvironment = mock(async (environmentId: string) => {
        statusReadStarted = true;
        return getEnvironment(environmentId);
      });

      const statusPromise = commands.get("get_local_codex_server_status")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{
        running: boolean;
        port: number | null;
        pid: number | null;
        authToken?: string;
      }>;
      try {
        expect(statusReadStarted).toBe(false);
      } finally {
        releaseCommit.resolve(undefined);
      }
      const [started, status] = await Promise.all([startPromise, statusPromise]);
      try {
        expect(status).toEqual({
          running: true,
          port: started.port,
          pid: started.pid,
          authToken: started.authToken,
        });
      } finally {
        await commands.get("stop_local_codex_server_cmd")?.(
          { environmentId: environment.id },
          context,
        );
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "runs queued status after a rejected startup and reports the cleaned stopped state",
    async () => {
      const appRoot = await createTempDir("ork-electron-app-rejected-start-status-");
      const worktreePath = await createTempDir("ork-electron-worktree-rejected-start-status-");
      await writeBridgeEntrypoint(appRoot, "codex-bridge", "process.exitCode = 23;");
      const environment = createEnvironment({
        worktreePath,
        localCodexPort: 40123,
        codexBridgePid: 50123,
      });
      const { context } = createContext(environment);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commands = createCommandRegistry();

      const startPromise = commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<unknown>;
      const statusPromise = commands.get("get_local_codex_server_status")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<unknown>;

      const [startResult, statusResult] = await Promise.allSettled([startPromise, statusPromise]);
      expect(startResult.status).toBe("rejected");
      if (startResult.status === "rejected") {
        expect(startResult.reason).toBeInstanceOf(Error);
        expect((startResult.reason as Error).message).toContain(
          "codex server exited before becoming healthy",
        );
      }
      expect(statusResult).toEqual({
        status: "fulfilled",
        value: {
          running: false,
          port: null,
          pid: null,
        },
      });
      expect(commandTesting.getLocalServerProcess(`codex:${environment.id}`)).toBeUndefined();
      expect(commandTesting.getLocalCodexBridgeToken(environment.id)).toBeUndefined();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("holds status behind an in-flight stop until process ownership and metadata are cleared", async () => {
    const environment = createEnvironment({
      id: "env-status-behind-stop",
      localCodexPort: 40124,
      codexBridgePid: 50124,
    });
    const { context } = createContext(environment);
    const child = createFakeChild(50124);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    const terminationStarted = createDeferred();
    const releaseTermination = createDeferred();
    commandTesting.setTerminateProcessTree(async () => {
      terminationStarted.resolve(undefined);
      await releaseTermination.promise;
      return true;
    });
    const commands = createCommandRegistry();

    const stopPromise = commands.get("stop_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;
    await terminationStarted.promise;

    let statusReadStarted = false;
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      statusReadStarted = true;
      return getEnvironment(environmentId);
    });
    const statusPromise = commands.get("get_local_codex_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    try {
      expect(statusReadStarted).toBe(false);
    } finally {
      releaseTermination.resolve(undefined);
    }
    await expect(Promise.all([stopPromise, statusPromise])).resolves.toEqual([
      undefined,
      { running: false, port: null, pid: null },
    ]);
  });

  test("serializes status across local server kinds for the same environment", async () => {
    const environment = createEnvironment({
      id: "env-cross-kind-status-order",
      localCodexPort: 40125,
      codexBridgePid: 50125,
      localClaudePort: 40126,
      claudeBridgePid: 50126,
    });
    const { context } = createContext(environment);
    const child = createFakeChild(50125);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    const terminationStarted = createDeferred();
    const releaseTermination = createDeferred();
    commandTesting.setTerminateProcessTree(async () => {
      terminationStarted.resolve(undefined);
      await releaseTermination.promise;
      return true;
    });
    const commands = createCommandRegistry();

    const stopPromise = commands.get("stop_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;
    await terminationStarted.promise;

    let claudeStatusReadStarted = false;
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      claudeStatusReadStarted = true;
      return getEnvironment(environmentId);
    });
    const claudeStatusPromise = commands.get("get_local_claude_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    try {
      expect(claudeStatusReadStarted).toBe(false);
    } finally {
      releaseTermination.resolve(undefined);
    }
    await expect(Promise.all([stopPromise, claudeStatusPromise])).resolves.toEqual([
      undefined,
      { running: false, port: 40126, pid: 50126 },
    ]);
  });

  test("serializes a stop queued behind startup and leaves metadata cleared", async () => {
    const appRoot = await createTempDir("ork-electron-app-start-stop-");
    const worktreePath = await createTempDir("ork-electron-worktree-start-stop-");
    await writeBridgeServer(appRoot, "codex-bridge");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const startPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{ port: number; pid: number }>;
    const stopPromise = commands.get("stop_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<void>;

    const started = await startPromise;
    await stopPromise;

    expect(isProcessRunning(started.pid)).toBe(false);
    expect(environment.localCodexPort).toBeNull();
    expect(environment.codexBridgePid).toBeNull();
  });

  test("does not spawn an in-flight local server after the bounded shutdown drain expires", async () => {
    const worktreePath = await createTempDir("ork-electron-local-start-shutdown-deadline-");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const originalGetEnvironment = context.storage.getEnvironment.bind(context.storage);
    let releaseLookup!: () => void;
    let markLookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let blocked = false;
    context.storage.getEnvironment = mock(async (environmentId) => {
      if (!blocked) {
        blocked = true;
        markLookupStarted();
        await lookupGate;
      }
      return originalGetEnvironment(environmentId);
    });
    const spawnAttempt = mock(() => {
      throw new Error("local server spawned after shutdown");
    });
    commandTesting.setSpawnLocalServerCommand(spawnAttempt as unknown as typeof spawnCommand);

    const start = commands.get("start_local_opencode_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<unknown>;
    await lookupStarted;

    await expect(shutdownLocalServers({ operationDrainTimeoutMs: 10 })).resolves.toBeUndefined();
    releaseLookup();

    await expect(start).rejects.toThrow(
      "Backend is shutting down; local servers cannot be started",
    );
    expect(spawnAttempt).not.toHaveBeenCalled();
  });

  test("reports and stops every local server kind through its public handlers", async () => {
    const environment = createEnvironment({
      id: "env-all-local-server-handlers",
      localOpencodePort: 40101,
      opencodePid: 94001,
      localClaudePort: 40102,
      claudeBridgePid: 94002,
      localCodexPort: 40103,
      codexBridgePid: 94003,
      localPiPort: 40104,
      piBridgePid: 94004,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const children = {
      opencode: createFakeChild(94001),
      claude: createFakeChild(94002),
      codex: createFakeChild(94003),
      pi: createFakeChild(94004),
    };
    for (const [kind, child] of Object.entries(children)) {
      commandTesting.setLocalServerProcess(`${kind}:${environment.id}`, child);
    }
    commandTesting.setTerminateProcessTree(async () => true);

    await expect(
      Promise.all([
        commands.get("get_local_opencode_server_status")?.(
          { environmentId: environment.id },
          context,
        ),
        commands.get("get_local_claude_server_status")?.(
          { environmentId: environment.id },
          context,
        ),
        commands.get("get_local_codex_server_status")?.({ environmentId: environment.id }, context),
        commands.get("get_local_pi_server_status")?.({ environmentId: environment.id }, context),
      ]),
    ).resolves.toEqual([
      { running: true, port: 40101, pid: 94001 },
      { running: true, port: 40102, pid: 94002 },
      { running: true, port: 40103, pid: 94003 },
      { running: true, port: 40104, pid: 94004 },
    ]);

    await expect(
      Promise.all([
        commands.get("stop_local_opencode_server_cmd")?.(
          { environmentId: environment.id },
          context,
        ),
        commands.get("stop_local_claude_server_cmd")?.({ environmentId: environment.id }, context),
        commands.get("stop_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
        commands.get("stop_local_pi_server_cmd")?.({ environmentId: environment.id }, context),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined, undefined]);

    expect(environment).toMatchObject({
      localOpencodePort: null,
      opencodePid: null,
      localClaudePort: null,
      claudeBridgePid: null,
      localCodexPort: null,
      codexBridgePid: null,
      localPiPort: null,
      piBridgePid: null,
    });
    for (const kind of Object.keys(children)) {
      expect(commandTesting.getLocalServerProcess(`${kind}:${environment.id}`)).toBeUndefined();
    }
  });

  test("launches the local claude bridge through the bundled bun binary in resources", async () => {
    // The bridges run on bun, not node. resolveBunBinary prefers the bun shipped
    // in app resources (resourceRoot/bin/bun) over a host PATH lookup; this proves
    // that preferred binary is the one actually spawned, and that bun can run the
    // bridge entrypoint end-to-end (health passes).
    const appRoot = await createTempDir("ork-electron-app-bun-");
    const resourceRoot = await createTempDir("ork-electron-res-bun-");
    const worktreePath = await createTempDir("ork-electron-worktree-bun-");
    await writeBridgeServer(appRoot, "claude-bridge");

    const markerPath = path.join(resourceRoot, "bun-was-used.log");
    const bunWrapperDir = path.join(resourceRoot, "bin");
    await fs.mkdir(bunWrapperDir, { recursive: true });
    // Wrapper records that it ran, then delegates to the real bun on PATH.
    await fs.writeFile(
      path.join(bunWrapperDir, "bun"),
      `#!/bin/sh\nprintf 'used\\n' >> "${markerPath}"\nexec bun "$@"\n`,
    );
    await fs.chmod(path.join(bunWrapperDir, "bun"), 0o755);

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = resourceRoot;

    const commands = createCommandRegistry();
    const result = (await commands.get("start_local_claude_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as {
      port: number;
      pid: number;
      wasRunning: boolean;
      authToken: string;
    };

    try {
      expect(result.wasRunning).toBe(false);
      expect(result.port).toBeGreaterThan(0);
      expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(requestOk(result.port, "/global/health")).resolves.toBe(true);
      expect(await fs.readFile(markerPath, "utf8")).toContain("used");
      expect(updates).toContainEqual({ localClaudePort: result.port, claudeBridgePid: result.pid });
      await expect(
        commands.get("get_local_claude_server_status")?.(
          { environmentId: environment.id },
          context,
        ),
      ).resolves.toMatchObject({
        running: true,
        port: result.port,
        pid: result.pid,
        authToken: result.authToken,
      });
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("peeks a local bridge without ever starting one", async () => {
    // The activity sweep polls every environment every two seconds. Resolving
    // its connection through `start_local_*_server_cmd` would spawn a bridge
    // for every environment that has ever held a session — at startup, with no
    // tab open — and then keep them all alive. Peeking must therefore report a
    // bridge that is already running and never create one.
    const appRoot = await createTempDir("ork-electron-app-peek-local-");
    const worktreePath = await createTempDir("ork-electron-worktree-peek-local-");
    await writeBridgeServer(appRoot, "claude-bridge");

    const environment = createEnvironment({ id: "env-peek-local", worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    // Nothing running yet: null, and no process spawned as a side effect.
    const spawnAttempt = mock(() => {
      throw new Error("peek must not spawn a bridge");
    });
    commandTesting.setSpawnLocalServerCommand(spawnAttempt as unknown as typeof spawnCommand);
    await expect(
      commands.get("peek_local_agent_bridge")?.(
        { environmentId: environment.id, agent: "claude" },
        context,
      ),
    ).resolves.toBeNull();
    expect(spawnAttempt).not.toHaveBeenCalled();
    commandTesting.setSpawnLocalServerCommand(spawnCommand);

    const started = (await commands.get("start_local_claude_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as { port: number; authToken: string };
    try {
      await expect(
        commands.get("peek_local_agent_bridge")?.(
          { environmentId: environment.id, agent: "claude" },
          context,
        ),
      ).resolves.toEqual({
        port: started.port,
        authToken: started.authToken,
      });

      // A different agent shares the environment but has no bridge of its own.
      await expect(
        commands.get("peek_local_agent_bridge")?.(
          { environmentId: environment.id, agent: "codex" },
          context,
        ),
      ).resolves.toBeNull();
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }

    // Once stopped it reports null again rather than resurrecting the bridge.
    await expect(
      commands.get("peek_local_agent_bridge")?.(
        { environmentId: environment.id, agent: "claude" },
        context,
      ),
    ).resolves.toBeNull();
  });

  test("rejects an unknown agent on either peek surface", async () => {
    const environment = createEnvironment({ id: "env-peek-validation" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    // Validation runs before the handler returns a promise, so these throw
    // synchronously; `invoke` awaits the handler and surfaces them either way.
    expect(() =>
      commands.get("peek_local_agent_bridge")?.(
        { environmentId: environment.id, agent: "gemini" },
        context,
      ),
    ).toThrow("agent must be one of: opencode, claude, codex");
    expect(() =>
      commands.get("peek_container_agent_bridge")?.(
        { containerId: "container-1", agent: "gemini" },
        context,
      ),
    ).toThrow("agent must be one of: opencode, claude, codex");
    expect(() =>
      commands.get("peek_local_agent_bridge")?.({ environmentId: "  ", agent: "claude" }, context),
    ).toThrow();
    expect(() =>
      commands.get("peek_container_agent_bridge")?.(
        { containerId: "container-1", agent: "claude", extra: 1 },
        context,
      ),
    ).toThrow();
  });

  test("restarts a healthy local Claude bridge whose auth token this process no longer holds", async () => {
    const appRoot = await createTempDir("ork-electron-app-tokenless-claude-");
    const worktreePath = await createTempDir("ork-electron-worktree-tokenless-claude-");
    await writeBridgeServer(appRoot, "claude-bridge");

    const environment = createEnvironment({ id: "env-local-tokenless-claude", worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const first = (await commands.get("start_local_claude_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as { port: number; pid: number; authToken: string };
    expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A bridge inherited from a previous backend process: still healthy, but its
    // token was never handed to us, so the renderer could not authenticate.
    commandTesting.deleteLocalClaudeBridgeToken(environment.id);

    const second = (await commands.get("start_local_claude_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as { port: number; pid: number; wasRunning: boolean; authToken: string };
    try {
      expect(second.wasRunning).toBe(false);
      expect(second.pid).not.toBe(first.pid);
      expect(second.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.authToken).not.toBe(first.authToken);
      expect(isProcessRunning(first.pid)).toBe(false);
      await expect(requestOk(second.port, "/global/health")).resolves.toBe(true);
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("does not persist local bridge process state when the bridge entrypoint is missing", async () => {
    const appRoot = await createTempDir("ork-electron-app-missing-");
    const worktreePath = await createTempDir("ork-electron-worktree-missing-");
    await fs.mkdir(path.join(appRoot, "bridges", "codex-bridge"), { recursive: true });

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;

    const commands = createCommandRegistry();
    await expect(
      commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("codex bridge entrypoint not found");
    expect(updates).toHaveLength(0);
  });

  test("replaces an unhealthy local bridge process before restarting it", async () => {
    const appRoot = await createTempDir("ork-electron-app-stale-bridge-");
    const worktreePath = await createTempDir("ork-electron-worktree-stale-bridge-");
    await writeBridgeEntrypoint(
      appRoot,
      "codex-bridge",
      `
        const http = require("node:http");
        const server = http.createServer((req, res) => {
          if (req.url === "/disable") {
            res.writeHead(200);
            res.end();
            server.close();
            return;
          }
          res.writeHead(req.url === "/global/health" ? 200 : 404);
          res.end();
        });
        server.listen(Number(process.env.PORT), "127.0.0.1");
        setInterval(() => {}, 60_000);
      `,
    );

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const first = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as { port: number; pid: number; wasRunning: boolean };
    expect(first.wasRunning).toBe(false);
    await expect(requestOk(first.port, "/disable")).resolves.toBe(true);
    await commandTesting.waitForUnhealthy(first.port);

    const replacementCommitStarted = createDeferred();
    const releaseReplacementCommit = createDeferred();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    context.storage.updateEnvironment = mock(
      async (environmentId: string, update: Record<string, unknown>) => {
        if (typeof update.localCodexPort === "number") {
          replacementCommitStarted.resolve(undefined);
          await releaseReplacementCommit.promise;
        }
        return updateEnvironment(environmentId, update);
      },
    );

    const replacementPromise = commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{
      port: number;
      pid: number;
      wasRunning: boolean;
      authToken: string;
    }>;
    await replacementCommitStarted.promise;

    let statusReadStarted = false;
    const getEnvironment = context.storage.getEnvironment.bind(context.storage);
    context.storage.getEnvironment = mock(async (environmentId: string) => {
      statusReadStarted = true;
      return getEnvironment(environmentId);
    });
    const statusPromise = commands.get("get_local_codex_server_status")?.(
      { environmentId: environment.id },
      context,
    ) as Promise<{
      running: boolean;
      port: number | null;
      pid: number | null;
      authToken?: string;
    }>;
    try {
      expect(statusReadStarted).toBe(false);
    } finally {
      releaseReplacementCommit.resolve(undefined);
    }
    const [second, status] = await Promise.all([replacementPromise, statusPromise]);
    try {
      expect(second.wasRunning).toBe(false);
      expect(second.pid).not.toBe(first.pid);
      expect(second.port).not.toBe(first.port);
      expect(updates.at(-1)).toEqual({
        localCodexPort: second.port,
        codexBridgePid: second.pid,
      });
      expect(status).toEqual({
        running: true,
        port: second.port,
        pid: second.pid,
        authToken: second.authToken,
      });
      await expect(requestOk(second.port, "/global/health")).resolves.toBe(true);
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("restarts a healthy local Codex bridge whose auth token this process no longer holds", async () => {
    const appRoot = await createTempDir("ork-electron-app-tokenless-bridge-");
    const worktreePath = await createTempDir("ork-electron-worktree-tokenless-bridge-");
    await writeBridgeServer(appRoot, "codex-bridge");

    const environment = createEnvironment({ id: "env-local-tokenless", worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    const first = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as { port: number; pid: number; authToken: string };
    expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A bridge inherited from a previous backend process: still healthy, but its
    // token was never handed to us, so the renderer could not authenticate.
    commandTesting.deleteLocalCodexBridgeToken(environment.id);

    const second = (await commands.get("start_local_codex_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as { port: number; pid: number; wasRunning: boolean; authToken: string };
    try {
      expect(second.wasRunning).toBe(false);
      expect(second.pid).not.toBe(first.pid);
      expect(second.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.authToken).not.toBe(first.authToken);
      expect(isProcessRunning(first.pid)).toBe(false);
      await expect(requestOk(second.port, "/global/health")).resolves.toBe(true);
    } finally {
      await commands.get("stop_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("forgets the local Codex bridge token when the process cannot be spawned", async () => {
    const appRoot = await createTempDir("ork-electron-app-spawn-failure-");
    const worktreePath = await createTempDir("ork-electron-worktree-spawn-failure-");
    await writeBridgeServer(appRoot, "codex-bridge");

    const environment = createEnvironment({ id: "env-local-spawn-failure", worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();
    commandTesting.setSpawnLocalServerCommand(() => {
      throw new Error("spawn refused");
    });

    try {
      await expect(
        commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
      ).rejects.toThrow("spawn refused");
      expect(commandTesting.getLocalCodexBridgeToken(environment.id)).toBeUndefined();
      expect(updates).toHaveLength(0);
    } finally {
      commandTesting.setSpawnLocalServerCommand(spawnCommand);
    }
  });

  test("clears persisted local bridge state when startup exits before health", async () => {
    const appRoot = await createTempDir("ork-electron-app-failed-bridge-");
    const worktreePath = await createTempDir("ork-electron-worktree-failed-bridge-");
    await writeBridgeEntrypoint(appRoot, "codex-bridge", `process.exitCode = 23;`);

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    await expect(
      commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("codex server exited before becoming healthy");
    expect(updates).toContainEqual({
      localCodexPort: null,
      codexBridgePid: null,
    });
    expect(environment.localCodexPort).toBeNull();
    expect(environment.codexBridgePid).toBeNull();
  });

  test("reports both startup and cleanup failures while clearing persisted state", async () => {
    const appRoot = await createTempDir("ork-electron-app-failed-bridge-cleanup-");
    const worktreePath = await createTempDir("ork-electron-worktree-failed-bridge-cleanup-");
    await writeBridgeEntrypoint(appRoot, "codex-bridge", `process.exitCode = 23;`);

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();
    commandTesting.setTerminateProcessTree(async () => false);

    await expect(
      commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("Failed to start and clean up local server");
    expect(updates).toContainEqual({
      localCodexPort: null,
      codexBridgePid: null,
    });
    expect(environment.localCodexPort).toBeNull();
    expect(environment.codexBridgePid).toBeNull();
    commandTesting.setTerminateProcessTree(async () => true);
  });
});

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



  test("retains an exited terminal snapshot long enough for desync recovery", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-buffer-");
    const environment = createEnvironment({
      id: "env-local-terminal-buffer",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);

    ptyProcesses[0]?.emitData("hello from shell\r\n");
    const buffer = await commands.get("get_terminal_output_buffer")?.({ sessionId }, context) as string;
    expect(buffer).toContain("hello from shell");

    const beforeExit = await commands.get("get_terminal_output_snapshot")?.(
      { sessionId },
      context,
    );
    ptyProcesses[0]?.emitExit({ exitCode: 0 });
    expect(
      await commands.get("get_terminal_output_snapshot")?.({ sessionId }, context),
    ).toEqual(beforeExit);
    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(1);

    // Retention is bounded in time; pin the expiry result without making the
    // suite sleep for the production recovery window.
    commandTesting.deleteRetainedTerminalOutputBuffer(sessionId);
    expect(
      await commands.get("get_terminal_output_snapshot")?.({ sessionId }, context),
    ).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(0);
  }, ASYNC_TEST_BUDGET_MS);



  test("returns terminal deltas and falls back across output generations", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-delta-");
    const environment = createEnvironment({
      id: "env-local-terminal-delta",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);
    ptyProcesses[0]?.emitData("first");
    ptyProcesses[0]?.emitData(" second");

    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 0,
      sinceGeneration: 1,
    }, context)).toEqual({
      mode: "delta",
      output: "first second",
      deltas: [
        { revision: 1, text: "first" },
        { revision: 2, text: " second" },
      ],
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 1,
      sinceGeneration: 1,
    }, context)).toEqual({
      mode: "delta",
      output: " second",
      deltas: [{ revision: 2, text: " second" }],
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 2,
      sinceGeneration: 1,
    }, context)).toEqual({
      mode: "delta",
      output: "",
      deltas: [],
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 1,
      sinceGeneration: 0,
    }, context)).toMatchObject({
      mode: "full",
      reason: "generation-changed",
      output: "first second",
      revision: 2,
      generation: 1,
    });

    // The terminal WebSocket acknowledges writes, so a write that never reached
    // a shell has to be distinguishable from one that did. Reporting it as
    // delivered would tell the user a keystroke landed in a dead terminal.
    expect(commands.get("terminal_write")?.({ sessionId, data: "x" }, context))
      .toEqual({ delivered: true });
    expect(commands.get("terminal_resize")?.({ sessionId, cols: 80, rows: 24 }, context))
      .toEqual({ delivered: true });
    expect(commands.get("terminal_write")?.({ sessionId: "missing-session", data: "x" }, context))
      .toEqual({ delivered: false });
    expect(commands.get("terminal_resize")?.({ sessionId: "missing-session", cols: 80, rows: 24 }, context))
      .toEqual({ delivered: false });
    expect(commands.get("local_terminal_write")?.({ sessionId: "missing-session", data: "x" }, context))
      .toEqual({ delivered: false });
    expect(commands.get("local_terminal_resize")?.({
      sessionId: "missing-session", cols: 80, rows: 24,
    }, context)).toEqual({ delivered: false });
    for (let index = 0; index < 1_025; index += 1) {
      ptyProcesses[0]?.emitData("x");
    }
    expect(commands.get("get_terminal_output_snapshot")?.({
      sessionId,
      sinceRevision: 2,
      sinceGeneration: 1,
    }, context)).toMatchObject({
      mode: "full",
      reason: "expired",
      revision: 1_027,
      generation: 1,
    });
  }, ASYNC_TEST_BUDGET_MS);



  test("expires an exited terminal snapshot through the production timer path", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-buffer-expiry-");
    const environment = createEnvironment({
      id: "env-local-terminal-buffer-expiry",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.setTerminalOutputRetentionMs(5);

    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    ptyProcesses.at(-1)?.emitData("short-lived tail");
    ptyProcesses.at(-1)?.emitExit({ exitCode: 0 });
    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(0);
    expect(commands.get("get_terminal_output_snapshot")?.({ sessionId }, context))
      .toEqual({ output: "", revision: 0, generation: 0, truncated: false });
  }, ASYNC_TEST_BUDGET_MS);



  test("an explicitly closed terminal does not retain its output snapshot", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-explicit-close-");
    const environment = createEnvironment({
      id: "env-local-terminal-explicit-close",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    ptyProcesses.at(-1)?.emitData("user closed this terminal");

    await commands.get("close_local_terminal_session")?.({ sessionId }, context);

    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(0);
    expect(commands.get("get_terminal_output_snapshot")?.({ sessionId }, context))
      .toEqual({ output: "", revision: 0, generation: 0, truncated: false });
  }, ASYNC_TEST_BUDGET_MS);



  test("bounds retained exited terminal snapshots and evicts the oldest", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-retention-cap-");
    const environment = createEnvironment({
      id: "env-local-terminal-retention-cap",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const sessionIds: string[] = [];

    for (let index = 0; index < 33; index += 1) {
      const sessionId = terminalSessionResult(
        await commands.get("create_local_terminal_session")?.(
          { environmentId: environment.id, cols: 80, rows: 24 },
          context,
        ),
      ).sessionId;
      sessionIds.push(sessionId);
      await commands.get("start_local_terminal_session")?.({ sessionId }, context);
      const process = ptyProcesses.at(-1)!;
      process.emitData(`snapshot-${index}`);
      process.emitExit({ exitCode: 0 });
    }

    expect(commandTesting.retainedTerminalOutputBufferCount()).toBe(32);
    expect(
      await commands.get("get_terminal_output_snapshot")?.(
        { sessionId: sessionIds[0] },
        context,
      ),
    ).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
    expect(
      await commands.get("get_terminal_output_snapshot")?.(
        { sessionId: sessionIds.at(-1) },
        context,
      ),
    ).toEqual({
      output: "snapshot-32",
      revision: 1,
      generation: 1,
      truncated: false,
    });
  }, ASYNC_TEST_BUDGET_MS);



  test("caps the terminal output buffer at the maximum size", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-cap-");
    const environment = createEnvironment({
      id: "env-local-terminal-cap",
      environmentType: "local",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const maxChars = 500 * 1024;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await waitForPtyProcessCount(1);

    ptyProcesses[0]?.emitData("A".repeat(maxChars));
    ptyProcesses[0]?.emitData("B".repeat(1024));
    for (let index = 0; index < 2_048; index += 1) {
      ptyProcesses[0]?.emitData("x");
    }
    expect(commandTesting.terminalOutputBufferStats(sessionId)).toMatchObject({
      chars: maxChars,
      sequence: 2_050,
      chunks: expect.any(Number),
    });
    expect(commandTesting.terminalOutputBufferStats(sessionId).chunks)
      .toBeLessThanOrEqual(1_024);
    const buffer = await commands.get("get_terminal_output_buffer")?.({ sessionId }, context) as string;
    expect(buffer.length).toBe(maxChars);
    expect(buffer.endsWith(`${"B".repeat(1024)}${"x".repeat(2_048)}`)).toBe(true);
    expect(buffer.startsWith("A")).toBe(true);
    expect(commands.get("get_terminal_output_snapshot")?.({ sessionId }, context)).toEqual({
      output: buffer,
      revision: 2_050,
      generation: 1,
      truncated: true,
    });
  }, ASYNC_TEST_BUDGET_MS);



  test("does not split a Unicode surrogate pair at the terminal transcript boundary", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-unicode-cap-");
    const environment = createEnvironment({
      id: "env-local-terminal-unicode-cap",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const maxChars = 500 * 1024;
    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        terminalKey: "unicode-tab",
        cols: 80,
        rows: 24,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    // The nominal cutoff lands between the high and low surrogate. The backend
    // drops the complete astral character rather than returning malformed UTF-16.
    ptyProcesses[0]?.emitData(`😀${"A".repeat(maxChars - 1)}`);
    const snapshot = commands.get("get_terminal_output_snapshot")?.(
      { sessionId },
      context,
    ) as { output: string; truncated: boolean };
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.output).toBe("A".repeat(maxChars - 1));
    expect(snapshot.output).not.toContain("\ufffd");
    expect(Buffer.from(snapshot.output, "utf8").toString("utf8")).toBe(snapshot.output);
  }, ASYNC_TEST_BUDGET_MS);



  test("does not leave a low surrogate when the trimmed pair spans PTY chunks", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-unicode-chunks-");
    const environment = createEnvironment({
      id: "env-local-terminal-unicode-chunks",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const maxChars = 500 * 1024;
    const sessionId = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        { environmentId: environment.id, cols: 80, rows: 24 },
        context,
      ),
    ).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    // The high and low halves arrive in distinct PTY callbacks. Trimming the
    // oldest code unit therefore drops an entire chunk and must also advance
    // into the next one to remove the orphaned low half.
    ptyProcesses.at(-1)?.emitData("\ud83d");
    ptyProcesses.at(-1)?.emitData(`\ude00${"A".repeat(maxChars - 1)}`);

    const snapshot = commands.get("get_terminal_output_snapshot")?.(
      { sessionId },
      context,
    ) as { output: string; truncated: boolean };
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.output).toBe("A".repeat(maxChars - 1));
    expect(snapshot.output.charCodeAt(0)).not.toBe(0xde00);
    expect(Buffer.from(snapshot.output, "utf8").toString("utf8")).toBe(snapshot.output);
  }, ASYNC_TEST_BUDGET_MS);



  test("reports local git stats against origin target and includes untracked files", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    await fs.writeFile(path.join(worktree, "new file.txt"), "one\ntwo\n");
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "tracked.txt",
      additions: 1,
      deletions: 0,
      status: "M",
    }));
    expect(changes).toContainEqual(expect.objectContaining({
      path: "new file.txt",
      additions: 2,
      deletions: 0,
      status: "?",
    }));
  });



  // Untracked files are line-counted by a streaming walk rather than by reading
  // and splitting the file, so these pin the counts the walk has to reproduce.
  test("counts untracked file lines across line endings, encodings and sizes", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const cases: Array<{ name: string; contents: Buffer | string; expected: number }> = [
      { name: "trailing-newline.txt", contents: "one\ntwo\n", expected: 2 },
      { name: "no-trailing-newline.txt", contents: "one\ntwo", expected: 2 },
      { name: "crlf.txt", contents: "one\r\ntwo\r\n", expected: 2 },
      { name: "cr-only.txt", contents: "one\rtwo\r", expected: 2 },
      { name: "mixed-endings.txt", contents: "one\r\ntwo\nthree\r", expected: 3 },
      { name: "single-newline.txt", contents: "\n", expected: 1 },
      { name: "no-newline-at-all.txt", contents: "solo", expected: 1 },
      { name: "empty.txt", contents: "", expected: 0 },
      { name: "unicode.txt", contents: "héllo 🌍\nsecond\n", expected: 2 },
      // Spans several 64KB read windows, including a separator pair that
      // straddles a window boundary.
      { name: "large.txt", contents: `${"x".repeat(65_535)}\r\n${"y".repeat(70_000)}\n`, expected: 2 },
      { name: "binary.bin", contents: Buffer.from([0x41, 0x00, 0x42, 0x0a]), expected: 0 },
    ];
    for (const { name, contents } of cases) {
      await fs.writeFile(path.join(worktree, name), contents);
    }
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    for (const { name, expected } of cases) {
      expect(changes).toContainEqual(expect.objectContaining({
        path: name,
        additions: expected,
        status: "?",
      }));
    }
  });



  test("counts an oversized untracked file as zero rather than reading it", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const oversized = path.join(worktree, "oversized.log");
    const handle = await fs.open(oversized, "w");
    try {
      // Sparse: the size check must reject it without the content being read.
      await handle.truncate(11 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "oversized.log",
      additions: 0,
      status: "?",
    }));
  });



  test("does not follow an untracked symlink out of the worktree", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const outside = await createTempDir("ork-electron-outside-");
    const secretPath = path.join(outside, "secret.txt");
    await fs.writeFile(secretPath, "one\ntwo\nthree\nfour\nfive\n");
    await fs.symlink(secretPath, path.join(worktree, "link.txt"));
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "link.txt",
      additions: 0,
      status: "?",
    }));
  });



  test("counts every untracked file when there are more than the scan window", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const names = Array.from({ length: 40 }, (_, index) => `untracked-${index}.txt`);
    await Promise.all(names.map((name, index) =>
      fs.writeFile(path.join(worktree, name), `${"line\n".repeat(index + 1)}`)
    ));
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; status: string }>;

    // Concurrency must not drop, duplicate or misalign a result with its path.
    names.forEach((name, index) => {
      expect(changes).toContainEqual(expect.objectContaining({
        path: name,
        additions: index + 1,
        status: "?",
      }));
    });
  });



  test("resolves a commit-pinned baseline without fetching from the remote", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const creationCommit = await currentGitCommit(worktree);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    const commands = createCommandRegistry();

    await withGitSubcommandLog("fetch", async (logPath) => {
      const changes = await commands.get("get_local_git_status")?.(
        { worktreePath: worktree, targetBranch: creationCommit },
        createContext(createEnvironment()).context,
      ) as Array<{ path: string; additions: number; status: string }>;

      expect(changes).toContainEqual(expect.objectContaining({
        path: "tracked.txt",
        additions: 1,
        status: "M",
      }));
      // A commit SHA names the same commit forever, so the network round trip
      // that every poll used to make cannot change the answer.
      await expect(fs.readFile(logPath, "utf8").catch(() => "")).resolves.toBe("");
    });
  });



  test("still fetches when the baseline is a branch that can move", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    const commands = createCommandRegistry();

    await withGitSubcommandLog("fetch", async (logPath) => {
      await commands.get("get_local_git_status")?.(
        { worktreePath: worktree, targetBranch: "main" },
        createContext(createEnvironment()).context,
      );

      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("fetch origin main");
    });
  });



  test("reports local git stats against an environment creation commit", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const creationCommit = await currentGitCommit(worktree);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: creationCommit },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({
      path: "tracked.txt",
      additions: 1,
      deletions: 0,
      status: "M",
    }));
  });



  test("can limit local git stats to committed changes since environment creation", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const creationCommit = await currentGitCommit(worktree);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\ncommitted\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "branch change"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "base\ncommitted\nuncommitted\n");
    await fs.writeFile(path.join(worktree, "untracked.txt"), "not committed\n");
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      {
        worktreePath: worktree,
        targetBranch: creationCommit,
        includeUncommitted: false,
      },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    expect(changes).toEqual([expect.objectContaining({
      path: "tracked.txt",
      additions: 1,
      deletions: 0,
      status: "M",
    })]);

    const changedSnapshot = await commands.get("get_local_git_status")?.(
      {
        worktreePath: worktree,
        targetBranch: creationCommit,
        includeUncommitted: false,
        knownDigest: "stale",
      },
      createContext(createEnvironment()).context,
    ) as {
      unchanged: boolean;
      digest: string;
      value?: unknown;
    };
    expect(changedSnapshot).toMatchObject({
      unchanged: false,
      value: changes,
    });
    await expect(commands.get("get_local_git_status")?.(
      {
        worktreePath: worktree,
        targetBranch: creationCommit,
        includeUncommitted: false,
        knownDigest: changedSnapshot.digest,
      },
      createContext(createEnvironment()).context,
    )).resolves.toEqual({
      unchanged: true,
      digest: changedSnapshot.digest,
    });
  });



  test("reads local branch files from origin and returns null for files missing in the base", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "local branch content\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "local-only-main-change"]);
    await fs.writeFile(path.join(worktree, "feature-only.txt"), "feature content\n");
    const commands = createCommandRegistry();

    await expect(commands.get("read_local_file_at_branch")?.(
      { worktreePath: worktree, filePath: "tracked.txt", branch: "main" },
      createContext(createEnvironment()).context,
    )).resolves.toMatchObject({
      path: "tracked.txt",
      content: "base\n",
      language: "txt",
    });

    await expect(commands.get("read_local_file_at_branch")?.(
      { worktreePath: worktree, filePath: "feature-only.txt", branch: "main" },
      createContext(createEnvironment()).context,
    )).resolves.toBeNull();

    await expect(commands.get("read_local_file_at_branch")?.(
      { worktreePath: worktree, filePath: "../outside.txt", branch: "main" },
      createContext(createEnvironment()).context,
    )).rejects.toThrow("Invalid filePath");
  });



  test("reverts tracked and newly added local files to the target branch", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "changed\n");
    await fs.writeFile(path.join(worktree, "new file.txt"), "new\n");
    await runGit(worktree, ["add", "tracked.txt", "new file.txt"]);
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
      context,
    )).resolves.toBe("tracked.txt");
    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "new file.txt", targetBranch: "main" },
      context,
    )).resolves.toBe("new file.txt");

    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("base\n");
    expect(existsSync(path.join(worktree, "new file.txt"))).toBe(false);
    expect(await gitOutput(worktree, ["status", "--porcelain"])).toBe("");
  });



  test("reverts both endpoints of a local rename", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "original.txt"), "original\n");
    await runGit(worktree, ["add", "original.txt"]);
    await runGit(worktree, ["commit", "-m", "add original"]);
    await runGit(worktree, ["push", "origin", "main"]);
    await runGit(worktree, ["mv", "original.txt", "renamed.txt"]);
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "renamed.txt", targetBranch: "main" },
      createContext(environment).context,
    )).resolves.toBe("renamed.txt");

    await expect(fs.readFile(path.join(worktree, "original.txt"), "utf8")).resolves.toBe("original\n");
    expect(existsSync(path.join(worktree, "renamed.txt"))).toBe(false);
    expect(await gitOutput(worktree, ["status", "--porcelain"])).toBe("");
  });



  test("deletes local files and stages tracked deletions for the next commit", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "untracked.txt"), "untracked\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "tracked.txt" },
      context,
    )).resolves.toBe("tracked.txt");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "untracked.txt" },
      context,
    )).resolves.toBe("untracked.txt");

    expect(existsSync(path.join(worktree, "tracked.txt"))).toBe(false);
    expect(existsSync(path.join(worktree, "untracked.txt"))).toBe(false);
    expect(await gitOutput(worktree, ["diff", "--cached", "--name-status"])).toBe("D\ttracked.txt");
  });



  test("rejects unsafe paths for local file mutations", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "../outside.txt", targetBranch: "main" },
      context,
    )).rejects.toThrow("Invalid filePath");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "../outside.txt" },
      context,
    )).rejects.toThrow("Invalid filePath");
    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: ".git/index", targetBranch: "main" },
      context,
    )).rejects.toThrow("Git metadata cannot be modified");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: ".git/index" },
      context,
    )).rejects.toThrow("Git metadata cannot be modified");
    expect(existsSync(path.join(worktree, ".git", "index"))).toBe(true);
  });



  test("rejects local mutations through symlinked ancestors without touching the target", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const outside = await createTempDir("ork-electron-outside-");
    const outsideFile = path.join(outside, "victim.txt");
    await fs.writeFile(outsideFile, "keep me\n");
    await fs.symlink(outside, path.join(worktree, "escape"));
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "escape/victim.txt" },
      context,
    )).rejects.toThrow("symlink ancestor");
    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "escape/victim.txt", targetBranch: "main" },
      context,
    )).rejects.toThrow("symlink ancestor");

    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("keep me\n");
  });



  test("handles missing ancestors and rejects non-directory ancestors for local deletion", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "plain-file"), "not a directory\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });
    const context = createContext(environment).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "missing/child.txt" },
      context,
    )).resolves.toBe("missing/child.txt");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: environment.id, filePath: "plain-file/child.txt" },
      context,
    )).rejects.toThrow("ancestor is not a directory");
    await expect(fs.readFile(path.join(worktree, "plain-file"), "utf8")).resolves.toBe(
      "not a directory\n",
    );
  });



  test("does not delete a local file when the revert target ref is missing", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "changed\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });

    await expect(commands.get("revert_local_file")?.(
      { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "missing-branch" },
      createContext(environment).context,
    )).rejects.toThrow("Target ref not found");
    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
  });



  test("does not treat a failed Git lookup as a path missing from the base", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "tracked.txt"), "changed\n");
    const commands = createCommandRegistry();
    const environment = createEnvironment({ worktreePath: worktree });

    await withFailingGitSubcommand("ls-tree", async () => {
      await expect(commands.get("revert_local_file")?.(
        { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
        createContext(environment).context,
      )).rejects.toThrow("forced ls-tree failure");
    });

    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
  });



  test("binds destructive local commands to a stored local environment", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const commands = createCommandRegistry();
    const localEnvironment = createEnvironment({ id: "env-local", worktreePath: worktree });
    const containerEnvironment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
    });
    const context = createContext([localEnvironment, containerEnvironment]).context;

    await expect(commands.get("delete_local_file")?.(
      { environmentId: "missing", filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("Environment not found");
    await expect(commands.get("delete_local_file")?.(
      { environmentId: containerEnvironment.id, filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("not a local worktree");

    await expect(fs.readFile(path.join(worktree, "tracked.txt"), "utf8")).resolves.toBe("base\n");
  });



  test("rejects unsafe target branch names before running git", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const commands = createCommandRegistry();
    const context = createContext(createEnvironment()).context;

    for (const branch of ["-rf", "feature..main", "feature//main", "bad name", "refs/.hidden"]) {
      await expect(commands.get("get_local_git_status")?.(
        { worktreePath: worktree, targetBranch: branch },
        context,
      )).rejects.toThrow("Invalid target branch");
      await expect(commands.get("read_local_file_at_branch")?.(
        { worktreePath: worktree, filePath: "tracked.txt", branch },
        context,
      )).rejects.toThrow("Invalid target branch");
    }
  });



  test("counts zero added lines for empty and binary untracked files", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "empty.txt"), "");
    await fs.writeFile(path.join(worktree, "binary.bin"), Buffer.from([1, 2, 0, 3, 4]));
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; originalPath?: string; additions: number; deletions: number; status: string }>;

    expect(changes).toContainEqual(expect.objectContaining({ path: "empty.txt", additions: 0, status: "?" }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "binary.bin", additions: 0, status: "?" }));
  });



  test("maps rename stats to the new path in local git status", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await fs.writeFile(path.join(worktree, "original.txt"), "a\nb\nc\nd\ne\n");
    await runGit(worktree, ["add", "original.txt"]);
    await runGit(worktree, ["commit", "-m", "add original"]);
    await runGit(worktree, ["push", "origin", "main"]);

    await fs.rm(path.join(worktree, "original.txt"));
    await fs.writeFile(path.join(worktree, "renamed.txt"), "a\nb\nc\nd\ne\nf\n");
    await runGit(worktree, ["add", "-A"]);
    await runGit(worktree, ["commit", "-m", "rename with edit"]);
    const commands = createCommandRegistry();

    const changes = await commands.get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: "main" },
      createContext(createEnvironment()).context,
    ) as Array<{ path: string; additions: number; deletions: number; status: string }>;

    const renamed = changes.find((change) => change.path === "renamed.txt");
    expect(renamed).toBeDefined();
    expect(renamed?.status.startsWith("R")).toBe(true);
    expect(renamed?.originalPath).toBe("original.txt");
    expect(renamed?.additions).toBe(1);
  });



  test("reports a target ref the container cannot resolve", async () => {
    const environment = createEnvironment({
      id: "env-container-missing-ref",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '\\036ORKESTRATOR_TARGET_REF_NOT_FOUND\\037'
  exit 0
fi
exit 0
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        context,
      )).rejects.toThrow("Target ref is not present in the container: main");
    });
  });



  test("returns no container git changes before workspace clone creates a git repo", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  exit 0
fi
exit 1
`, async (logs) => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        context,
      )).resolves.toEqual([]);

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("git rev-parse --is-inside-work-tree");
    });
  });



  test("injects workspace artifact git excludes before reading container git status", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus(
      "M\0tracked.txt\0",
      "1\t2\ttracked.txt\0",
    );

    await withFakeDocker(`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async (logs) => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        context,
      )).resolves.toEqual([expect.objectContaining({ path: "tracked.txt", status: "M" })]);

      const changedSnapshot = await commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "main",
          knownDigest: "stale",
        },
        context,
      ) as {
        unchanged: boolean;
        digest: string;
        value?: unknown;
      };
      expect(changedSnapshot).toMatchObject({
        unchanged: false,
        value: [expect.objectContaining({ path: "tracked.txt", status: "M" })],
      });
      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "main",
          knownDigest: changedSnapshot.digest,
        },
        context,
      )).resolves.toEqual({
        unchanged: true,
        digest: changedSnapshot.digest,
      });

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("git rev-parse --is-inside-work-tree");
      expect(dockerExec).toContain("git rev-parse --git-path info/exclude");
      expect(dockerExec).toContain('for pattern in ".orkestrator" ".claude/settings.local.json"; do');
      expect(dockerExec).toContain('grep -qxF "$pattern" "$exclude_file"');
      expect(dockerExec).toContain("tail -c 1");
      expect(dockerExec).toContain('git diff --name-status -z -M "$base" $end_ref');
      expect(dockerExec).toContain('git diff --numstat -z -M "$base" $end_ref');
    });
  });



  test("maps container rename status to its destination and preserves the source path", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus(
      "R100\0old name.ts\0new name.ts\0",
      "2\t1\t\0old name.ts\0new name.ts\0",
    );

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: "new name.ts",
        originalPath: "old name.ts",
        filename: "new name.ts",
        additions: 2,
        deletions: 1,
        status: "R100",
      })]);
    });
  });



  test("includes untracked container files only when working-tree changes are requested", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus("", "", "2\tuntracked.txt\0");

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "0123456789012345678901234567890123456789",
          includeUncommitted: true,
        },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: "untracked.txt",
        additions: 2,
        status: "?",
      })]);

      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "0123456789012345678901234567890123456789",
          includeUncommitted: false,
        },
        createContext(environment).context,
      )).resolves.toEqual([]);
    });
  });



  test("uses HEAD and omits worktree scanning for committed-only container status", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const framedStatus = framedContainerGitStatus(
      "M\0committed.txt\0",
      "1\t0\tcommitted.txt\0",
    );

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async (logs) => {
      await expect(commands.get("get_git_status")?.(
        {
          containerId: "container-1",
          targetBranch: "0123456789012345678901234567890123456789",
          includeUncommitted: false,
        },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: "committed.txt",
        additions: 1,
        status: "M",
      })]);

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("end_ref=HEAD");
      expect(dockerExec).toContain('git diff --name-status -z -M "$base" $end_ref');
      expect(dockerExec).not.toContain("git status --porcelain");
      expect(dockerExec).not.toContain("node -e");
    });
  });



  test("rejects unsafe container target refs before invoking Docker", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
exit 0
`, async (logs) => {
      for (const targetBranch of ["-rf", "feature..main", "feature//main", "bad name", "refs/.hidden"]) {
        await expect(commands.get("get_git_status")?.(
          { containerId: "container-1", targetBranch },
          createContext(environment).context,
        )).rejects.toThrow("Invalid target branch");
      }
      await expect(fs.readFile(logs.exec, "utf8")).rejects.toThrow();
    });
  });



  test("propagates a missing container target ref without returning an empty status", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf 'Target ref not found: missing-branch\\n' >&2
  exit 2
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "missing-branch" },
        createContext(environment).context,
      )).rejects.toThrow("Target ref not found");
    });
  });



  test("rejects malformed container status framing and invalid encoded sections", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const malformedResponses = [
      "\u001eORKESTRATOR_NAME_STATUS\u001f",
      [
        "\u001eORKESTRATOR_NAME_STATUS\u001f",
        "%%%",
        "\u001eORKESTRATOR_NUMSTAT\u001f",
        "",
        "\u001eORKESTRATOR_UNTRACKED\u001f",
        "",
        "\u001eORKESTRATOR_END\u001f",
      ].join(""),
      `unexpected${framedContainerGitStatus()}`,
      `${framedContainerGitStatus()}unexpected`,
    ];

    for (const response of malformedResponses) {
      await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${response}'
  exit 0
fi
exit 1
`, async () => {
        await expect(commands.get("get_git_status")?.(
          { containerId: "container-1", targetBranch: "main" },
          createContext(environment).context,
        )).rejects.toThrow("Malformed");
      });
    }
  });



  test("does not confuse marker-like text in a container path with response framing", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const commands = createCommandRegistry();
    const markerPath = "src/\u001eORKESTRATOR_NUMSTAT\u001f.txt";
    const framedStatus = framedContainerGitStatus(
      `M\0${markerPath}\0`,
      `3\t1\t${markerPath}\0`,
    );

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s' '${framedStatus}'
  exit 0
fi
exit 1
`, async () => {
      await expect(commands.get("get_git_status")?.(
        { containerId: "container-1", targetBranch: "main" },
        createContext(environment).context,
      )).resolves.toEqual([expect.objectContaining({
        path: markerPath,
        additions: 3,
        deletions: 1,
      })]);
    });
  });



  test("runs validated container file revert and delete commands", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
exit 0
`, async (logs) => {
      await expect(commands.get("revert_container_file")?.(
        { environmentId: environment.id, filePath: "src/file name.ts", targetBranch: "main" },
        context,
      )).resolves.toBe("src/file name.ts");
      await expect(commands.get("delete_container_file")?.(
        { environmentId: environment.id, filePath: "src/file name.ts" },
        context,
      )).resolves.toBe("src/file name.ts");

      const dockerExec = await fs.readFile(logs.exec, "utf8");
      expect(dockerExec).toContain("set -euo pipefail");
      expect(dockerExec).toContain("git diff --name-status -z -M");
      expect(dockerExec).toContain("assert_safe_path \"$source_path\"");
      expect(dockerExec).toContain("git restore --source=\"$base\" --staged --worktree -- \"$candidate\"");
      expect(dockerExec).toContain("git rm -f --ignore-unmatch -- \"$candidate\"");
      expect(dockerExec).toContain("git clean -f -x -- \"$candidate\"");
      expect(dockerExec).toContain("Symlink ancestor is not allowed");
    });

    await expect(commands.get("revert_container_file")?.(
      { environmentId: environment.id, filePath: "../outside.ts", targetBranch: "main" },
      context,
    )).rejects.toThrow("Invalid filePath");
    await expect(commands.get("revert_container_file")?.(
      { environmentId: environment.id, filePath: "src/file.ts", targetBranch: "bad branch" },
      context,
    )).rejects.toThrow("Invalid target branch");
    await expect(commands.get("delete_container_file")?.(
      { environmentId: environment.id, filePath: ".git/index" },
      context,
    )).rejects.toThrow("Git metadata cannot be modified");
  });



  test("binds destructive container commands to a stored container environment", async () => {
    const localEnvironment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: undefined,
    });
    const commands = createCommandRegistry();
    const context = createContext(localEnvironment).context;

    await expect(commands.get("delete_container_file")?.(
      { environmentId: "missing", filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("Environment not found");
    await expect(commands.get("delete_container_file")?.(
      { environmentId: localEnvironment.id, filePath: "tracked.txt" },
      context,
    )).rejects.toThrow("not containerized");
  });



  liveDockerTest("executes rename-aware and containment-safe file mutations in a live container", async () => {
    const { stdout } = await execFileAsync("docker", [
      "run",
      "-d",
      "--rm",
      "--entrypoint",
      "sleep",
      "orkestrator-v2:latest",
      "infinity",
    ]);
    const containerId = stdout.trim();
    try {
      await execFileAsync("docker", ["exec", containerId, "bash", "-lc", `
        set -e
        find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        cd /workspace
        git init
        git checkout -b main
        git config user.name "Test User"
        git config user.email "test@example.com"
        printf 'original\\n' > original.txt
        git add original.txt
        git commit -m base
        git mv original.txt renamed.txt
        printf 'delete me\\n' > delete-me.txt
        mkdir -p /tmp/orkestrator-outside
        printf 'keep me\\n' > /tmp/orkestrator-outside/victim.txt
        ln -s /tmp/orkestrator-outside escape
      `]);
      const environment = createEnvironment({
        id: "env-live-container",
        environmentType: "containerized",
        containerId,
        worktreePath: undefined,
        status: "running",
      });
      const commands = createCommandRegistry();
      const context = createContext(environment).context;

      await expect(commands.get("revert_container_file")?.(
        { environmentId: environment.id, filePath: "renamed.txt", targetBranch: "main" },
        context,
      )).resolves.toBe("renamed.txt");
      await expect(commands.get("delete_container_file")?.(
        { environmentId: environment.id, filePath: "delete-me.txt" },
        context,
      )).resolves.toBe("delete-me.txt");
      await expect(commands.get("delete_container_file")?.(
        { environmentId: environment.id, filePath: "escape/victim.txt" },
        context,
      )).rejects.toThrow("Symlink ancestor is not allowed");

      await expect(execFileAsync("docker", ["exec", containerId, "bash", "-lc", [
        "test -f /workspace/original.txt",
        "test ! -e /workspace/renamed.txt",
        "test ! -e /workspace/delete-me.txt",
        "test -f /tmp/orkestrator-outside/victim.txt",
      ].join(" && ")])).resolves.toBeDefined();
    } finally {
      await execFileAsync("docker", ["rm", "-f", containerId]).catch(() => undefined);
    }
  });



  test("starts local terminal sessions through a PTY and forwards byte payloads", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-");
    const resourceRoot = await createTempDir("ork-electron-terminal-res-");
    const toolchainBinDir = await createTempDir("ork-electron-terminal-tools-");
    const packagedBinDir = path.join(resourceRoot, "bin");
    await fs.mkdir(packagedBinDir, { recursive: true });
    const environment = createEnvironment({ worktreePath });
    const { context, emitted } = createContext(environment);
    context.resourceRoot = resourceRoot;
    context.toolchainBinDir = toolchainBinDir;
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 132, rows: 43 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    const spawnCall = ptySpawn.mock.calls[0];
    expect(spawnCall?.[0]).toBe(expectedLocalShellPath());
    expect(spawnCall?.[1]).toEqual(["-l"]);
    expect(spawnCall?.[2]).toMatchObject({
      cols: 132,
      rows: 43,
      cwd: worktreePath,
    });
    const terminalProcessEnv = spawnCall?.[2]?.env as NodeJS.ProcessEnv | undefined;
    expect(terminalProcessEnv?.PATH?.split(path.delimiter).slice(0, 2)).toEqual([
      toolchainBinDir,
      packagedBinDir,
    ]);
    expect(commands.get("get_terminal_session")?.({ sessionId }, context)).toEqual({
      id: sessionId,
      running: true,
      bootstrapped: false,
    });

    ptyProcesses[0]?.emitData("ready\r\n");
    expect(emitted).toEqual([
      {
        event: `terminal-output-${sessionId}`,
        payload: {
          text: "ready\r\n",
          revision: 1,
          generation: 1,
        },
      },
    ]);

    await commands.get("local_terminal_write")?.({ sessionId, data: "pwd\r" }, context);
    await commands.get("local_terminal_resize")?.({ sessionId, cols: 120, rows: 30 }, context);
    expect(ptyProcesses[0]?.write).toHaveBeenCalledWith("pwd\r");
    expect(ptyProcesses[0]?.resize).toHaveBeenCalledWith(120, 30);

    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
    expect(ptyProcesses[0]?.kill).toHaveBeenCalled();
    expect(commands.get("get_terminal_session")?.({ sessionId }, context)).toEqual({ id: sessionId, running: false, bootstrapped: false });
  });



  test("atomically bootstraps a terminal session at most once", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-bootstrap-");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 100, rows: 30 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    expect(await commands.get("bootstrap_terminal_session")?.(
      { sessionId, data: "codex\n" },
      context,
    )).toEqual({ bootstrapped: true, delivered: true, duplicate: false });
    expect(await commands.get("bootstrap_terminal_session")?.(
      { sessionId, data: "codex\n" },
      context,
    )).toEqual({ bootstrapped: true, delivered: false, duplicate: true });
    expect(ptyProcesses[0]?.write).toHaveBeenCalledTimes(1);
    expect(ptyProcesses[0]?.write).toHaveBeenCalledWith("codex\n");
    expect(commands.get("get_terminal_session")?.({ sessionId }, context)).toEqual({
      id: sessionId,
      running: true,
      bootstrapped: true,
    });
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  });



  test("does not consume terminal bootstrap ownership when delivery is unavailable or throws", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-bootstrap-errors-");
    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    expect(await commands.get("bootstrap_terminal_session")?.(
      { sessionId: "missing-session", data: "codex\n" },
      context,
    )).toEqual({ bootstrapped: false, delivered: false, duplicate: false });

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 100, rows: 30 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    ptyProcesses[0]!.write.mockImplementationOnce(() => {
      throw new Error("PTY write failed");
    });

    expect(() => commands.get("bootstrap_terminal_session")?.(
      { sessionId, data: "codex\n" },
      context,
    )).toThrow("PTY write failed");
    expect(commands.get("get_terminal_session")?.({ sessionId }, context)).toEqual({
      id: sessionId,
      running: true,
      bootstrapped: false,
    });
    expect(await commands.get("bootstrap_terminal_session")?.(
      { sessionId, data: "codex\n" },
      context,
    )).toEqual({ bootstrapped: true, delivered: true, duplicate: false });
    expect(ptyProcesses[0]!.write).toHaveBeenCalledTimes(2);
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  });



  test("reattaches a stable terminal tab to the same backend PTY and buffer", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-reattach-");
    const environment = createEnvironment({ worktreePath });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();
    const args = {
      environmentId: environment.id,
      terminalKey: "plain-tab-1",
      cols: 80,
      rows: 24,
    };

    const firstResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    const firstSessionId = firstResult.sessionId;
    expect(firstResult.created).toBe(true);
    await commands.get("start_local_terminal_session")?.(
      { sessionId: firstSessionId },
      context,
    );
    ptyProcesses[0]?.emitData("dev server listening on 3000\r\n");
    ptyProcesses[0]?.emitData("second chunk\r\n");

    // A second renderer (or a remount after project refresh) has only the
    // durable environment + tab identity. Ensuring that identity must return
    // the original running PTY, and starting it again must remain idempotent.
    const reattachedResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    const reattachedSessionId = reattachedResult.sessionId;
    expect(reattachedResult.created).toBe(false);
    await commands.get("start_local_terminal_session")?.(
      { sessionId: reattachedSessionId },
      context,
    );

    expect(reattachedSessionId).toBe(firstSessionId);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(commands.get("get_terminal_output_snapshot")?.(
      { sessionId: reattachedSessionId },
      context,
    )).toEqual({
      output: "dev server listening on 3000\r\nsecond chunk\r\n",
      revision: 2,
      generation: 1,
      truncated: false,
    });
    expect(emitted.filter(({ event }) => event === `terminal-output-${firstSessionId}`))
      .toEqual([
        {
          event: `terminal-output-${firstSessionId}`,
          payload: {
            text: "dev server listening on 3000\r\n",
            revision: 1,
            generation: 1,
          },
        },
        {
          event: `terminal-output-${firstSessionId}`,
          payload: {
            text: "second chunk\r\n",
            revision: 2,
            generation: 1,
          },
        },
      ]);

    expect(await commands.get("bootstrap_terminal_session")?.(
      { sessionId: firstSessionId, data: "bun run dev\n" },
      context,
    )).toEqual({ bootstrapped: true, delivered: true, duplicate: false });

    // A natural shell exit retains the stable tab identity and bounded
    // transcript. Reopening the tab starts a replacement PTY under that same
    // identity rather than losing its history.
    ptyProcesses[0]?.emitExit({ exitCode: 0 });
    const exitedResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    expect(exitedResult).toEqual({ sessionId: firstSessionId, created: false, bootstrapped: false });
    expect(commands.get("get_terminal_output_snapshot")?.(
      { sessionId: firstSessionId },
      context,
    )).toEqual({
      output: "dev server listening on 3000\r\nsecond chunk\r\n",
      revision: 2,
      generation: 1,
      truncated: false,
    });
    await commands.get("start_local_terminal_session")?.(
      { sessionId: exitedResult.sessionId },
      context,
    );
    expect(ptySpawn).toHaveBeenCalledTimes(2);
    expect(await commands.get("bootstrap_terminal_session")?.(
      { sessionId: exitedResult.sessionId, data: "bun run dev\n" },
      context,
    )).toEqual({ bootstrapped: true, delivered: true, duplicate: false });
    expect(ptyProcesses[1]?.write).toHaveBeenCalledWith("bun run dev\n");

    await commands.get("close_local_terminal_session")?.(
      { sessionId: firstSessionId },
      context,
    );
    const replacementResult = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      args,
      context,
    ));
    const replacementSessionId = replacementResult.sessionId;
    expect(replacementResult.created).toBe(true);
    expect(replacementSessionId).not.toBe(firstSessionId);
  });



  test("supersedes a stable local terminal when its activity configuration changes", async () => {
    const worktreePath = await createTempDir("ork-electron-local-terminal-supersede-");
    const environment = createEnvironment({
      id: "env-local-terminal-supersede",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const baseArgs = {
      environmentId: environment.id,
      terminalKey: "agent-tab",
      cols: 80,
      rows: 24,
    };

    const untracked = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      baseArgs,
      context,
    ));
    await commands.get("start_local_terminal_session")?.(
      { sessionId: untracked.sessionId },
      context,
    );

    const tracked = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { ...baseArgs, trackEnvironmentActivity: true },
      context,
    ));
    expect(tracked.created).toBe(true);
    expect(tracked.sessionId).not.toBe(untracked.sessionId);
    expect(ptyProcesses[0]?.kill).toHaveBeenCalledTimes(1);

    const reused = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { ...baseArgs, trackEnvironmentActivity: true },
      context,
    ));
    expect(reused).toEqual({ sessionId: tracked.sessionId, created: false, bootstrapped: false });
  });



  test("records prompt and settled-output activity for tracked local agent terminals", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-activity-");
    const environment = createEnvironment({
      id: "env-local-agent-activity",
      worktreePath,
      lastActivityAt: "2026-07-23T09:00:00.000Z",
    });
    const { context, emitted } = createContext(environment);
    const notifyAgentTurnCompleted = mock(async (_environmentId: string) => undefined);
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    await withFixedDate("2026-07-23T10:00:00.000Z", () =>
      commands.get("local_terminal_write")?.({ sessionId, data: "opencode\r" }, context),
    );
    expect(recordActivity).toHaveBeenLastCalledWith(
      environment.id,
      "2026-07-23T10:00:00.000Z",
    );

    await withFixedDate("2026-07-23T10:05:00.000Z", async () => {
      ptyProcesses[0]?.emitData("work complete\r\n");
      await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    });
    expect(recordCompletion).toHaveBeenLastCalledWith(
      environment.id,
      "2026-07-23T10:05:00.000Z",
    );
    await waitForCondition(
      () => notifyAgentTurnCompleted.mock.calls.length === 1,
      "the tracked terminal completion notification",
    );
    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith(environment.id);
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.lastActivityAt).toBe("2026-07-23T10:05:00.000Z");
    await waitForCondition(
      () => emitted.some(({ event, payload }) =>
        event === "environment-activity-recorded" &&
        (payload as { environment_id?: string; occurred_at?: string; activity_kind?: string }).environment_id === environment.id &&
        (payload as { environment_id?: string; occurred_at?: string; activity_kind?: string }).occurred_at === "2026-07-23T10:05:00.000Z" &&
        (payload as { environment_id?: string; occurred_at?: string; activity_kind?: string }).activity_kind === "completed"
      ),
      "the terminal activity event",
    );
    expect(emitted).toContainEqual({
      event: "environment-activity-recorded",
      payload: {
        environment_id: environment.id,
        occurred_at: "2026-07-23T10:00:00.000Z",
        activity_kind: "prompt",
      },
    });
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);



  test("retries tracked terminal completion persistence and notification before consuming the edge", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-retry-");
    const environment = createEnvironment({
      id: "env-local-agent-retry",
      worktreePath,
    });
    const { context, emitted } = createContext(environment);
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    recordCompletion.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    const notifyAgentTurnCompleted = mock(async (_environmentId: string) => undefined);
    notifyAgentTurnCompleted.mockRejectedValueOnce(new Error("command temporarily unavailable"));
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);
    ptyProcesses[0]?.emitData("done\r\n");

    await waitForCondition(
      () => recordCompletion.mock.calls.length === 2
        && notifyAgentTurnCompleted.mock.calls.length === 2,
      "completion persistence and notification retries",
    );
    expect(emitted.filter(({ event, payload }) =>
      event === "environment-activity-recorded"
      && (payload as { activity_kind?: string }).activity_kind === "completed"
    )).toHaveLength(1);

    ptyProcesses[0]?.emitData("late background output");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordCompletion).toHaveBeenCalledTimes(2);
    expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(2);
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);



  test("deduplicates settled output per prompt generation and admits the next prompt", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-generations-");
    const environment = createEnvironment({ id: "env-local-agent-generations", worktreePath });
    const { context } = createContext(environment);
    let releaseFirst!: () => void;
    const firstNotification = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const notifyAgentTurnCompleted = mock(() =>
      notifyAgentTurnCompleted.mock.calls.length === 1
        ? firstNotification
        : Promise.resolve()
    );
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    const commands = createCommandRegistry();
    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    await commands.get("local_terminal_write")?.({ sessionId, data: "first\r" }, context);
    ptyProcesses[0]?.emitData("first done\r\n");
    await waitForCondition(() => notifyAgentTurnCompleted.mock.calls.length === 1, "first generation notification");
    ptyProcesses[0]?.emitData("late output from first generation");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordCompletion).toHaveBeenCalledTimes(1);

    await commands.get("local_terminal_write")?.({ sessionId, data: "second\r" }, context);
    ptyProcesses[0]?.emitData("second done\r\n");
    await waitForCondition(() => notifyAgentTurnCompleted.mock.calls.length === 2, "second generation notification");

    expect(recordCompletion).toHaveBeenCalledTimes(2);
    releaseFirst();
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);



  test.each([
    ["persistence", true],
    ["notification", false],
  ] as const)("consumes a tracked terminal edge after %s retry exhaustion", async (_label, failPersistence) => {
    const worktreePath = await createTempDir("ork-electron-local-agent-exhaustion-");
    const environment = createEnvironment({
      id: `env-local-agent-${failPersistence ? "persist" : "notify"}-exhaustion`,
      worktreePath,
    });
    const { context, emitted } = createContext(environment);
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    const notifyAgentTurnCompleted = mock(async () => undefined);
    if (failPersistence) {
      recordCompletion.mockImplementation(async () => {
        throw new Error("storage permanently unavailable");
      });
    } else {
      notifyAgentTurnCompleted.mockImplementation(async () => {
        throw new Error("notification permanently unavailable");
      });
    }
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const commands = createCommandRegistry();
    try {
      const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          cols: 80,
          rows: 24,
          trackEnvironmentActivity: true,
        },
        context,
      )).sessionId;
      await commands.get("start_local_terminal_session")?.({ sessionId }, context);
      await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);
      ptyProcesses[0]?.emitExit({ exitCode: 0 });

      await waitForCondition(
        () => (failPersistence ? recordCompletion : notifyAgentTurnCompleted).mock.calls.length === 4,
        `${_label} retries to exhaust`,
      );
      const recordsAfterExhaustion = recordCompletion.mock.calls.length;
      const notificationsAfterExhaustion = notifyAgentTurnCompleted.mock.calls.length;
      ptyProcesses[0]?.emitData("stray output after exhausted completion");
      await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);

      expect(recordCompletion).toHaveBeenCalledTimes(recordsAfterExhaustion);
      expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(notificationsAfterExhaustion);
      expect(emitted.filter(({ event, payload }) =>
        event === "environment-activity-recorded"
        && (payload as { activity_kind?: string }).activity_kind === "completed"
      )).toHaveLength(failPersistence ? 0 : 1);
      expect(consoleError).toHaveBeenCalledWith(
        failPersistence
          ? "Failed to record terminal environment activity"
          : "Failed to notify terminal agent completion",
        expect.objectContaining({ environmentId: environment.id }),
      );
    } finally {
      consoleError.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);



  test("does not carry a completed turn onto a replacement PTY with the same stable key", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-reconnect-");
    const environment = createEnvironment({ id: "env-local-agent-reconnect", worktreePath });
    const { context, emitted } = createContext(environment);
    let releaseNotification!: () => void;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });
    const notifyAgentTurnCompleted = mock(() => notificationGate);
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;
    const commands = createCommandRegistry();
    const args = {
      environmentId: environment.id,
      terminalKey: "agent-tab",
      cols: 80,
      rows: 24,
      trackEnvironmentActivity: true,
    };

    const first = terminalSessionResult(await commands.get("create_local_terminal_session")?.(args, context));
    await commands.get("start_local_terminal_session")?.({ sessionId: first.sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId: first.sessionId, data: "codex\r" }, context);
    ptyProcesses[0]?.emitExit({ exitCode: 0 });
    await waitForCondition(() => notifyAgentTurnCompleted.mock.calls.length === 1, "first terminal completion");

    const replacement = terminalSessionResult(await commands.get("create_local_terminal_session")?.(args, context));
    expect(replacement).toEqual({ sessionId: first.sessionId, created: false, bootstrapped: false });
    await commands.get("start_local_terminal_session")?.({ sessionId: replacement.sessionId }, context);
    ptyProcesses[1]?.emitData("$ ");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);

    expect(recordCompletion).toHaveBeenCalledTimes(1);
    expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);
    expect(emitted.filter(({ event, payload }) =>
      event === "environment-activity-recorded"
      && (payload as { activity_kind?: string }).activity_kind === "completed"
    )).toHaveLength(1);
    releaseNotification();
    await commands.get("close_local_terminal_session")?.({ sessionId: replacement.sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);



  test("debounces repeated output and ignores writes without a submitted prompt", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-debounce-");
    const environment = createEnvironment({
      id: "env-local-agent-debounce",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);

    await commands.get("local_terminal_write")?.({ sessionId, data: "unfinished" }, context);
    ptyProcesses[0]?.emitData("shell echo");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordActivity).not.toHaveBeenCalled();

    await commands.get("local_terminal_write")?.({ sessionId, data: "\r" }, context);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    recordActivity.mockClear();

    ptyProcesses[0]?.emitData("first chunk");
    await Bun.sleep(400);
    ptyProcesses[0]?.emitData("second chunk");
    // The second chunk restarts the 750ms settle window, so nothing may have been
    // recorded 500ms later. This sleep is load-bearing: it is the reset itself
    // being asserted, and it leaves 250ms of slack against a stalled machine.
    await Bun.sleep(500);
    expect(recordCompletion).not.toHaveBeenCalled();

    // Wait for the restarted window to elapse rather than sleeping exactly past
    // it, so a scheduling stall delays the test instead of failing it.
    await waitForCondition(
      () => recordCompletion.mock.calls.length > 0,
      "debounced terminal completion to settle",
    );
    expect(recordCompletion).toHaveBeenCalledTimes(1);
    recordCompletion.mockClear();
    ptyProcesses[0]?.emitData("background output after completion");
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);
    expect(recordCompletion).not.toHaveBeenCalled();
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);



  test("logs terminal activity persistence failures without emitting a success event", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-persistence-failure-");
    const environment = createEnvironment({
      id: "env-local-agent-persistence-failure",
      worktreePath,
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();
    const persistenceError = new Error("activity storage unavailable");
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    recordActivity.mockRejectedValueOnce(persistenceError);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          cols: 80,
          rows: 24,
          trackEnvironmentActivity: true,
        },
        context,
      )).sessionId;
      await commands.get("start_local_terminal_session")?.({ sessionId }, context);
      await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);

      await waitForCondition(
        () => consoleError.mock.calls.length > 0,
        "the terminal activity persistence error",
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to record terminal environment activity",
        {
          environmentId: environment.id,
          error: persistenceError.message,
        },
      );
      expect(emitted.some(({ event }) => event === "environment-activity-recorded")).toBe(false);
      await commands.get("close_local_terminal_session")?.({ sessionId }, context);
    } finally {
      consoleError.mockRestore();
    }
  }, ASYNC_TEST_BUDGET_MS);



  test("cancels pending settled-output activity when a tracked terminal is explicitly closed", async () => {
    const worktreePath = await createTempDir("ork-electron-local-agent-close-");
    const environment = createEnvironment({
      id: "env-local-agent-close",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      {
        environmentId: environment.id,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId, data: "claude\r" }, context);
    recordActivity.mockClear();

    ptyProcesses[0]?.emitData("work in progress");
    await commands.get("close_local_terminal_session")?.({ sessionId }, context);
    await Bun.sleep(TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS);

    expect(recordActivity).not.toHaveBeenCalled();
    expect(recordCompletion).not.toHaveBeenCalled();
    expect(ptyProcesses[0]?.kill).toHaveBeenCalled();
  });



  test("records prompt and settled-output activity for tracked container agent terminals", async () => {
    const environment = createEnvironment({
      id: "env-container-agent-activity",
      environmentType: "containerized",
      containerId: "container-activity",
      worktreePath: undefined,
      lastActivityAt: "2026-07-23T09:00:00.000Z",
    });
    const { context } = createContext(environment);
    const notifyAgentTurnCompleted = mock(async (_environmentId: string) => undefined);
    context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_terminal_session")?.(
      {
        containerId: environment.containerId,
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).sessionId;
    await commands.get("start_terminal_session")?.({ sessionId }, context);

    await withFixedDate("2026-07-23T11:00:00.000Z", () =>
      commands.get("terminal_write")?.({ sessionId, data: "codex\r" }, context),
    );
    await withFixedDate("2026-07-23T11:02:00.000Z", () => {
      ptyProcesses[0]?.emitData("waiting for input\r\n");
      ptyProcesses[0]?.emitExit({ exitCode: 0 });
    });

    expect(recordActivity).toHaveBeenCalledWith(
      environment.id,
      "2026-07-23T11:00:00.000Z",
    );
    expect(recordCompletion).toHaveBeenCalledWith(
      environment.id,
      "2026-07-23T11:02:00.000Z",
    );
    await waitForCondition(
      () => notifyAgentTurnCompleted.mock.calls.length === 1,
      "the container terminal completion notification",
    );
    expect(notifyAgentTurnCompleted).toHaveBeenCalledWith(environment.id);
    expect(environment.hasUnreadWork).toBe(true);
    expect(environment.lastActivityAt).toBe("2026-07-23T11:02:00.000Z");
  }, ASYNC_TEST_BUDGET_MS);



  test("rejects activity tracking for a container outside the stored environment set", async () => {
    const environment = createEnvironment({
      id: "env-known-container",
      environmentType: "containerized",
      containerId: "container-known",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("create_terminal_session")?.(
      {
        containerId: "container-unrelated",
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: true,
      },
      context,
    )).rejects.toThrow("Tracked terminal container is not associated with an environment");

    await expect(commands.get("create_terminal_session")?.(
      {
        containerId: "container-unrelated",
        environmentId: environment.id,
        terminalKey: "plain-tab",
        cols: 80,
        rows: 24,
      },
      context,
    )).rejects.toThrow("Terminal container is not associated with the requested environment");
  });



  test("does not record shell activity for untracked terminal tabs", async () => {
    const worktreePath = await createTempDir("ork-electron-untracked-terminal-");
    const environment = createEnvironment({ id: "env-untracked-terminal", worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const recordActivity = context.storage.recordEnvironmentActivity as ReturnType<typeof mock>;
    const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<typeof mock>;

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;
    await commands.get("start_local_terminal_session")?.({ sessionId }, context);
    await commands.get("local_terminal_write")?.({ sessionId, data: "pwd\r" }, context);
    ptyProcesses[0]?.emitData("/tmp/worktree\r\n");
    ptyProcesses[0]?.emitExit({ exitCode: 0 });

    expect(recordActivity).not.toHaveBeenCalled();
    expect(recordCompletion).not.toHaveBeenCalled();
  });



  test("rejects local terminal start when the worktree path is missing", async () => {
    const missingWorktreePath = path.join(os.tmpdir(), `ork-missing-worktree-${Date.now()}`);
    const environment = createEnvironment({ worktreePath: missingWorktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const sessionId = terminalSessionResult(await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    )).sessionId;

    await expect(commands.get("start_local_terminal_session")?.({ sessionId }, context)).rejects.toThrow(
      `Local environment worktree does not exist: ${missingWorktreePath}`,
    );
    expect(ptySpawn).not.toHaveBeenCalled();
  });



  test("starts legacy terminal session identifiers without a remembered config", async () => {
    const worktreePath = await createTempDir("ork-electron-legacy-terminal-");
    const environment = createEnvironment({
      id: "env-legacy-terminal",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const localSessionId = `${environment.id}:legacy-local`;
    const containerSessionId = "container-legacy:legacy-container";

    await commands.get("start_local_terminal_session")?.(
      { sessionId: localSessionId },
      context,
    );
    await commands.get("start_terminal_session")?.(
      { sessionId: containerSessionId },
      context,
    );

    expect(ptySpawn.mock.calls[0]?.[0]).toBe(expectedLocalShellPath());
    expect(ptySpawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: worktreePath,
      cols: 80,
      rows: 24,
    });
    expect(ptySpawn.mock.calls[1]?.[0]).toBe("docker");
    expect(ptySpawn.mock.calls[1]?.[1]).toEqual([
      "exec",
      "-it",
      "container-legacy",
      "bash",
      "-lc",
      [
        "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true",
        "orkestrator_source_runtime_env 2>/dev/null || true",
        "exec zsh -l",
      ].join("\n"),
    ]);
  });



  test("starts container terminal sessions through docker exec in a PTY", async () => {
    const environment = createEnvironment({
      id: "env-container-terminal",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const createArgs = {
      containerId: "container-1",
      environmentId: environment.id,
      terminalKey: "root-tab",
      cols: 100,
      rows: 32,
      user: "node",
    };

    const firstResult = terminalSessionResult(await commands.get("create_terminal_session")?.(
      createArgs,
      context,
    ));
    const sessionId = firstResult.sessionId;
    expect(firstResult.created).toBe(true);
    await commands.get("start_terminal_session")?.({ sessionId }, context);
    const reattachedResult = terminalSessionResult(await commands.get("create_terminal_session")?.(
      createArgs,
      context,
    ));
    const reattachedSessionId = reattachedResult.sessionId;
    expect(reattachedResult.created).toBe(false);
    await commands.get("start_terminal_session")?.(
      { sessionId: reattachedSessionId },
      context,
    );

    const spawnCall = ptySpawn.mock.calls[0];
    expect(reattachedSessionId).toBe(sessionId);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(spawnCall?.[0]).toBe("docker");
    expect(spawnCall?.[1]).toEqual([
      "exec",
      "-it",
      "--user",
      "node",
      "container-1",
      "bash",
      "-lc",
      expect.stringContaining("orkestrator_source_runtime_env"),
    ]);
    expect(spawnCall?.[2]).toMatchObject({
      cols: 100,
      rows: 32,
    });
  });



  test("supersedes a stable container terminal when its target or activity context changes", async () => {
    const environment = createEnvironment({
      id: "env-container-terminal-replaced",
      environmentType: "containerized",
      containerId: "container-old",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const baseArgs = {
      environmentId: environment.id,
      terminalKey: "root-tab",
      cols: 100,
      rows: 32,
    };

    const first = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, containerId: "container-old", user: "node" },
      context,
    ));
    await commands.get("start_terminal_session")?.({ sessionId: first.sessionId }, context);

    environment.containerId = "container-new";
    const changedContainer = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, containerId: "container-new", user: "node" },
      context,
    ));
    expect(changedContainer.created).toBe(true);
    expect(changedContainer.sessionId).not.toBe(first.sessionId);
    expect(ptyProcesses[0]?.kill).toHaveBeenCalledTimes(1);
    await commands.get("start_terminal_session")?.(
      { sessionId: changedContainer.sessionId },
      context,
    );
    expect(ptySpawn.mock.calls[1]?.[1]).toEqual([
      "exec",
      "-it",
      "--user",
      "node",
      "container-new",
      "bash",
      "-lc",
      expect.stringContaining("orkestrator_source_runtime_env"),
    ]);

    const changedUser = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, containerId: "container-new", user: "root" },
      context,
    ));
    expect(changedUser.created).toBe(true);
    expect(changedUser.sessionId).not.toBe(changedContainer.sessionId);
    expect(ptyProcesses[1]?.kill).toHaveBeenCalledTimes(1);

    const changedActivity = terminalSessionResult(await commands.get("create_terminal_session")?.(
      {
        ...baseArgs,
        containerId: "container-new",
        user: "root",
        trackEnvironmentActivity: true,
      },
      context,
    ));
    expect(changedActivity.created).toBe(true);
    expect(changedActivity.sessionId).not.toBe(changedUser.sessionId);
  });



  test("does not start a container terminal after its stable session is superseded during lookup", async () => {
    const environment = createEnvironment({
      id: "env-container-terminal-start-replaced",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const baseArgs = {
      containerId: "container-1",
      environmentId: environment.id,
      terminalKey: "root-tab",
      cols: 100,
      rows: 32,
    };
    const first = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, user: "node" },
      context,
    ));
    const originalGetEnvironment = context.storage.getEnvironment.bind(context.storage);
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupStarted = false;
    context.storage.getEnvironment = mock(async (environmentId) => {
      lookupStarted = true;
      await lookupGate;
      return originalGetEnvironment(environmentId);
    });

    const startPromise = commands.get("start_terminal_session")?.(
      { sessionId: first.sessionId },
      context,
    ) as Promise<void>;
    await waitForCondition(() => lookupStarted, "the container terminal environment lookup");

    const replacement = terminalSessionResult(await commands.get("create_terminal_session")?.(
      { ...baseArgs, user: "root" },
      context,
    ));
    releaseLookup();

    await expect(startPromise).rejects.toThrow("Container terminal session is no longer available");
    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect(ptySpawn).not.toHaveBeenCalled();

    commands.get("detach_terminal")?.({ sessionId: replacement.sessionId }, context);
  }, ASYNC_TEST_BUDGET_MS);

});

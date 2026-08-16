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



  test("only treats an exact hexadecimal object id as an immutable baseline", () => {
    expect(isImmutableCommitRef("a".repeat(40))).toBe(true);
    expect(isImmutableCommitRef(`  ${"A1".repeat(20)}  `)).toBe(true);
    for (const ref of [
      "a".repeat(39),
      "a".repeat(41),
      "g".repeat(40),
      `refs/heads/${"a".repeat(40)}`,
      "",
    ]) {
      expect(isImmutableCommitRef(ref)).toBe(false);
    }
  });



  test("does not block local untracked scanning on a named pipe", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const fifoPath = path.join(worktree, "waiting.pipe");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(created.status).toBe(0);

    await expect(commandTesting.countLocalFileLines(worktree, "waiting.pipe"))
      .resolves.toBe(0);
  });



  test("abandons line counting when an untracked file grows beyond the read cap", async () => {
    const read = mock(async (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(0x61, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    const openSpy = spyOn(fs, "open").mockResolvedValue({
      stat: mock(async () => ({ isFile: () => true, size: 1 })),
      read,
      close: mock(async () => undefined),
    } as never);

    try {
      await expect(commandTesting.countLocalFileLines("/unused", "growing.log"))
        .resolves.toBe(0);
      expect(read).toHaveBeenCalledTimes(161);
    } finally {
      openSpy.mockRestore();
    }
  });



  test("parses copy tuples and rejects truncated or malformed Git tuples", () => {
    expect(commandTesting.parseGitFileChanges(
      "C100\0old{name}.txt\0new => \t雪.txt\0",
      "2\t1\t\0old{name}.txt\0new => \t雪.txt\0",
    )).toEqual([expect.objectContaining({
      status: "C100",
      originalPath: "old{name}.txt",
      path: "new => \t雪.txt",
      additions: 2,
      deletions: 1,
    })]);
    expect(commandTesting.parseGitFileChanges(
      "M\0binary.bin\0M\0without-stats.txt\0",
      "-\t-\tbinary.bin\0",
    )).toEqual([
      expect.objectContaining({ path: "binary.bin", additions: 0, deletions: 0 }),
      expect.objectContaining({ path: "without-stats.txt", additions: 0, deletions: 0 }),
    ]);

    for (const [nameStatus, numstat] of [
      ["M\0missing-terminator", "1\t0\tfile.txt\0"],
      ["R100\0old.txt\0", "1\t0\t\0old.txt\0new.txt\0"],
      ["M\0file.txt\0", "bad\t0\tfile.txt\0"],
      ["M\0file.txt\0", "1\t0\t\0old-only.txt\0"],
    ]) {
      expect(() => commandTesting.parseGitFileChanges(nameStatus, numstat)).toThrow("Malformed");
    }
    for (const malformed of ["missing-nul", "x\tpath\0", "1\t\0"]) {
      expect(() => commandTesting.parseContainerUntrackedStats(malformed)).toThrow("Malformed");
    }
  });



  test("counts container untracked lines with bounded binary and symlink handling", async () => {
    const workspace = await createTempDir("ork-container-untracked-scanner-");
    const files = new Map<string, string | Buffer>([
      ["no-trailing.txt", "one\ntwo"],
      ["crlf.txt", "one\r\ntwo\r\n"],
      ["lone-cr.txt", "one\rtwo"],
      ["tab\tline\n雪.txt", "one\n"],
      ["empty.txt", ""],
      ["binary.bin", Buffer.from([1, 0, 2])],
      ["exact-limit.txt", "x".repeat(16)],
      ["over-limit.txt", "x".repeat(17)],
    ]);
    for (const [filePath, content] of files) {
      await fs.writeFile(path.join(workspace, filePath), content);
    }
    await fs.symlink("no-trailing.txt", path.join(workspace, "link.txt"));
    const status = [...files.keys(), "link.txt"]
      .map((filePath) => `?? ${filePath}\0`)
      .join("");
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "16"],
      { cwd: workspace, input: Buffer.from(status), encoding: "utf8" },
    );
    expect(result.status).toBe(0);

    const changes = commandTesting.parseContainerUntrackedStats(result.stdout);
    expect(changes).toContainEqual(expect.objectContaining({ path: "no-trailing.txt", additions: 2 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "crlf.txt", additions: 2 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "lone-cr.txt", additions: 2 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "tab\tline\n雪.txt", additions: 1 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "empty.txt", additions: 0 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "binary.bin", additions: 0 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "exact-limit.txt", additions: 1 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "over-limit.txt", additions: 0 }));
    expect(changes).toContainEqual(expect.objectContaining({ path: "link.txt", additions: 0 }));
  });



  test("does not block container untracked scanning on a named pipe", async () => {
    const workspace = await createTempDir("ork-container-untracked-fifo-");
    const fifoPath = path.join(workspace, "waiting.pipe");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(created.status).toBe(0);

    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024", "10"],
      {
        cwd: workspace,
        input: Buffer.from("?? waiting.pipe\0"),
        encoding: "utf8",
        timeout: 2_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(commandTesting.parseContainerUntrackedStats(result.stdout)).toEqual([
      expect.objectContaining({ path: "waiting.pipe", additions: 0 }),
    ]);
  });



  test("stops line-counting container files after the configured scan cap", async () => {
    const workspace = await createTempDir("ork-container-untracked-cap-");
    await Promise.all(["one.txt", "two.txt", "three.txt"].map((filePath) =>
      fs.writeFile(path.join(workspace, filePath), "one\ntwo\n")
    ));
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024", "2"],
      {
        cwd: workspace,
        input: Buffer.from("?? one.txt\0?? two.txt\0?? three.txt\0"),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(commandTesting.parseContainerUntrackedStats(result.stdout)).toEqual([
      expect.objectContaining({ path: "one.txt", additions: 2 }),
      expect.objectContaining({ path: "two.txt", additions: 2 }),
      expect.objectContaining({ path: "three.txt", additions: 0 }),
    ]);
  });



  test("rejects every malformed Git tuple shape the framing can produce", () => {
    for (const [nameStatus, numstat] of [
      ["\0file.txt\0", ""],                          // name-status: empty status
      ["M\0\0", ""],                                 // name-status: empty path
      ["R100\0\0new.txt\0", ""],                     // name-status: empty rename source
      ["M\0file.txt\0", "10\0"],                     // numstat: header with no tab
      ["M\0file.txt\0", "10\t0\0"],                  // numstat: header with one tab
      ["M\0file.txt\0", "\t0\tfile.txt\0"],          // numstat: leading tab, no additions
      ["M\0file.txt\0", "1\t0\t\0\0\0"],             // numstat: rename record, empty result path
    ]) {
      expect(() => commandTesting.parseGitFileChanges(nameStatus, numstat)).toThrow("Malformed");
    }
  });



  test("rejects untracked scanner input that is not NUL-terminated", async () => {
    const workspace = await createTempDir("ork-container-untracked-truncated-");
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024"],
      { cwd: workspace, input: Buffer.from("?? truncated.txt"), encoding: "utf8" },
    );
    expect(result.status).toBe(2);
  });



  test("counts only untracked porcelain records, skipping tracked and rename fields", async () => {
    const workspace = await createTempDir("ork-container-untracked-skip-");
    await fs.writeFile(path.join(workspace, "tracked.txt"), "one\ntwo\nthree\n");
    await fs.writeFile(path.join(workspace, "untracked.txt"), "one\n");
    await fs.mkdir(path.join(workspace, "a-directory"));
    // `git status --porcelain=v1 -z` emits a staged rename as two NUL fields, the
    // second carrying no status prefix at all. Reading that bare path as if it were
    // an untracked entry would report a tracked file's line count as an addition.
    const status = [
      " M tracked.txt\0",
      "R  renamed.txt\0tracked.txt\0",
      "?? untracked.txt\0",
      "?? a-directory\0",
    ].join("");
    const result = spawnSync(
      "node",
      ["-e", CONTAINER_UNTRACKED_STATS_SCANNER, "--", "1024"],
      { cwd: workspace, input: Buffer.from(status), encoding: "utf8" },
    );
    expect(result.status).toBe(0);

    const changes = commandTesting.parseContainerUntrackedStats(result.stdout);
    expect(changes.map((change) => change.path)).toEqual(["untracked.txt", "a-directory"]);
    expect(changes).toContainEqual(expect.objectContaining({ path: "untracked.txt", additions: 1 }));
    // A directory is opened successfully on both Linux and macOS, so the guard that
    // rejects it is the fstat check rather than the open itself.
    expect(changes).toContainEqual(expect.objectContaining({ path: "a-directory", additions: 0 }));
  });



  test("refuses to establish a baseline without a usable target", async () => {
    const local = createEnvironment({
      id: "env-baseline-no-worktree",
      environmentType: "local",
      worktreePath: undefined,
    });
    await expect(commandTesting.establishCreatedFromCommit(local, createContext(local).context))
      .rejects.toThrow("Local environment worktree is not available");

    const noContainer = createEnvironment({
      id: "env-baseline-no-container",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
    });
    await expect(commandTesting.establishCreatedFromCommit(noContainer, createContext(noContainer).context))
      .rejects.toThrow("Environment has no container");

    const stopped = createEnvironment({
      id: "env-baseline-stopped-container",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "stopped",
    });
    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'exited\\n'
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commandTesting.establishCreatedFromCommit(stopped, createContext(stopped).context))
        .rejects.toThrow("Container is not running");
      const dockerLog = await fs.readFile(logs.all, "utf8");
      expect(dockerLog).not.toContain("--prepare-only");
    });
  }, ASYNC_TEST_BUDGET_MS);



  test("captures the baseline once for callers that race outside the setup path", async () => {
    const environment = createEnvironment({
      id: "env-baseline-dedup",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment);

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '5555555555555555555555555555555555555555\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async (logs) => {
      const [first, second] = await Promise.all([
        commandTesting.establishCreatedFromCommit(environment, context),
        commandTesting.establishCreatedFromCommit(environment, context),
      ]);

      expect(first.createdFromCommit).toBe("5555555555555555555555555555555555555555");
      // Both callers observe the identical resolution, which is only possible if
      // the second joined the first task rather than starting its own.
      expect(second).toBe(first);
      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog.split("\n").filter((line) => line.includes("--prepare-only"))).toHaveLength(1);
    });
  }, ASYNC_TEST_BUDGET_MS);



  test("refuses to complete setup without a captured creation commit", async () => {
    const environment = createEnvironment({
      id: "env-complete-without-baseline",
      setupScriptsComplete: false,
    });
    const { context, emitted } = createContext(environment);

    await expect(commandTesting.completeEnvironmentSetup(environment, context))
      .rejects.toThrow("Environment creation commit was not captured before setup completed");
    expect(environment.setupScriptsComplete).toBe(false);
    expect(emitted).toEqual([]);
  });



  test("decodes sections whatever whitespace the container's base64 emits", () => {
    const nameStatus = "M\0keep.txt\0";
    const numstat = "1\t0\tkeep.txt\0";
    // GNU coreutils with -w0 emits no whitespace, macOS appends a trailing newline,
    // and an implementation that ignores -w0 wraps at 76 columns. All three decode.
    const variants = [
      (encoded: string) => encoded,
      (encoded: string) => `${encoded}\n`,
      (encoded: string) => (encoded.match(/.{1,4}/g) ?? []).join("\n"),
    ];
    for (const wrap of variants) {
      const response = [
        "ORKESTRATOR_NAME_STATUS",
        wrap(Buffer.from(nameStatus).toString("base64")),
        "ORKESTRATOR_NUMSTAT",
        wrap(Buffer.from(numstat).toString("base64")),
        "ORKESTRATOR_UNTRACKED",
        "",
        "ORKESTRATOR_END",
      ].join("");
      expect(commandTesting.parseContainerGitStatusResponse(response, true)).toEqual([
        expect.objectContaining({ path: "keep.txt", status: "M", additions: 1 }),
      ]);
    }
    // Stripping whitespace must not make genuinely invalid payloads decodable.
    expect(() => commandTesting.parseContainerGitStatusResponse(
      framedContainerGitStatus().replace(
        "ORKESTRATOR_NUMSTAT",
        "%%%ORKESTRATOR_NUMSTAT",
      ),
      true,
    )).toThrow("invalid base64");
  });



  test("collects real git status through the composed container script", async () => {
    const repo = await createTempDir("ork-container-script-repo-");
    await runGit(repo, ["init", "-b", "main", "."]);
    await fs.writeFile(path.join(repo, "keep.txt"), "a\nb\nc\n");
    await fs.writeFile(path.join(repo, "old name.txt"), "x\ny\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "base"]);
    await runGit(repo, ["checkout", "-b", "work"]);
    await runGit(repo, ["mv", "old name.txt", "new\tname.txt"]);
    await fs.writeFile(path.join(repo, "keep.txt"), "a\nb\nc\nd\n");
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-m", "work"]);
    await fs.writeFile(path.join(repo, "untracked.txt"), "1\n2\n3");

    // Runs the composed program through a real shell, so `set -e -o pipefail`, the
    // base64 framing and the piped node scanner are exercised rather than asserted
    // as text against a fake `docker` that never interprets them.
    const script = commandTesting.buildContainerGitStatusScript("main", true);
    await withGnuBase64Shim(async (env) => {
      const result = spawnSync("bash", ["-c", script], { cwd: repo, encoding: "utf8", env });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const changes = commandTesting.parseContainerGitStatusResponse(result.stdout, true);
      expect(changes).toContainEqual(expect.objectContaining({ path: "keep.txt", status: "M", additions: 1 }));
      expect(changes).toContainEqual(expect.objectContaining({
        path: "new\tname.txt",
        originalPath: "old name.txt",
      }));
      expect(changes).toContainEqual(expect.objectContaining({
        path: "untracked.txt",
        status: "?",
        additions: 3,
      }));
    });
  }, ASYNC_TEST_BUDGET_MS);

});

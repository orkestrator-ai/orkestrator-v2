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

describe("agent skill commands", () => {
  test("lists and reads skills through the validated command boundary", async () => {
    const home = await createTempDir("ork-electron-agent-skills-");
    const skillDirectory = path.join(home, ".claude", "skills", "example");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      skillPath,
      "---\nname: example\ndescription: Example skill\n---\n# Example\n",
    );
    setAgentSkillsHomeForTesting(home);

    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment());
    const scan = (await commands.get("list_agent_skills")?.({ provider: "claude" }, context)) as {
      skills: Array<{ name: string; filePath: string }>;
    };

    expect(scan.skills).toHaveLength(1);
    expect(scan.skills[0]).toMatchObject({ name: "example", filePath: skillPath });
    await expect(
      commands.get("read_agent_skill")?.({ provider: "claude", filePath: skillPath }, context),
    ).resolves.toMatchObject({ path: skillPath, content: expect.stringContaining("# Example") });
  });

  test("rejects malformed agent skill command arguments before filesystem access", async () => {
    const home = await createTempDir("ork-electron-agent-skills-invalid-");
    setAgentSkillsHomeForTesting(home);
    const commands = createCommandRegistry();
    const { context } = createContext(createEnvironment());

    await expect(
      commands.get("list_agent_skills")?.({ provider: "claude", unexpected: true }, context),
    ).rejects.toThrow("Unexpected list_agent_skills argument field");
    await expect(
      commands.get("list_agent_skills")?.({ provider: "other" }, context),
    ).rejects.toThrow("Expected provider to be claude, codex, cursor, grok or opencode");
    await expect(
      commands.get("read_agent_skill")?.({ provider: "claude" }, context),
    ).rejects.toThrow("Expected filePath to be a string");
    await expect(
      commands.get("read_agent_skill")?.(
        { provider: "claude", filePath: "/tmp/SKILL.md", unexpected: true },
        context,
      ),
    ).rejects.toThrow("Unexpected read_agent_skill argument field");
    await expect(
      commands.get("read_agent_skill")?.(
        { provider: "claude", filePath: path.join(home, "outside", "SKILL.md") },
        context,
      ),
    ).rejects.toThrow("outside the agent skill directories");
    await expect(
      commands.get("read_agent_skill")?.(
        {
          provider: "claude",
          filePath: path.join(home, ".claude", "skills", "missing", "SKILL.md"),
        },
        context,
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  test("lists and reads project skills inside a local environment", async () => {
    const worktree = await fs.realpath(await createTempDir("ork-environment-agent-skills-"));
    await fs.mkdir(path.join(worktree, ".git"));
    const skillDirectory = path.join(worktree, ".agents", "skills", "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      skillPath,
      "---\nname: review\ndescription: Environment review\n---\n# Review\n",
    );
    const environment = createEnvironment({
      id: "env-skills",
      environmentType: "local",
      worktreePath: worktree,
      containerId: null,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const scan = (await commands.get("list_environment_agent_skills")?.(
      { environmentId: environment.id, provider: "codex" },
      context,
    )) as { skills: Array<{ name: string; filePath: string; scope: string }> };
    expect(scan.skills).toContainEqual(
      expect.objectContaining({
        name: "review",
        filePath: skillPath,
        scope: "project",
      }),
    );

    await expect(
      commands.get("read_environment_agent_skill")?.(
        { environmentId: environment.id, provider: "codex", filePath: skillPath },
        context,
      ),
    ).resolves.toMatchObject({
      path: skillPath,
      content: expect.stringContaining("# Review"),
    });
  });

  test("validates environment skill command arguments", async () => {
    const environment = createEnvironment({ id: "env-skills" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("list_environment_agent_skills")?.(
        { environmentId: environment.id, provider: "other" },
        context,
      ),
    ).rejects.toThrow("Expected provider to be claude, codex, cursor, grok or opencode");
    await expect(
      commands.get("list_environment_agent_skills")?.(
        { environmentId: environment.id, provider: "claude", unexpected: true },
        context,
      ),
    ).rejects.toThrow("Unexpected list_environment_agent_skills argument field");
    await expect(
      commands.get("read_environment_agent_skill")?.(
        { environmentId: environment.id, provider: "claude" },
        context,
      ),
    ).rejects.toThrow("Expected filePath to be a string");
    await expect(
      commands.get("list_environment_agent_skills")?.(
        { environmentId: "missing", provider: "claude" },
        context,
      ),
    ).rejects.toThrow("Environment not found: missing");
  });
});

describe("agent extension discovery commands", () => {
  type RunCall = {
    command: string;
    args: string[];
    options: Record<string, unknown> | undefined;
  };

  function recordingRun(stdout: string | string[] = "") {
    const calls: RunCall[] = [];
    let outputIndex = 0;
    const run = (async (
      command: string,
      args: string[] = [],
      options?: Record<string, unknown>,
    ) => {
      calls.push({ command, args, options });
      const next = Array.isArray(stdout)
        ? (stdout[Math.min(outputIndex++, stdout.length - 1)] ?? "")
        : stdout;
      return { stdout: next, stderr: "" };
    }) as unknown as Parameters<typeof commandTesting.createExtensionCommandRunner>[2];
    return { run, calls };
  }

  test("runs the agent CLI inside the worktree for a local environment", async () => {
    const environment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: null,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("docs: cmd - Connected");

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
    await expect(runner("claude", ["mcp", "list"])).resolves.toBe("docs: cmd - Connected");
    await runner("opencode", ["debug", "config"]);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["mcp", "list"]);
    expect(calls[0]!.options).toMatchObject({
      cwd: "/tmp/worktree",
      timeoutMs: 20_000,
    });
    // Colour codes would otherwise have to be stripped out of every parser.
    expect((calls[0]!.options as { env: Record<string, string> }).env.NO_COLOR).toBe("1");
    expect(calls[1]!.args).toEqual(["debug", "config"]);
  });

  // Cursor and Grok never fall back to a PATH lookup — `cursor` on PATH is the
  // desktop editor — so an unmanaged toolchain makes the launch impossible.
  // That has to surface as this one agent's failure, not as a spawn of the
  // wrong executable and not as a failure of the whole catalog.
  for (const agent of [
    { id: "cursor", message: "Cursor Agent is not installed in this backend's toolchain." },
    { id: "grok", message: "Grok Build is not installed in this backend's toolchain." },
  ] as const) {
    test(`fails ${agent.id} discovery locally without spawning anything when it is not installed`, async () => {
      const environment = createEnvironment({
        id: "env-local",
        environmentType: "local",
        worktreePath: "/tmp/worktree",
        containerId: null,
      });
      const { context } = createContext(environment);
      const { run, calls } = recordingRun("docs: cmd - Connected");

      const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
      await expect(runner(agent.id, ["mcp", "list", "--json"])).rejects.toThrow(agent.message);
      expect(calls).toEqual([]);

      // The sibling agents share this runner, so the missing toolchain must not
      // take them down with it.
      await expect(runner("claude", ["mcp", "list"])).resolves.toBe("docs: cmd - Connected");
      expect(calls).toHaveLength(1);
    });
  }

  test("runs the agent CLI in the container for a containerized environment", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("[]");

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
    await expect(runner("codex", ["mcp", "list", "--json"])).resolves.toBe("[]");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("docker");
    expect(calls[0]!.args).toEqual([
      "exec",
      "-e",
      "NO_COLOR=1",
      "-w",
      "/workspace",
      "container-1",
      "codex",
      "mcp",
      "list",
      "--json",
    ]);
    expect(calls[0]!.options).toMatchObject({ timeoutMs: 20_000 });
  });

  test("runs Cursor Agent discovery as cursor-agent inside a container", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("[]");

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
    await expect(runner("cursor", ["mcp", "list", "--format", "json"])).resolves.toBe("[]");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("docker");
    expect(calls[0]!.args).toEqual([
      "exec",
      "-e",
      "NO_COLOR=1",
      "-w",
      "/workspace",
      "container-1",
      "cursor-agent",
      "mcp",
      "list",
      "--format",
      "json",
    ]);
  });

  test("runs environment skill discovery inside the selected container", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const response = { provider: "codex", roots: [], skills: [], errors: [] };
    const { run, calls } = recordingRun(JSON.stringify(response));

    await expect(
      commandTesting.runEnvironmentAgentSkills(environment, context, "codex", "list", "", run),
    ).resolves.toEqual(response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("docker");
    expect(calls[0]!.args.slice(0, 6)).toEqual([
      "exec",
      "-w",
      "/workspace",
      "container-1",
      "node",
      "-e",
    ]);
    expect(calls[0]!.args.slice(-3)).toEqual(["codex", "list", ""]);
    expect(calls[0]!.options).toMatchObject({ timeoutMs: 20_000 });
  });

  test("uses OpenCode's resolved catalogue as bounded scanner input", async () => {
    const environment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: null,
    });
    const { context } = createContext(environment);
    const catalogue = [
      {
        name: "review",
        description: "Environment review",
        location: "/tmp/worktree/.opencode/skills/review/SKILL.md",
        content: "content that must not be copied into scanner input",
      },
    ];
    const response = { provider: "opencode", roots: [], skills: [], errors: [] };
    const { run, calls } = recordingRun([JSON.stringify(catalogue), JSON.stringify(response)]);

    await expect(
      commandTesting.runEnvironmentAgentSkills(environment, context, "opencode", "list", "", run),
    ).resolves.toEqual(response);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["debug", "skill"]);
    expect(calls[1]!.args.slice(0, 2)).toEqual(["-e", expect.any(String)]);
    expect(JSON.parse(String(calls[1]!.options?.stdin))).toEqual([
      {
        name: "review",
        description: "Environment review",
        location: "/tmp/worktree/.opencode/skills/review/SKILL.md",
      },
    ]);
    expect(String(calls[1]!.options?.stdin)).not.toContain("must not be copied");
  });

  test("pipes OpenCode's catalogue into a container scanner", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const response = { provider: "opencode", roots: [], skills: [], errors: [] };
    const { run, calls } = recordingRun([
      JSON.stringify([
        {
          name: "review",
          location: "/workspace/.opencode/skills/review/SKILL.md",
        },
      ]),
      JSON.stringify(response),
    ]);

    await commandTesting.runEnvironmentAgentSkills(
      environment,
      context,
      "opencode",
      "list",
      "",
      run,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain("opencode");
    expect(calls[1]!.args.slice(0, 3)).toEqual(["exec", "-i", "-w"]);
    expect(typeof calls[1]!.options?.stdin).toBe("string");
  });

  test("rejects malformed OpenCode catalogues before starting the scanner", async () => {
    const environment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: null,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("not-json");

    await expect(
      commandTesting.runEnvironmentAgentSkills(environment, context, "opencode", "list", "", run),
    ).rejects.toThrow("OpenCode returned an invalid skills catalogue");
    expect(calls).toHaveLength(1);
  });

  test("drops OpenCode's built-in skill, which has no file to read or reveal", () => {
    expect(
      commandTesting.parseOpenCodeEnvironmentSkills(
        JSON.stringify([
          { name: "configuration", location: "<built-in>" },
          { name: "review", location: "/workspace/.opencode/skills/review/SKILL.md" },
        ]),
      ),
    ).toEqual([
      {
        name: "review",
        location: "/workspace/.opencode/skills/review/SKILL.md",
      },
    ]);
  });

  test("rejects a catalogue entry whose location is not an absolute SKILL.md", () => {
    for (const location of [
      ".opencode/skills/review/SKILL.md",
      "/workspace/.opencode/skills/review/notes.md",
      "/workspace/.opencode/skills/review",
      `/workspace/${"x".repeat(4_097)}/SKILL.md`,
    ]) {
      expect(() =>
        commandTesting.parseOpenCodeEnvironmentSkills(
          JSON.stringify([{ name: "review", location }]),
        ),
      ).toThrow("OpenCode returned an invalid skill entry");
    }
    for (const entry of [
      { name: "", location: "/workspace/SKILL.md" },
      { name: 7, location: "/workspace/SKILL.md" },
      { name: "review", location: "/workspace/SKILL.md", description: 7 },
      ["review", "/workspace/SKILL.md"],
      null,
    ]) {
      expect(() => commandTesting.parseOpenCodeEnvironmentSkills(JSON.stringify([entry]))).toThrow(
        "OpenCode returned an invalid skill entry",
      );
    }
  });

  test("refuses a catalogue larger than the scanner is willing to accept", () => {
    const entry = { name: "review", location: "/workspace/.opencode/skills/review/SKILL.md" };
    expect(
      commandTesting.parseOpenCodeEnvironmentSkills(
        JSON.stringify(Array.from({ length: 2_000 }, () => entry)),
      ),
    ).toHaveLength(2_000);
    expect(() =>
      commandTesting.parseOpenCodeEnvironmentSkills(
        JSON.stringify(Array.from({ length: 2_001 }, () => entry)),
      ),
    ).toThrow("OpenCode returned more than 2000 skills");
    expect(() =>
      commandTesting.parseOpenCodeEnvironmentSkills(JSON.stringify({ skills: [] })),
    ).toThrow("OpenCode returned an invalid skills catalogue");
  });

  test("clamps catalogue metadata without splitting a surrogate pair", () => {
    const [skill] = commandTesting.parseOpenCodeEnvironmentSkills(
      JSON.stringify([
        {
          name: `  review${"n".repeat(600)}  `,
          description: "🙂".repeat(600),
          location: "/workspace/.opencode/skills/review/SKILL.md",
        },
      ]),
    );

    expect(Array.from(skill!.name)).toHaveLength(512);
    expect(Array.from(skill!.description ?? "")).toHaveLength(512);
    expect(skill!.description?.endsWith("🙂")).toBe(true);
  });

  test("reads a skill inside the selected container through the same scanner", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const response = {
      path: "/workspace/.agents/skills/review/SKILL.md",
      content: "# Review",
      truncated: false,
    };
    const { run, calls } = recordingRun(JSON.stringify(response));

    await expect(
      commandTesting.runEnvironmentAgentSkills(
        environment,
        context,
        "codex",
        "read",
        "/workspace/.agents/skills/review/SKILL.md",
        run,
      ),
    ).resolves.toEqual(response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("docker");
    expect(calls[0]!.args.slice(0, 6)).toEqual([
      "exec",
      "-w",
      "/workspace",
      "container-1",
      "node",
      "-e",
    ]);
    // The path is the scanner's third argument; passing it in any other
    // position would have it read as the operation.
    expect(calls[0]!.args.slice(-3)).toEqual([
      "codex",
      "read",
      "/workspace/.agents/skills/review/SKILL.md",
    ]);
  });

  test("rejects malformed scanner JSON and propagates execution failures", async () => {
    const environment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: null,
    });
    const { context } = createContext(environment);
    const malformed = recordingRun("not-json");
    await expect(
      commandTesting.runEnvironmentAgentSkills(
        environment,
        context,
        "codex",
        "list",
        "",
        malformed.run,
      ),
    ).rejects.toThrow("invalid skills response");

    const failure = new Error("scanner timed out");
    const failingRun = mock(async () => Promise.reject(failure)) as unknown as Parameters<
      typeof commandTesting.runEnvironmentAgentSkills
    >[5];
    await expect(
      commandTesting.runEnvironmentAgentSkills(
        environment,
        context,
        "codex",
        "list",
        "",
        failingRun,
      ),
    ).rejects.toBe(failure);
  });

  test("refuses environment skill discovery when no runtime is available", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun();

    await expect(
      commandTesting.runEnvironmentAgentSkills(environment, context, "codex", "list", "", run),
    ).rejects.toThrow("The environment is not available");
    expect(calls).toEqual([]);
  });

  test("prefers the container over a stale worktree path when both are set", async () => {
    const environment = createEnvironment({
      id: "env-both",
      environmentType: "containerized",
      containerId: "container-2",
      worktreePath: "/tmp/worktree",
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("[]");

    await commandTesting.createExtensionCommandRunner(environment, context, run)("codex", ["mcp"]);

    expect(calls[0]!.command).toBe("docker");
  });

  test("refuses to run anything when the environment has no worktree and no container", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun();

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);

    await expect(runner("claude", ["mcp", "list"])).rejects.toThrow(
      "The environment is not available",
    );
    expect(calls).toEqual([]);
  });

  test("reports every agent as unreadable when the environment cannot be reached", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const catalogs = (await commands.get("get_environment_extensions")?.(
      { environmentId: "env-nowhere" },
      context,
    )) as Array<Record<string, unknown>>;

    expect(catalogs.map((catalog) => catalog.agent)).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
    for (const catalog of catalogs) {
      expect(catalog.mcpServers).toEqual([]);
      expect(catalog.plugins).toEqual([]);
      expect(catalog.pluginError).toBeTruthy();
      // Pi ships no MCP client of its own — MCP is something one of its
      // packages adds — so an unreachable environment has nothing to fail at.
      // Reporting an error there would tell the user something is broken when
      // the feature simply does not exist.
      if (catalog.agent === "pi") expect(catalog.mcpError).toBeUndefined();
      else expect(catalog.mcpError).toBeTruthy();
    }
  });

  test("rejects an unknown environment", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_environment_extensions")?.({ environmentId: "missing" }, context),
    ).rejects.toThrow("Environment not found: missing");
  });

  test("requires an environmentId", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    await expect(commands.get("get_environment_extensions")?.({}, context)).rejects.toThrow(
      /environmentId/,
    );
  });

  test("caches per environment so reopening the dialog does not respawn MCP servers", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const lookups = context.storage.getEnvironment as unknown as { mock: { calls: unknown[] } };
    const lookupCount = () => lookups.mock.calls.length;

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);
    const afterFirst = lookupCount();

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);
    expect(lookupCount()).toBe(afterFirst);

    await commands.get("get_environment_extensions")?.(
      { environmentId: "env-nowhere", refresh: true },
      context,
    );
    expect(lookupCount()).toBe(afterFirst + 1);
  });

  test("drops the cached catalog when the environment is stopped", async () => {
    const environment = createEnvironment({
      id: "env-nowhere",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const lookups = context.storage.getEnvironment as unknown as { mock: { calls: unknown[] } };

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);
    await commands.get("stop_environment")?.({ environmentId: "env-nowhere" }, context);
    const beforeReread = lookups.mock.calls.length;

    await commands.get("get_environment_extensions")?.({ environmentId: "env-nowhere" }, context);

    expect(lookups.mock.calls.length).toBe(beforeReread + 1);
  });

  test("does not cache a failed lookup", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();
    const lookups = context.storage.getEnvironment as unknown as { mock: { calls: unknown[] } };

    await expect(
      commands.get("get_environment_extensions")?.({ environmentId: "missing" }, context),
    ).rejects.toThrow("Environment not found: missing");
    const afterFirst = lookups.mock.calls.length;

    await expect(
      commands.get("get_environment_extensions")?.({ environmentId: "missing" }, context),
    ).rejects.toThrow("Environment not found: missing");

    expect(lookups.mock.calls.length).toBe(afterFirst + 1);
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

  test("reports whether the selected host GitHub CLI credential is available", async () => {
    const { context } = createContext(createEnvironment());
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  printf 'host-gh-token\\n'
  exit 0
fi
exit 1
`,
      async () => {
        await expect(
          commands.get("get_container_github_credential_status")?.({}, context),
        ).resolves.toEqual({
          source: "host-cli",
          available: true,
        });
      },
    );

    await withFakeGh(
      `#!/bin/sh
exit 1
`,
      async () => {
        await expect(
          commands.get("get_container_github_credential_status")?.({}, context),
        ).resolves.toEqual({
          source: "host-cli",
          available: false,
        });
      },
    );
  });

  test("reports missing PAT credentials without reading host GitHub CLI auth", async () => {
    const { context } = createContext(createEnvironment(), {
      globalConfig: { useHostGitHubCredentials: false },
    });
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 0
`,
      async (ghLog) => {
        await expect(
          commands.get("get_container_github_credential_status")?.({}, context),
        ).resolves.toEqual({
          source: "pat",
          available: false,
        });
        expect(await fs.readFile(ghLog, "utf8").catch(() => "")).toBe("");
      },
    );

    const configuredContext = createContext(createEnvironment(), {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "configured-pat",
      },
    }).context;
    await expect(
      commands.get("get_container_github_credential_status")?.({}, configuredContext),
    ).resolves.toEqual({
      source: "pat",
      available: true,
    });
  });

  test("reports managed AI CLIs in priority order and falls back when none are installed", async () => {
    const root = await createTempDir("ork-electron-cli-checks-");
    const { context } = createContext(createEnvironment());
    context.appRoot = root;
    context.resourceRoot = root;
    context.toolchainBinDir = root;
    const commands = createCommandRegistry();
    const previousPath = process.env.PATH;

    try {
      process.env.PATH = "";
      await fs.writeFile(path.join(root, "codex"), "managed codex");
      await fs.writeFile(path.join(root, "opencode"), "managed opencode");

      await expect(commands.get("check_claude_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("opencode");

      await fs.writeFile(path.join(root, "claude"), "managed claude");
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("claude");

      await Promise.all(
        ["claude", "opencode", "codex"].map((name) =>
          fs.rm(path.join(root, name), { force: true }),
        ),
      );
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBeNull();

      // `cursor` is the desktop editor command, and even the real `cursor-agent`
      // and `grok` CLIs on PATH are not the managed executables this backend
      // generation activated. Availability has to agree with what
      // `start_local_*_server_cmd` will actually launch, so PATH answers
      // nothing for the ACP providers.
      const pathTools = await createTempDir("ork-electron-cli-path-");
      for (const name of ["cursor", "cursor-agent", "grok"]) {
        await fs.writeFile(path.join(pathTools, name), "#!/bin/sh\nexit 0\n");
        await fs.chmod(path.join(pathTools, name), 0o755);
      }
      process.env.PATH = `${pathTools}:/usr/bin:/bin`;

      await expect(commands.get("check_cursor_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_grok_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBeNull();

      // An activation directory predating the `cursor-agent` alias still only
      // holds the legacy managed name. It is the same bundle, so it counts.
      await fs.writeFile(path.join(root, "cursor"), "legacy managed cursor");
      await expect(commands.get("check_cursor_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("cursor");

      await fs.rm(path.join(root, "cursor"), { force: true });
      await fs.writeFile(path.join(root, "cursor-agent"), "managed cursor-agent");
      await expect(commands.get("check_cursor_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("cursor");

      // Grok has no alias, and Cursor still outranks it.
      await fs.writeFile(path.join(root, "grok"), "managed grok");
      await expect(commands.get("check_grok_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("cursor");
      await fs.rm(path.join(root, "cursor-agent"), { force: true });
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("grok");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

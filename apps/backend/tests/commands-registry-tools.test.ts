import { describe, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import * as agentSupport from "../src/core/commands-agent-support";
import { homePath } from "../src/core/shell";
import { ENVIRONMENT_AGENT_SKILLS_SCRIPT } from "../src/core/environment-agent-skills";
import { createCommandFixtures, type CommandContext } from "./command-fixtures";

const {
  commandTesting,
  createCommandRegistry,
  createContext,
  createEnvironment,
  createTempDir,
  fs,
  path,
  setAgentSkillsHomeForTesting,
  withFakeGh,
} = await createCommandFixtures();

// The skills scanner test runs the real scanner script in a subprocess.
setDefaultTimeout(30_000);

describe("agent skill commands", () => {
  test("registered plugin discovery runs the normal host runner", async () => {
    const runner = mock(async () => JSON.stringify([{ name: "example", enabled: true }]));
    const factory = spyOn(agentSupport, "createHostExtensionCommandRunner").mockReturnValue(runner);
    try {
      const { context } = createContext(createEnvironment());
      context.runtimeFlavor = "development";
      const commands = createCommandRegistry();
      await expect(
        commands.get("list_agent_plugins")?.({ provider: "claude" }, context),
      ).resolves.toMatchObject({
        agent: "claude",
        plugins: [expect.objectContaining({ name: "example" })],
      });
      expect(factory).toHaveBeenCalledWith(context);
      expect(runner).toHaveBeenCalledWith("claude", ["plugin", "list", "--json"]);
      await expect(
        commands.get("list_agent_plugins")?.({ provider: "invalid" }, context),
      ).rejects.toThrow();
      // A defined command (plan item 7009) drops an unknown key, and refuses it
      // only when the sender marks it critical, before discovery runs.
      await expect(
        (async () =>
          commands.get("list_agent_plugins")?.({ provider: "claude", extra: true }, context, {
            critical: ["extra"],
          }))(),
      ).rejects.toMatchObject({ code: "unsupported-field" });
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      factory.mockRestore();
    }
  });

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
      (async () =>
        commands.get("list_agent_skills")?.({ provider: "claude", unexpected: true }, context, {
          critical: ["unexpected"],
        }))(),
    ).rejects.toMatchObject({ code: "unsupported-field" });
    await expect(
      commands.get("list_agent_skills")?.({ provider: "other" }, context),
    ).rejects.toThrow("Expected provider to be claude, codex, cursor, grok or opencode");
    await expect(
      (async () => commands.get("read_agent_skill")?.({ provider: "claude" }, context))(),
    ).rejects.toThrow("Expected filePath to be a string");
    await expect(
      (async () =>
        commands.get("read_agent_skill")?.(
          { provider: "claude", filePath: "/tmp/SKILL.md", unexpected: true },
          context,
          { critical: ["unexpected"] },
        ))(),
    ).rejects.toMatchObject({ code: "unsupported-field" });
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
      (async () =>
        commands.get("list_environment_agent_skills")?.(
          { environmentId: environment.id, provider: "claude", unexpected: true },
          context,
          { critical: ["unexpected"] },
        ))(),
    ).rejects.toMatchObject({ code: "unsupported-field" });
    await expect(
      (async () =>
        commands.get("read_environment_agent_skill")?.(
          { environmentId: environment.id, provider: "claude" },
          context,
        ))(),
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

  /** OpenCode is the managed 2.x binary only; give the context one. */
  async function withManagedOpenCode(context: CommandContext): Promise<string> {
    const toolchain = await createTempDir("ork-electron-opencode2-toolchain-");
    await fs.writeFile(path.join(toolchain, "opencode2"), "managed opencode2");
    context.toolchainBinDir = toolchain;
    return path.join(toolchain, "opencode2");
  }

  test("runs the host's agent CLI from the home directory, outside any project", async () => {
    const { context } = createContext(createEnvironment());
    const { run, calls } = recordingRun("[]");

    const runner = commandTesting.createHostExtensionCommandRunner(context, run);
    await expect(runner("claude", ["plugin", "list", "--json"])).resolves.toBe("[]");

    expect(calls[0]!.args).toEqual(["plugin", "list", "--json"]);
    expect(calls[0]!.options).toMatchObject({ cwd: homePath(), timeoutMs: 20_000 });
    expect((calls[0]!.options as { env: Record<string, string> }).env.NO_COLOR).toBe("1");
  });

  test("runs the agent CLI inside the worktree for a local environment", async () => {
    const environment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: null,
    });
    const { context } = createContext(environment);
    const openCode = await withManagedOpenCode(context);
    const { run, calls } = recordingRun("docs: cmd - Connected");

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
    await expect(runner("claude", ["mcp", "list"])).resolves.toBe("docs: cmd - Connected");
    await runner("opencode", ["debug", "config"]);
    // OpenCode's discovery runs the managed 2.x binary, never a PATH `opencode`.
    expect(calls[1]!.command).toBe(openCode);

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

  // Cursor has no discovery CLI, and Grok never falls back to PATH. Both must
  // fail without spawning the wrong executable or taking down sibling agents.
  for (const agent of [
    { id: "cursor", message: "Cursor SDK extension discovery is not available through a CLI." },
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
      const emptyToolchain = await createTempDir("ork-electron-empty-toolchain-");
      context.appRoot = emptyToolchain;
      context.resourceRoot = emptyToolchain;
      context.toolchainBinDir = emptyToolchain;
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

  test("does not run a Cursor discovery command inside a container", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      worktreePath: undefined,
    });
    const { context } = createContext(environment);
    const { run, calls } = recordingRun("[]");

    const runner = commandTesting.createExtensionCommandRunner(environment, context, run);
    await expect(runner("cursor", ["mcp", "list", "--format", "json"])).rejects.toThrow(
      "Cursor SDK extension discovery is not available through a CLI.",
    );
    expect(calls).toEqual([]);
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

  test("scans OpenCode's skill directories without asking the CLI for a catalogue", async () => {
    const environment = createEnvironment({
      id: "env-local",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      containerId: null,
    });
    const { context } = createContext(environment);
    const response = { provider: "opencode", roots: [], skills: [], errors: [] };
    const { run, calls } = recordingRun(JSON.stringify(response));

    await expect(
      commandTesting.runEnvironmentAgentSkills(environment, context, "opencode", "list", "", run),
    ).resolves.toEqual(response);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["-e", expect.any(String)]);
    expect(calls[0]!.args.slice(-3)).toEqual(["opencode", "list", ""]);
    expect(calls[0]!.options?.stdin).toBeUndefined();
  });

  test("the scanner finds an OpenCode project skill and reads it back", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-opencode-skills-"));
    try {
      const skillDir = path.join(root, ".opencode", "skills", "review");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: review\ndescription: Environment review\n---\nReview.\n",
      );
      const scan = (args: string[]) =>
        Bun.spawnSync([process.execPath, "-e", ENVIRONMENT_AGENT_SKILLS_SCRIPT, ...args], {
          cwd: root,
          env: { HOME: root, PATH: process.env.PATH ?? "" },
        });
      const listed = scan(["opencode", "list", ""]);
      expect(listed.exitCode).toBe(0);
      const result = JSON.parse(listed.stdout.toString()) as {
        skills: Array<{ name: string; filePath: string; scope: string }>;
      };
      const skill = result.skills.find((entry) => entry.name === "review");
      expect(skill).toMatchObject({ scope: "project" });
      const read = scan(["opencode", "read", skill!.filePath]);
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout.toString()).content).toContain("Review.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      // Pi's settings-pane fallback has no CLI MCP list; Cursor gets MCP inventory from its live bridge.
      if (catalog.agent === "pi" || catalog.agent === "cursor") {
        expect(catalog.mcpError).toBeUndefined();
      } else expect(catalog.mcpError).toBeTruthy();
      expect(catalog.pluginError).toBeTruthy();
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

  test("reports whether the selected host GitHub CLI credential is available", async () => {
    const { context } = createContext(createEnvironment(), {
      globalConfig: { containerGitHubCredential: "host-cli" },
    });
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
      globalConfig: { useHostGitHubCredentials: false, containerGitHubCredential: "pat" },
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
        containerGitHubCredential: "pat",
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
      // OpenCode is the managed 2.x binary; a managed or PATH `opencode` is not it.
      await fs.writeFile(path.join(root, "opencode"), "an OpenCode 1.x");
      await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(false);
      await fs.writeFile(path.join(root, "opencode2"), "managed opencode2");

      await expect(commands.get("check_claude_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("opencode");

      await fs.writeFile(path.join(root, "claude"), "managed claude");
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("claude");

      await Promise.all(
        ["claude", "opencode2", "codex"].map((name) =>
          fs.rm(path.join(root, name), { force: true }),
        ),
      );
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBeNull();

      // PATH executables do not make the packaged Cursor SDK bridge or the
      // managed Grok toolchain available.
      const pathTools = await createTempDir("ork-electron-cli-path-");
      for (const name of ["cursor", "grok"]) {
        await fs.writeFile(path.join(pathTools, name), "#!/bin/sh\nexit 0\n");
        await fs.chmod(path.join(pathTools, name), 0o755);
      }
      process.env.PATH = `${pathTools}:/usr/bin:/bin`;

      await expect(commands.get("check_cursor_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_grok_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBeNull();

      const cursorBridgeEntrypoint = path.join(
        root,
        "bridges",
        "cursor-bridge",
        "dist",
        "index.js",
      );
      await fs.mkdir(path.dirname(cursorBridgeEntrypoint), { recursive: true });
      await fs.writeFile(cursorBridgeEntrypoint, "// packaged Cursor SDK bridge");
      await expect(commands.get("check_cursor_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("cursor");

      // Cursor still outranks the managed Grok CLI.
      await fs.writeFile(path.join(root, "grok"), "managed grok");
      await expect(commands.get("check_grok_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("cursor");
      await fs.rm(cursorBridgeEntrypoint, { force: true });
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("grok");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("logs managed, PATH, and missing host-tool sources once per command context", async () => {
    const managedRoot = await createTempDir("ork-electron-cli-source-managed-");
    const pathRoot = await createTempDir("ork-electron-cli-source-path-");
    const secondRoot = await createTempDir("ork-electron-cli-source-second-");
    const { context } = createContext(createEnvironment());
    context.appRoot = managedRoot;
    context.resourceRoot = managedRoot;
    context.toolchainBinDir = managedRoot;
    const { context: secondContext } = createContext(createEnvironment());
    secondContext.appRoot = secondRoot;
    secondContext.resourceRoot = secondRoot;
    secondContext.toolchainBinDir = secondRoot;
    const commands = createCommandRegistry();
    const previousPath = process.env.PATH;
    const info = spyOn(console, "info").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      await fs.writeFile(path.join(managedRoot, "codex"), "managed codex");
      process.env.PATH = "";
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);

      expect(info.mock.calls.filter(([message]) => String(message).includes("tool=codex"))).toEqual(
        [["[host] tool.available tool=codex source=managed"]],
      );

      await fs.rm(path.join(managedRoot, "codex"));
      await fs.writeFile(path.join(pathRoot, "codex"), "#!/bin/sh\nexit 0\n");
      await fs.chmod(path.join(pathRoot, "codex"), 0o755);
      process.env.PATH = `${pathRoot}:/usr/bin:/bin`;
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);

      expect(info.mock.calls.filter(([message]) => String(message).includes("tool=codex"))).toEqual(
        [
          ["[host] tool.available tool=codex source=managed"],
          ["[host] tool.available tool=codex source=path"],
        ],
      );

      await fs.rm(path.join(pathRoot, "codex"));
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_codex_cli")?.({}, secondContext)).resolves.toBe(false);

      expect(warn.mock.calls.filter(([message]) => String(message).includes("tool=codex"))).toEqual(
        [
          ["[host] tool.missing tool=codex source=missing"],
          ["[host] tool.missing tool=codex source=missing"],
        ],
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("ignores host PATH installs that an agent-test profile did not provision", async () => {
    const managedRoot = await createTempDir("ork-agent-test-cli-managed-");
    const pathRoot = await createTempDir("ork-agent-test-cli-path-");
    const { context } = createContext(createEnvironment());
    context.appRoot = managedRoot;
    context.resourceRoot = managedRoot;
    context.toolchainBinDir = managedRoot;
    context.runtimeFlavor = "agent-test";
    const commands = createCommandRegistry();
    const previousPath = process.env.PATH;

    try {
      for (const name of ["claude", "opencode", "codex", "pi"]) {
        await fs.writeFile(path.join(pathRoot, name), "#!/bin/sh\nexit 0\n");
        await fs.chmod(path.join(pathRoot, name), 0o755);
      }
      await fs.writeFile(path.join(managedRoot, "codex"), "managed codex");
      process.env.PATH = `${pathRoot}:/usr/bin:/bin`;

      await expect(commands.get("check_claude_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_pi_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("check_codex_cli")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBe("codex");

      await fs.rm(path.join(managedRoot, "codex"));
      await expect(commands.get("check_any_ai_cli")?.({}, context)).resolves.toBe(false);
      await expect(commands.get("get_available_ai_cli")?.({}, context)).resolves.toBeNull();

      // Outside agent-test the same host install is a usable platform.
      context.runtimeFlavor = "development";
      await expect(commands.get("check_claude_cli")?.({}, context)).resolves.toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("finds the toolchain's gh, and only that one in agent-test profiles", async () => {
    const managedRoot = await createTempDir("ork-github-cli-managed-");
    const pathRoot = await createTempDir("ork-github-cli-path-");
    const { context } = createContext(createEnvironment());
    context.appRoot = managedRoot;
    context.resourceRoot = managedRoot;
    context.toolchainBinDir = managedRoot;
    const commands = createCommandRegistry();
    const previousPath = process.env.PATH;

    try {
      process.env.PATH = "";
      await expect(commands.get("check_github_cli")?.({}, context)).resolves.toBe(false);
      await fs.writeFile(path.join(managedRoot, "gh"), "managed gh");
      await expect(commands.get("check_github_cli")?.({}, context)).resolves.toBe(true);

      await fs.rm(path.join(managedRoot, "gh"));
      await fs.writeFile(path.join(pathRoot, "gh"), "#!/bin/sh\nexit 0\n");
      await fs.chmod(path.join(pathRoot, "gh"), 0o755);
      process.env.PATH = `${pathRoot}:/usr/bin:/bin`;
      await expect(commands.get("check_github_cli")?.({}, context)).resolves.toBe(true);
      context.runtimeFlavor = "agent-test";
      await expect(commands.get("check_github_cli")?.({}, context)).resolves.toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test("reads the host Claude login when an agent-test profile may use it", async () => {
    const hostHome = await createTempDir("ork-agent-test-claude-home-");
    const configDir = await createTempDir("ork-agent-test-claude-config-");
    const { context } = createContext(createEnvironment());
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["claude"]);
    const commands = createCommandRegistry();
    const previousHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
    const previousConfigDir = process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;

    try {
      process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
      process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = configDir;
      await expect(commands.get("check_claude_config")?.({}, context)).resolves.toBe(false);

      // Claude keeps `.claude.json` in CLAUDE_CONFIG_DIR when it is set.
      await fs.writeFile(path.join(configDir, ".claude.json"), "{}");
      await expect(commands.get("check_claude_config")?.({}, context)).resolves.toBe(true);
      await fs.rm(path.join(configDir, ".claude.json"));

      await fs.writeFile(path.join(hostHome, ".claude.json"), "{}");
      await expect(commands.get("check_claude_config")?.({}, context)).resolves.toBe(true);
      await expect(commands.get("has_claude_credentials")?.({}, context)).resolves.toBe(true);

      context.credentialSources = new Set(["codex"]);
      expect(await commands.get("check_claude_config")?.({}, context)).toBe(false);
      expect(await commands.get("has_claude_credentials")?.({}, context)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
      else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = previousHome;
      if (previousConfigDir === undefined)
        delete process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
      else process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  test("checks the packaged Cursor bridge under resourceRoot in production", async () => {
    const appRoot = await createTempDir("ork-electron-app-root-");
    const resourceRoot = await createTempDir("ork-electron-resource-root-");
    const { context } = createContext(createEnvironment());
    context.appRoot = appRoot;
    context.resourceRoot = resourceRoot;

    const developmentEntrypoint = path.join(
      appRoot,
      "bridges",
      "cursor-bridge",
      "dist",
      "index.js",
    );
    await fs.mkdir(path.dirname(developmentEntrypoint), { recursive: true });
    await fs.writeFile(developmentEntrypoint, "// development bridge");

    await expect(commandTesting.hasCursorSdkBridge(context, "production")).resolves.toBe(false);

    const packagedEntrypoint = path.join(resourceRoot, "cursor-bridge", "dist", "index.js");
    await fs.mkdir(path.dirname(packagedEntrypoint), { recursive: true });
    await fs.writeFile(packagedEntrypoint, "// packaged bridge");

    await expect(commandTesting.hasCursorSdkBridge(context, "production")).resolves.toBe(true);
  });
});

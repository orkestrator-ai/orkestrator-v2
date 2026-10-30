import { describe, expect, expectTypeOf, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createEnvironment,
  defaultConfig,
  defaultRepositoryConfig,
  StorageService,
} from "./storage.js";
import type { AppConfig } from "./models.js";
import { MAX_CODEX_CONCURRENT_THREADS } from "./constants.js";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import { withTemporaryStorage } from "./storage-test-support.js";

// The default model ids here are the backend source of truth used whenever a
// user has no persisted config. They must stay in sync with the renderer
// defaults (see apps/web/src/stores/configStore.test.ts) and the offered model catalogs.
describe("defaultConfig", () => {
  test("persists and clears per-environment container resource limits", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = createEnvironment("project-1", { environmentType: "containerized" });
      await storage.addEnvironment(environment);
      const limits = { cpus: 1.5, memoryMiB: 2048, pids: 512 };
      await storage.updateEnvironment(environment.id, { containerResourceLimits: limits });
      await expect(
        storage.updateEnvironment(environment.id, { containerResourceLimits: { cpus: -1 } }),
      ).rejects.toThrow("Invalid container resource limit");
      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.getEnvironment(environment.id))?.containerResourceLimits).toEqual(
        limits,
      );
      await restarted.updateEnvironment(environment.id, { containerResourceLimits: null });
      expect(
        (await restarted.getEnvironment(environment.id))?.containerResourceLimits,
      ).toBeUndefined();
    });
  });
  test("returns the current default model selection", () => {
    const platforms = defaultConfig().global.agentSettings?.platforms;
    // Unset: OpenCode's connected, allowlisted default, which no fixed id matches
    // for every login.
    expect(platforms?.opencode).toEqual({ mode: "terminal" });
    expect(platforms?.claude?.model).toBe("claude-sonnet-5-5");
    expect(platforms?.codex?.model).toBe("gpt-5.4");
    expect(platforms?.codex?.reasoningEffort).toBe("high");
  });

  test("keeps the existing web client behavior enabled by default", () => {
    expect(defaultConfig().global.webClientEnabled).toBe(true);
  });

  test("enables durable terminal history by default and persists an opt-out", async () => {
    expect(defaultConfig().global.terminalHistoryEnabled).toBe(true);
    await withTemporaryStorage(async (storage) => {
      const current = (await storage.loadConfig()).global;
      const updated = await storage.updateGlobalConfig({
        ...current,
        terminalHistoryEnabled: false,
      });
      expect(updated.global.terminalHistoryEnabled).toBe(false);
      expect((await storage.loadConfig()).global.terminalHistoryEnabled).toBe(false);
    });
  });

  test("uses native Claude sessions by default", () => {
    expect(defaultConfig().global.agentSettings?.platforms?.claude?.mode).toBe("native");
  });

  test("uses host GitHub CLI credentials by default", () => {
    expect(defaultConfig().global.useHostGitHubCredentials).toBe(true);
    expectTypeOf<AppConfig["global"]["useHostGitHubCredentials"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  test("allows five concurrent Codex subagent threads by default", () => {
    expect(defaultConfig().global.codexMaxConcurrentThreads).toBe(5);
    expectTypeOf<AppConfig["global"]["codexMaxConcurrentThreads"]>().toEqualTypeOf<number>();
  });

  test("enables distinct completion sounds by default", () => {
    expect(defaultConfig().global.notificationSounds).toEqual({
      agentStopped: true,
      prMerged: true,
    });
  });

  test("uses the built-in shared review instruction until one is saved", () => {
    expect(defaultConfig().global.reviewInstruction).toBeUndefined();
    expectTypeOf<AppConfig["global"]["reviewInstruction"]>().toEqualTypeOf<string | undefined>();
  });

  test("keeps legacy agent systems enabled for an existing unconfigured installation", () => {
    expect(defaultConfig().global.enabledAgentPlatforms).toEqual(["claude", "codex", "opencode"]);
  });

  test("does not point defaults at any retired model id", () => {
    const platforms = defaultConfig().global.agentSettings?.platforms;
    const selected = [
      platforms?.opencode?.model,
      platforms?.claude?.model,
      platforms?.codex?.model,
    ];
    for (const retired of ["opencode/grok-code", "claude-sonnet-4-6", "gpt-5.3-codex"]) {
      expect(selected).not.toContain(retired);
    }
  });

  test("returns a fresh object each call (no shared mutable state)", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a).not.toBe(b);
    expect(a.global.allowedDomains).not.toBe(b.global.allowedDomains);
    a.global.allowedDomains.push("mutated.example.com");
    expect(b.global.allowedDomains).not.toContain("mutated.example.com");
  });

  test("defaultRepositoryConfig uses main as the default and PR base branch", () => {
    expect(defaultRepositoryConfig()).toEqual({
      defaultBranch: "main",
      prBaseBranch: "main",
    });
  });
});

describe("first-run agent platform selection", () => {
  test("hydrates the pre-backend sidecar and chooses an enabled default", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "agent-platforms.json"),
        `${JSON.stringify({ version: 1, enabled: ["cursor", "grok"] })}\n`,
        "utf8",
      );

      const loaded = await storage.loadConfig();
      expect(loaded.global.enabledAgentPlatforms).toEqual(["cursor", "grok"]);
      expect(loaded.global.agentSettings?.defaultAgent).toBe("cursor");
    });
  });

  test("rejects an empty platform update and corrects a disabled default", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(
        storage.updateGlobalConfig({
          ...defaultConfig().global,
          enabledAgentPlatforms: [],
        }),
      ).rejects.toThrow("Select at least one agent platform");

      const updated = await storage.updateGlobalConfig({
        ...defaultConfig().global,
        enabledAgentPlatforms: ["cursor", "grok"],
        agentSettings: { ...defaultConfig().global.agentSettings, defaultAgent: "claude" },
      });
      expect(updated.global.enabledAgentPlatforms).toEqual(["cursor", "grok"]);
      expect(updated.global.agentSettings?.defaultAgent).toBe("cursor");
    });
  });
});

describe("SSH agent socket configuration", () => {
  test("persists a trimmed absolute override and clears it in auto mode", async () => {
    await withTemporaryStorage(async (storage) => {
      const base = (await storage.loadConfig()).global;
      const configured = await storage.updateGlobalConfig({
        ...base,
        sshAgentSocketPath: "  /run/user/501/agent.sock  ",
      });
      expect(configured.global.sshAgentSocketPath).toBe("/run/user/501/agent.sock");

      const automatic = await storage.updateGlobalConfig({
        ...configured.global,
        sshAgentSocketPath: "  ",
      });
      expect(automatic.global.sshAgentSocketPath).toBeUndefined();
    });
  });

  test.each([
    ["relative", "relative/agent.sock", "SSH agent socket path must be an absolute path."],
    ["overlong", `/${"a".repeat(5_000)}`, "SSH agent socket path is too long."],
    ["NUL-containing", "/run/user/501/agent\0.sock", "must not contain NUL characters"],
  ])("rejects a %s override without changing the stored value", async (_label, value, message) => {
    await withTemporaryStorage(async (storage) => {
      const base = (await storage.loadConfig()).global;
      await storage.updateGlobalConfig({
        ...base,
        sshAgentSocketPath: "/run/user/501/agent.sock",
      });

      await expect(
        storage.updateGlobalConfig({
          ...base,
          sshAgentSocketPath: value,
        }),
      ).rejects.toThrow(message);
      expect((await storage.loadConfig()).global.sshAgentSocketPath).toBe(
        "/run/user/501/agent.sock",
      );
    });
  });

  test.each([
    ["relative/agent.sock"],
    [`/${"a".repeat(5_000)}`],
    ["/run/user/501/agent\0.sock"],
    [42],
  ])("drops a malformed persisted socket path", async (value) => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const config = defaultConfig();
      (config.global as unknown as Record<string, unknown>).sshAgentSocketPath = value;
      await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config)}\n`, "utf8");

      expect((await storage.loadConfig()).global.sshAgentSocketPath).toBeUndefined();
    });
  });
});

describe("Claude mode normalization", () => {
  /** A pre-agent-settings global block, i.e. what an existing install has on disk. */
  const legacyGlobal = (overrides: Record<string, unknown> = {}) => {
    const { agentSettings: _migrated, ...rest } = defaultConfig().global;
    return { ...rest, ...overrides };
  };

  test("a legacy config without a Claude mode resolves to native", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({ ...defaultConfig(), global: legacyGlobal() }),
        "utf8",
      );

      const loaded = await storage.loadConfig();
      // Absent now means "inherit", and the widest tier inherits the shipped
      // default rather than a value written into stored config.
      expect(loaded.global.agentSettings?.platforms?.claude?.mode).toBeUndefined();
      expect(
        resolveAgentPlatformSettings({ global: loaded.global.agentSettings }, "claude").mode,
      ).toBe("native");
    });
  });

  test("preserves an explicit terminal choice through the migration", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          ...defaultConfig(),
          global: legacyGlobal({ claudeMode: "terminal" }),
        }),
        "utf8",
      );

      const loaded = await storage.loadConfig();
      expect(loaded.global.agentSettings?.platforms?.claude?.mode).toBe("terminal");
      // The legacy key is gone, so nothing can read a stale value back.
      expect("claudeMode" in loaded.global).toBe(false);
    });
  });
});

describe("favorite model normalization", () => {
  // `config.json` is user-editable on disk, so every read is a trust boundary:
  // a malformed favourite must not reach the renderer's model picker, where an
  // unknown platform has no catalogue and a blank id matches every model.
  test("drops malformed, blank, and duplicate favorites on read", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          ...defaultConfig(),
          global: {
            ...defaultConfig().global,
            favoriteModels: [
              { platform: "claude", modelId: "claude-opus" },
              // Trimmed to the same identity as the entry above.
              { platform: "claude", modelId: "  claude-opus  " },
              { platform: "codex", modelId: "gpt-codex" },
              { platform: "not-an-agent", modelId: "anything" },
              { platform: "claude", modelId: "   " },
              { platform: "claude", modelId: 42 },
              { platform: "claude" },
              { modelId: "orphan" },
              "claude/opus",
              null,
            ],
          },
        }),
        "utf8",
      );

      const loaded = await storage.loadConfig();
      expect(loaded.global.favoriteModels).toEqual([
        { platform: "claude", modelId: "claude-opus" },
        { platform: "codex", modelId: "gpt-codex" },
      ]);
    });
  });

  test("replaces a non-array favorites field with an empty list", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          ...defaultConfig(),
          global: { ...defaultConfig().global, favoriteModels: "claude/opus" },
        }),
        "utf8",
      );

      expect((await storage.loadConfig()).global.favoriteModels).toEqual([]);
    });
  });

  test("round-trips valid favorites through an update without reordering them", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const favoriteModels = [
        { platform: "opencode" as const, modelId: "opencode/a" },
        { platform: "claude" as const, modelId: "claude-opus" },
      ];
      const updated = await storage.updateGlobalConfig({
        ...defaultConfig().global,
        favoriteModels,
      });
      expect(updated.global.favoriteModels).toEqual(favoriteModels);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.loadConfig()).global.favoriteModels).toEqual(favoriteModels);
    });
  });
});

describe("OpenCode model provider allowlist config", () => {
  /** Write a `config.json` that predates the allowlist field entirely. */
  async function writeLegacyConfig(
    dataDir: string,
    overrides: Record<string, unknown>,
    repositories: Record<string, unknown> = {},
  ): Promise<void> {
    const base = defaultConfig();
    // Strip `agentSettings` as well: a config that already carries the migrated
    // block is authoritative, so leaving it here would make the legacy keys
    // these tests set be ignored rather than migrated.
    const {
      openCodeModelProviders: _absent,
      agentSettings: _migrated,
      ...legacyGlobal
    } = base.global;
    await fs.writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({
        ...base,
        repositories,
        global: { ...legacyGlobal, ...overrides },
      }),
      "utf8",
    );
  }

  test("migrates an install that only ever used the managed catalogues", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, { opencodeModel: "opencode/claude-sonnet-5" });

      expect((await storage.loadConfig()).global.openCodeModelProviders).toEqual([
        "opencode",
        "opencode-go",
      ]);
    });
  });

  test("keeps the provider of a model the install already defaulted to", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      // This model was chosen from a picker that offered every provider. Losing
      // it would leave the launcher pointed at a model no picker will list.
      await writeLegacyConfig(dataDir, { opencodeModel: "openrouter/kimi-k2.5" });

      expect((await storage.loadConfig()).global.openCodeModelProviders).toEqual([
        "opencode",
        "opencode-go",
        "openrouter",
      ]);
    });
  });

  test("keeps providers named by favorites and repository defaults", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(
        dataDir,
        {
          opencodeModel: "opencode/claude-sonnet-5",
          favoriteModels: [
            { platform: "opencode", modelId: "hpc-ai/deepseek" },
            // Another agent's favourite names no OpenCode provider.
            { platform: "claude", modelId: "claude-opus" },
          ],
        },
        {
          "proj-1": { ...defaultRepositoryConfig(), defaultModel: "openrouter/kimi-k2.5" },
          "proj-2": { ...defaultRepositoryConfig(), defaultModel: "default" },
        },
      );

      const providers = (await storage.loadConfig()).global.openCodeModelProviders;
      expect(providers).toEqual(["opencode", "opencode-go", "hpc-ai", "openrouter"]);
    });
  });

  test("preserves an explicitly empty list as unrestricted", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, {
        opencodeModel: "openrouter/kimi-k2.5",
        openCodeModelProviders: [],
      });

      // An empty list is the user opting into every provider. Migration must
      // not read it as "absent" and re-narrow to the managed pair.
      expect((await storage.loadConfig()).global.openCodeModelProviders).toEqual([]);
    });
  });

  test("does not widen a list the user has already chosen", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, {
        opencodeModel: "openrouter/kimi-k2.5",
        openCodeModelProviders: ["opencode"],
      });

      expect((await storage.loadConfig()).global.openCodeModelProviders).toEqual(["opencode"]);
    });
  });

  // A default naming an excluded provider is unreachable, not merely unusual:
  // no picker lists it, so the user cannot replace it there, while environment
  // launches and build pipelines keep dispatching it.
  test("repoints a default model the allowlist no longer admits", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, {
        opencodeModel: "hpc-ai/deepseek/deepseek-v4-flash",
        openCodeModelProviders: ["opencode", "opencode-go"],
        favoriteModels: [
          { platform: "claude", modelId: "opus" },
          { platform: "opencode", modelId: "opencode-go/deepseek-v4-flash" },
          { platform: "opencode", modelId: "opencode-go/deepseek-v4-pro" },
        ],
      });

      // Their own favourite, not an invented model.
      expect((await storage.loadConfig()).global.agentSettings?.platforms?.opencode?.model).toBe(
        "opencode-go/deepseek-v4-flash",
      );
    });
  });

  // No model ships as the OpenCode default, so there is nothing fixed to
  // repoint to. Unset is the effective default: OpenCode's own default among
  // the connected, allowlisted providers.
  test("clears an unreachable default when no favorite is selectable", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, {
        opencodeModel: "hpc-ai/deepseek/deepseek-v4-flash",
        openCodeModelProviders: ["opencode", "opencode-go"],
        favoriteModels: [{ platform: "opencode", modelId: "openrouter/kimi-k2.5" }],
      });

      const opencode = (await storage.loadConfig()).global.agentSettings?.platforms?.opencode;
      expect(opencode).toBeDefined();
      expect(opencode).not.toHaveProperty("model");
    });
  });

  test("skips malformed favorites when repointing the default", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, {
        opencodeModel: "hpc-ai/deepseek/deepseek-v4-flash",
        openCodeModelProviders: ["opencode", "opencode-go"],
        favoriteModels: [
          { platform: "opencode", modelId: "opencode/" },
          { platform: "opencode", modelId: "opencode-go/deepseek-v4-flash" },
        ],
      });

      expect((await storage.loadConfig()).global.agentSettings?.platforms?.opencode?.model).toBe(
        "opencode-go/deepseek-v4-flash",
      );
    });
  });

  // `repository.defaultModel` is read before `global.opencodeModel` by both
  // `connectionDefaultsFor` and the startup-agent launch, so repointing only the
  // global default leaves the unreachable id in charge one level down.
  test("repoints a repository default the allowlist no longer admits", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(
        dataDir,
        {
          opencodeModel: "opencode/claude-sonnet-5",
          openCodeModelProviders: ["opencode", "opencode-go"],
          favoriteModels: [{ platform: "opencode", modelId: "opencode-go/deepseek-v4-flash" }],
        },
        {
          "repo-explicit": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultAgent: "opencode",
            defaultModel: "hpc-ai/deepseek-v4-flash",
          },
        },
      );

      const config = await storage.loadConfig();
      expect(config.repositories["repo-explicit"]?.agentSettings?.platforms?.opencode?.model).toBe(
        "opencode-go/deepseek-v4-flash",
      );
      // The rest of the repository record survives the rewrite.
      expect(config.repositories["repo-explicit"]?.defaultBranch).toBe("main");
    });
  });

  test("repoints a repository that inherits OpenCode as the global default agent", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(
        dataDir,
        {
          defaultAgent: "opencode",
          enabledAgentPlatforms: ["opencode"],
          opencodeModel: "opencode/claude-sonnet-5",
          openCodeModelProviders: ["opencode", "opencode-go"],
          favoriteModels: [],
        },
        {
          "repo-inherited": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultModel: "hpc-ai/deepseek-v4-flash",
          },
        },
      );

      // No selectable favourite, so the repository stops overriding and
      // inherits the global OpenCode default again.
      const config = await storage.loadConfig();
      expect(
        config.repositories["repo-inherited"]?.agentSettings?.platforms?.opencode,
      ).not.toHaveProperty("model");
      expect(config.global.agentSettings?.platforms?.opencode?.model).toBe(
        "opencode/claude-sonnet-5",
      );
    });
  });

  test("leaves repository defaults belonging to another agent untouched", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(
        dataDir,
        {
          opencodeModel: "opencode/claude-sonnet-5",
          openCodeModelProviders: ["opencode", "opencode-go"],
          favoriteModels: [{ platform: "opencode", modelId: "opencode-go/deepseek-v4-flash" }],
        },
        {
          // A Claude repository's model migrates into the Claude column, so
          // the OpenCode repointing never sees it. Before the migration this
          // was one field shared by every agent, and the repointing had to
          // infer the effective agent to avoid mangling a Claude id.
          "repo-claude": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultAgent: "claude",
            defaultModel: "vendor/claude-sonnet-5",
          },
          // The "use the agent default" sentinel is not a model id either.
          "repo-sentinel": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultAgent: "opencode",
            defaultModel: "default",
          },
        },
      );

      const config = await storage.loadConfig();
      const claudeRepo = config.repositories["repo-claude"]?.agentSettings?.platforms;
      expect(claudeRepo?.claude?.model).toBe("vendor/claude-sonnet-5");
      expect(claudeRepo?.opencode?.model).toBeUndefined();
      // `"default"` was the repository's "no override" sentinel, so it is
      // dropped rather than stored as a model no provider knows.
      expect(
        config.repositories["repo-sentinel"]?.agentSettings?.platforms?.opencode?.model,
      ).toBeUndefined();
    });
  });

  test("clears an unreachable default when nothing selectable is on hand", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, {
        opencodeModel: "hpc-ai/deepseek/deepseek-v4-flash",
        openCodeModelProviders: ["opencode-go"],
        favoriteModels: [],
      });

      // Unset rather than unreachable: no picker could have listed it, and the
      // effective default is a model this login can actually serve.
      expect(
        (await storage.loadConfig()).global.agentSettings?.platforms?.opencode,
      ).not.toHaveProperty("model");
    });
  });

  test("leaves the default alone when the allowlist admits it", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await writeLegacyConfig(dataDir, {
        opencodeModel: "hpc-ai/deepseek/deepseek-v4-flash",
        // Unrestricted admits everything, so nothing is ever repointed.
        openCodeModelProviders: [],
        favoriteModels: [{ platform: "opencode", modelId: "opencode-go/deepseek-v4-flash" }],
      });

      expect((await storage.loadConfig()).global.agentSettings?.platforms?.opencode?.model).toBe(
        "hpc-ai/deepseek/deepseek-v4-flash",
      );
    });
  });

  test("normalizes a stored list on read and survives a restart", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      // Normalization is a read boundary, as it is for `favoriteModels`: a
      // write is stored verbatim and every reader is handed the canonical form,
      // so a stray capital cannot silently select nothing.
      await storage.updateGlobalConfig({
        ...defaultConfig().global,
        openCodeModelProviders: ["  OpenCode ", "opencode", "OPENROUTER"],
      });
      expect((await storage.loadConfig()).global.openCodeModelProviders).toEqual([
        "opencode",
        "openrouter",
      ]);

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.loadConfig()).global.openCodeModelProviders).toEqual([
        "opencode",
        "openrouter",
      ]);
    });
  });
});

describe("SDK and ACP bridge runtime persistence", () => {
  test("round-trips and clears Cursor, Grok, and Pi process coordinates", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-acp-runtime";
      await storage.addEnvironment(environment);

      await storage.updateEnvironment(environment.id, {
        cursorBridgePid: 4101,
        grokBridgePid: 4102,
        piBridgePid: 4103,
        localCursorPort: 57101,
        localGrokPort: 57102,
        localPiPort: 57103,
      });

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect(await restarted.getEnvironment(environment.id)).toMatchObject({
        cursorBridgePid: 4101,
        grokBridgePid: 4102,
        piBridgePid: 4103,
        localCursorPort: 57101,
        localGrokPort: 57102,
        localPiPort: 57103,
      });

      await restarted.updateEnvironment(environment.id, {
        cursorBridgePid: null,
        grokBridgePid: null,
        piBridgePid: null,
        localCursorPort: null,
        localGrokPort: null,
        localPiPort: null,
      });
      // Asserted per field rather than through one `not.toMatchObject`: that
      // matcher fails only when *every* listed key matches, so a single field
      // that cleared would have vouched for the five that did not.
      const cleared = await restarted.getEnvironment(environment.id);
      expect(cleared?.cursorBridgePid).toBeUndefined();
      expect(cleared?.grokBridgePid).toBeUndefined();
      expect(cleared?.piBridgePid).toBeUndefined();
      expect(cleared?.localCursorPort).toBeUndefined();
      expect(cleared?.localGrokPort).toBeUndefined();
      expect(cleared?.localPiPort).toBeUndefined();

      // The clearing write must also survive a restart, not just the cache the
      // instance that performed it is serving from.
      const reopened = new StorageService(dataDir);
      await reopened.init();
      const persisted = await reopened.getEnvironment(environment.id);
      expect(persisted?.piBridgePid).toBeUndefined();
      expect(persisted?.localPiPort).toBeUndefined();
    });
  });
});

describe("GitHub credential source config migration", () => {
  test.each([
    ["missing source without a PAT", undefined, undefined, true],
    ["missing source with an empty PAT", undefined, "   ", true],
    ["missing source with a legacy PAT", undefined, "legacy-pat", false],
    ["explicit host source with a legacy PAT", true, "legacy-pat", true],
    ["explicit PAT source without a PAT", false, undefined, false],
  ] as const)("%s", async (_label, source, githubToken, expected) => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const config = defaultConfig();
      if (source === undefined) {
        delete config.global.useHostGitHubCredentials;
      } else {
        config.global.useHostGitHubCredentials = source;
      }
      if (githubToken === undefined) {
        delete config.global.githubToken;
      } else {
        config.global.githubToken = githubToken;
      }
      await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config)}\n`, "utf8");

      const loaded = await storage.loadConfig();
      expect(loaded.global.useHostGitHubCredentials).toBe(expected);
      expect(loaded.global.githubToken).toBe(githubToken);
    });
  });
});

describe("Claude background command limit config storage", () => {
  const limitError = "claudeBackgroundCommandLimitHours must be an integer between 2 and 168.";

  test("is absent by default, leaving the Claude CLI's own ceiling", () => {
    expect(defaultConfig().global.claudeBackgroundCommandLimitHours).toBeUndefined();
  });

  test.each([
    ["below the CLI ceiling", 1],
    ["above one week", 169],
    ["fraction", 2.5],
    ["numeric string", "8"],
    ["null", null],
  ])("drops a persisted %s value", async (_label, value) => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const persisted = structuredClone(defaultConfig()) as unknown as Record<string, unknown>;
      (persisted.global as Record<string, unknown>).claudeBackgroundCommandLimitHours = value;
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        `${JSON.stringify(persisted)}\n`,
        "utf8",
      );

      expect((await storage.loadConfig()).global.claudeBackgroundCommandLimitHours).toBeUndefined();
    });
  });

  test("saves and reloads valid boundary values", async () => {
    await withTemporaryStorage(async (storage) => {
      for (const value of [2, 168]) {
        const config = defaultConfig();
        await storage.saveConfig(config);
        await storage.updateGlobalConfig({
          ...config.global,
          claudeBackgroundCommandLimitHours: value,
        });
        expect((await storage.loadConfig()).global.claudeBackgroundCommandLimitHours).toBe(value);
      }
    });
  });

  test("rejects invalid values without changing stored state", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = defaultConfig();
      config.global.claudeBackgroundCommandLimitHours = 12;
      await storage.saveConfig(config);

      await expect(
        storage.updateGlobalConfig({ ...config.global, claudeBackgroundCommandLimitHours: 1 }),
      ).rejects.toThrow(limitError);
      const invalidFull = structuredClone(config);
      (invalidFull.global as unknown as Record<string, unknown>).claudeBackgroundCommandLimitHours =
        "24";
      await expect(storage.saveConfig(invalidFull)).rejects.toThrow(limitError);
      expect((await storage.loadConfig()).global.claudeBackgroundCommandLimitHours).toBe(12);
    });
  });
});

describe("Codex max concurrent thread config storage", () => {
  test.each([
    ["missing", undefined],
    ["numeric string", "8"],
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["null", null],
    ["root-slot overflow", Number.MAX_SAFE_INTEGER],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("normalizes the persisted %s value to the default", async (_label, value) => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const config = defaultConfig();
      const persisted = structuredClone(config) as unknown as Record<string, unknown>;
      const global = persisted.global as Record<string, unknown>;
      if (value === undefined) {
        delete global.codexMaxConcurrentThreads;
      } else {
        global.codexMaxConcurrentThreads = value;
      }
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        `${JSON.stringify(persisted)}\n`,
        "utf8",
      );

      expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(5);
    });
  });

  test("preserves valid persisted boundary values", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      for (const value of [1, MAX_CODEX_CONCURRENT_THREADS]) {
        const config = defaultConfig();
        config.global.codexMaxConcurrentThreads = value;
        await fs.writeFile(
          path.join(dataDir, "config.json"),
          `${JSON.stringify(config)}\n`,
          "utf8",
        );
        expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(value);
      }
    });
  });

  test("rejects invalid values when saving the full config", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = defaultConfig();
      (config.global as unknown as Record<string, unknown>).codexMaxConcurrentThreads = "8";

      await expect(storage.saveConfig(config)).rejects.toThrow(
        `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
      );
    });
  });

  test("rejects missing values when saving the full config", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = defaultConfig();
      delete (config.global as unknown as Record<string, unknown>).codexMaxConcurrentThreads;

      await expect(storage.saveConfig(config)).rejects.toThrow(
        `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
      );
    });
  });

  test("saves valid full configs at both boundaries", async () => {
    await withTemporaryStorage(async (storage) => {
      for (const value of [1, MAX_CODEX_CONCURRENT_THREADS]) {
        const config = defaultConfig();
        config.global.codexMaxConcurrentThreads = value;
        await storage.saveConfig(config);
        expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(value);
      }
    });
  });

  test("rejects invalid global updates without changing stored state", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = defaultConfig();
      config.global.codexMaxConcurrentThreads = 7;
      await storage.saveConfig(config);

      const invalidGlobal = {
        ...config.global,
        codexMaxConcurrentThreads: Number.POSITIVE_INFINITY,
      };
      await expect(storage.updateGlobalConfig(invalidGlobal)).rejects.toThrow(
        `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
      );
      expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(7);
    });
  });

  test("saves valid global updates at both boundaries", async () => {
    await withTemporaryStorage(async (storage) => {
      for (const value of [1, MAX_CODEX_CONCURRENT_THREADS]) {
        const updated = await storage.updateGlobalConfig({
          ...defaultConfig().global,
          codexMaxConcurrentThreads: value,
        });
        expect(updated.global.codexMaxConcurrentThreads).toBe(value);
        expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(value);
      }
    });
  });
});

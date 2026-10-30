import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { REVIEW_INSTRUCTION_MAX_LENGTH } from "../../../packages/protocol/src/review-prompt";
import { DEFAULT_DEBUG_LOG_RETENTION_DAYS } from "../../../packages/protocol/src/debug-logging";
import { defaultConfig, StorageService } from "../src/core/storage";
import { createTempDir, removeTempDirs } from "./storage-test-helpers";

afterEach(removeTempDirs);

describe("Electron StorageService", () => {
  test("round-trips validated desktop connections and recovers malformed persisted data", async () => {
    const dataDir = await createTempDir("ork-storage-connections-");
    const storage = new StorageService(dataDir);
    await storage.init();
    await expect(storage.getDesktopConnections()).resolves.toEqual({
      activeConnectionId: "local",
      connections: [],
    });

    const connections = {
      activeConnectionId: "remote-1",
      connections: [
        {
          id: "remote-1",
          name: "desk.example",
          address: "https://desk.example",
          encryptedToken: "encrypted-token",
          lastConnectedAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    };
    await storage.saveDesktopConnections(connections);
    await expect(storage.getDesktopConnections()).resolves.toEqual(connections);
    await expect(
      storage.saveDesktopConnections({ activeConnectionId: "local", connections: null } as never),
    ).rejects.toThrow("connections");

    const malformed = defaultConfig();
    malformed.desktopConnections = { activeConnectionId: "remote-1" } as never;
    await storage.saveConfig(malformed);
    const originalWarn = console.warn;
    console.warn = mock(() => undefined) as typeof console.warn;
    try {
      await expect(storage.getDesktopConnections()).resolves.toEqual({
        activeConnectionId: "local",
        connections: [],
      });
    } finally {
      console.warn = originalWarn;
    }
  });

  test("preserves concurrent desktop, repository, and global configuration mutations", async () => {
    const dataDir = await createTempDir("ork-storage-config-lock-");
    const first = new StorageService(dataDir);
    const second = new StorageService(dataDir);
    await Promise.all([first.init(), second.init()]);
    await first.saveConfig(defaultConfig());

    const global = {
      ...defaultConfig().global,
      // Carries the same Claude model the concurrent per-platform write sets,
      // so this asserts the mutations are all preserved rather than which of
      // the two racing writers happened to land last.
      agentSettings: {
        ...defaultConfig().global.agentSettings,
        defaultAgent: "codex" as const,
        platforms: {
          ...defaultConfig().global.agentSettings?.platforms,
          claude: {
            ...defaultConfig().global.agentSettings?.platforms?.claude,
            model: "claude-opus-4",
          },
        },
      },
    };
    const desktopConnections = {
      activeConnectionId: "remote-1",
      connections: [
        {
          id: "remote-1",
          name: "desk.example",
          address: "https://desk.example",
          encryptedToken: "encrypted-token",
          lastConnectedAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    };
    await Promise.all([
      first.saveDesktopConnections(desktopConnections),
      second.updateGlobalConfig(global),
      first.updateRepositoryConfig("project-1", {
        defaultBranch: "develop",
        prBaseBranch: "develop",
      }),
    ]);

    const config = await second.loadConfig();
    expect(config.desktopConnections).toEqual(desktopConnections);
    expect(config.global.agentSettings?.defaultAgent).toBe("codex");
    // The concurrent per-platform write survives the whole-config write beside it.
    expect(config.global.agentSettings?.platforms?.claude?.model).toBe("claude-opus-4");
    expect(config.repositories["project-1"]).toMatchObject({
      defaultBranch: "develop",
      prBaseBranch: "develop",
    });
  });

  test("keeps managed ACP vendor endpoints out of the default allowlist", () => {
    // The allowlist is the isolation boundary the user sees and edits. Cursor
    // and Grok endpoints are unioned in at container creation for the
    // platforms that are actually enabled, so seeding them here would open
    // them for installs that never use either agent.
    const config = defaultConfig();
    const domains = config.global.allowedDomains;

    expect(config.global.enabledAgentPlatforms).toEqual(["claude", "codex", "opencode"]);
    for (const vendorHost of [
      "auth.x.ai",
      "api.x.ai",
      "cli-chat-proxy.grok.com",
      "api2.cursor.sh",
      "authenticator.cursor.sh",
      "marketplace.cursorapi.com",
    ]) {
      expect(domains).not.toContain(vendorHost);
    }
    // The endpoints the shipped agents genuinely need are still present.
    expect(domains).toContain("api.anthropic.com");
    expect(domains).toContain("registry.npmjs.org");
  });

  test("preserves write-only credentials during renderer config writes and mutates API keys explicitly", async () => {
    const dataDir = await createTempDir("ork-storage-write-only-credentials-");
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.setGitHubToken("stored-github-token");
    await storage.setAnthropicApiKey("stored-anthropic-key");
    await storage.setCursorApiKey("stored-cursor-key");

    const rendererGlobal = {
      ...(await storage.loadConfig()).global,
      debugLogging: true,
    };
    delete rendererGlobal.githubToken;
    delete rendererGlobal.anthropicApiKey;
    delete rendererGlobal.cursorApiKey;
    await storage.updateGlobalConfig(rendererGlobal, { preserveCredentials: true });

    let persisted = (await storage.loadConfig()).global;
    expect(persisted.githubToken).toBe("stored-github-token");
    expect(persisted.anthropicApiKey).toBe("stored-anthropic-key");
    expect(persisted.cursorApiKey).toBe("stored-cursor-key");
    expect(persisted.debugLogging).toBe(true);

    await storage.setCursorApiKey("replacement-cursor-key");
    expect((await storage.loadConfig()).global.cursorApiKey).toBe("replacement-cursor-key");
    await storage.setCursorApiKey(null);
    await storage.setAnthropicApiKey("replacement-anthropic-key");
    expect((await storage.loadConfig()).global.anthropicApiKey).toBe("replacement-anthropic-key");
    await storage.setAnthropicApiKey(null);
    persisted = (await storage.loadConfig()).global;
    expect(persisted.cursorApiKey).toBeUndefined();
    expect(persisted.anthropicApiKey).toBeUndefined();
    expect(persisted.githubToken).toBe("stored-github-token");
  });

  test("coerces an out-of-range debug log retention from any client", async () => {
    // The renderer disables Save on an invalid value, but a browser client or a
    // hand-edited config.json reaches this same path, so the clamp has to live
    // here rather than in the form.
    const dataDir = await createTempDir("ork-storage-log-retention-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const base = (await storage.loadConfig()).global;

    for (const invalid of [0, -5, 3651, 1.5, Number.NaN, "30", null, undefined]) {
      await storage.updateGlobalConfig({
        ...base,
        debugLogRetentionDays: invalid as never,
      });
      expect((await storage.loadConfig()).global.debugLogRetentionDays).toBe(
        DEFAULT_DEBUG_LOG_RETENTION_DAYS,
      );
    }

    await storage.updateGlobalConfig({ ...base, debugLogRetentionDays: 30 });
    expect((await storage.loadConfig()).global.debugLogRetentionDays).toBe(30);
  });

  test("normalizes a persisted debug log retention written outside the app", async () => {
    const dataDir = await createTempDir("ork-storage-log-retention-persisted-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const config = await storage.loadConfig();
    await storage.saveConfig({
      ...config,
      global: { ...config.global, debugLogRetentionDays: 99999 as never },
    });

    const reloaded = new StorageService(dataDir);
    await reloaded.init();
    expect((await reloaded.loadConfig()).global.debugLogRetentionDays).toBe(
      DEFAULT_DEBUG_LOG_RETENTION_DAYS,
    );
  });

  test("preserves write-only credentials through a whole-config renderer write", async () => {
    // `save_config` hands the entire config back, and the renderer holds neither
    // secret. Only the merge inside saveConfig keeps them, so exercise the real
    // implementation: the command-layer coverage for this path runs against a
    // hand-written mock storage and cannot catch a divergence here.
    const dataDir = await createTempDir("ork-storage-save-config-credentials-");
    const storage = new StorageService(dataDir);
    await storage.init();
    await storage.saveConfig(defaultConfig());
    await storage.setGitHubToken("stored-github-token");
    await storage.setAnthropicApiKey("stored-anthropic-key");
    await storage.setCursorApiKey("stored-cursor-key");

    const loaded = await storage.loadConfig();
    const {
      githubToken: _token,
      anthropicApiKey: _anthropicApiKey,
      cursorApiKey: _apiKey,
      ...rendererGlobal
    } = loaded.global;
    await storage.saveConfig(
      { ...loaded, global: { ...rendererGlobal, debugLogging: true } },
      { preserveCredentials: true },
    );

    const persisted = (await storage.loadConfig()).global;
    expect(persisted.githubToken).toBe("stored-github-token");
    expect(persisted.anthropicApiKey).toBe("stored-anthropic-key");
    expect(persisted.cursorApiKey).toBe("stored-cursor-key");
    expect(persisted.debugLogging).toBe(true);

    // Without the option a whole-config write stays authoritative, so a backend
    // caller that genuinely means to drop both still can.
    const authoritative = await storage.loadConfig();
    const {
      githubToken: _dropped,
      anthropicApiKey: _alsoDroppedAnthropic,
      cursorApiKey: _alsoDropped,
      ...withoutCredentials
    } = authoritative.global;
    await storage.saveConfig({ ...authoritative, global: withoutCredentials });

    const cleared = (await storage.loadConfig()).global;
    expect(cleared.githubToken).toBeUndefined();
    expect(cleared.anthropicApiKey).toBeUndefined();
    expect(cleared.cursorApiKey).toBeUndefined();
  });

  test("default config uses the shared dark terminal background", () => {
    expect(defaultConfig().global.terminalAppearance.backgroundColor).toBe("#0e1014");
  });

  test("round-trips and removes a custom review instruction from global config", async () => {
    const dataDir = await createTempDir("ork-storage-review-prompt-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const withPrompt = defaultConfig().global;
    withPrompt.reviewInstruction = "Review origin/{{targetBranch}}...HEAD.";
    await storage.updateGlobalConfig(withPrompt);
    expect((await storage.loadConfig()).global.reviewInstruction).toBe(
      "Review origin/{{targetBranch}}...HEAD.",
    );

    const withoutPrompt = { ...withPrompt };
    delete withoutPrompt.reviewInstruction;
    await storage.updateGlobalConfig(withoutPrompt);

    expect((await storage.loadConfig()).global.reviewInstruction).toBeUndefined();
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8")) as {
      global: Record<string, unknown>;
    };
    expect(Object.hasOwn(persisted.global, "reviewInstruction")).toBe(false);
  });

  test("drops malformed persisted review instructions without discarding other config", async () => {
    const dataDir = await createTempDir("ork-storage-malformed-review-prompt-");
    const storage = new StorageService(dataDir);
    await storage.init();

    for (const reviewInstruction of [
      null,
      123,
      { prompt: "Review" },
      "   ",
      "x".repeat(REVIEW_INSTRUCTION_MAX_LENGTH + 1),
    ]) {
      const config = defaultConfig() as unknown as {
        global: { agentSettings?: object; [key: string]: unknown };
        repositories: Record<string, unknown>;
      };
      config.global.agentSettings = { ...config.global.agentSettings, defaultAgent: "codex" };
      config.global.reviewInstruction = reviewInstruction;
      await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config)}\n`);

      const loaded = await storage.loadConfig();
      expect(loaded.global.agentSettings?.defaultAgent).toBe("codex");
      expect(loaded.global.reviewInstruction).toBeUndefined();
    }
  });

  test("migrates a valid legacy review prompt without losing its content", async () => {
    const dataDir = await createTempDir("ork-storage-review-instruction-migration-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const legacyPrompt = [
      "Keep all of this legacy review content.",
      "Review origin/{{targetBranch}}...HEAD.",
      "Use an organization-specific checklist.",
    ].join("\n");
    const config = defaultConfig() as unknown as {
      global: Record<string, unknown>;
      repositories: Record<string, unknown>;
    };
    config.global.reviewPrompt = legacyPrompt;
    await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config)}\n`);

    const loaded = await storage.loadConfig();
    expect(loaded.global.reviewInstruction).toBe(legacyPrompt);
    expect(Object.hasOwn(loaded.global, "reviewPrompt")).toBe(false);

    await storage.saveConfig(loaded);
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8")) as {
      global: Record<string, unknown>;
    };
    expect(persisted.global.reviewInstruction).toBe(legacyPrompt);
    expect(Object.hasOwn(persisted.global, "reviewPrompt")).toBe(false);
  });

  test("defaults legacy configs without a PAT to host GitHub CLI credentials", async () => {
    const dataDir = await createTempDir("ork-storage-github-auth-default-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const config = defaultConfig();
    delete config.global.useHostGitHubCredentials;
    await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config)}\n`);

    expect((await storage.loadConfig()).global.useHostGitHubCredentials).toBe(true);
  });

  test("preserves the PAT source for legacy configs with a stored token", async () => {
    const dataDir = await createTempDir("ork-storage-github-auth-pat-migration-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const config = defaultConfig();
    config.global.githubToken = "legacy-pat";
    delete config.global.useHostGitHubCredentials;
    await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config)}\n`);

    const loaded = await storage.loadConfig();
    expect(loaded.global.useHostGitHubCredentials).toBe(false);
    expect(loaded.global.githubToken).toBe("legacy-pat");
  });

  test("preserves an explicit PAT source even when no PAT is stored", async () => {
    const dataDir = await createTempDir("ork-storage-github-auth-explicit-pat-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const config = defaultConfig();
    config.global.useHostGitHubCredentials = false;
    await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(config)}\n`);

    expect((await storage.loadConfig()).global.useHostGitHubCredentials).toBe(false);
  });

  test("validates review instructions at save and global-update boundaries", async () => {
    const dataDir = await createTempDir("ork-storage-review-validation-");
    const storage = new StorageService(dataDir);
    await storage.init();

    for (const reviewInstruction of [
      null,
      42,
      {},
      " ",
      "x".repeat(REVIEW_INSTRUCTION_MAX_LENGTH + 1),
    ]) {
      await expect(
        storage.updateGlobalConfig({
          ...defaultConfig().global,
          reviewInstruction,
        } as never),
      ).rejects.toThrow("Review instruction");
    }

    const malformed = defaultConfig();
    malformed.global.reviewInstruction = 42 as never;
    await expect(storage.saveConfig(malformed)).rejects.toThrow(
      "Review instruction must be a string",
    );

    await storage.updateGlobalConfig({
      ...defaultConfig().global,
      reviewInstruction: "x".repeat(REVIEW_INSTRUCTION_MAX_LENGTH),
    });
    expect((await storage.loadConfig()).global.reviewInstruction).toHaveLength(
      REVIEW_INSTRUCTION_MAX_LENGTH,
    );
  });

  test("normalizes action defaults at the global-update boundary", async () => {
    const dataDir = await createTempDir("ork-storage-action-defaults-");
    const storage = new StorageService(dataDir);
    await storage.init();

    // This is the trust boundary between any client and persisted config: a
    // malformed entry accepted here is later applied to a launch the user
    // cannot see being configured.
    await storage.updateGlobalConfig({
      ...defaultConfig().global,
      agentSettings: {
        actionDefaults: {
          review: { platform: "codex", model: "  gpt-5.4  ", reasoningEffort: " high " },
          pr: { model: "sonnet" },
          resolve: { platform: "not-an-agent", model: "sonnet" },
          push: { platform: "opencode", model: "default" },
          deploy: { platform: "claude" },
        },
      },
    } as never);

    expect((await storage.loadConfig()).global.agentSettings?.actionDefaults).toEqual({
      review: { platform: "codex", model: "gpt-5.4", reasoningEffort: "high" },
      // A model without a platform, an unknown platform, and an unknown action
      // key are all dropped; OpenCode's `default` is a UI placeholder no
      // OpenCode server knows, so only its platform survives.
      push: { platform: "opencode" },
    });

    // `update_global_config` replaces the stored global wholesale, so a client
    // that omits the field clears it rather than leaving it untouched. Every
    // save path in the renderer has to resend it for this reason.
    await storage.updateGlobalConfig({ ...defaultConfig().global } as never);
    expect((await storage.loadConfig()).global.agentSettings?.actionDefaults).toBeUndefined();
  });

  test("round-trips max and ultra Codex reasoning preferences", async () => {
    const dataDir = await createTempDir("ork-storage-codex-effort-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const config = defaultConfig();
    config.global.agentSettings = {
      ...config.global.agentSettings,
      platforms: {
        ...config.global.agentSettings?.platforms,
        codex: {
          ...config.global.agentSettings?.platforms?.codex,
          model: "gpt-5.6-sol",
          reasoningEffort: "ultra",
        },
      },
    };
    config.global.codexMaxConcurrentThreads = 8;
    await storage.saveConfig(config);
    const loaded = await storage.loadConfig();
    expect(loaded.global.agentSettings?.platforms?.codex).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    expect(loaded.global.codexMaxConcurrentThreads).toBe(8);

    // Legacy flat Codex keys are no longer part of the global config type.
    await storage.updateGlobalConfig({
      ...config.global,
      codexModel: "gpt-5.6-luna",
      codexReasoningEffort: "max",
      codexMaxConcurrentThreads: 6,
    } as typeof config.global);
    await expect(storage.loadConfig()).resolves.toMatchObject({
      global: {
        codexModel: "gpt-5.6-luna",
        codexReasoningEffort: "max",
        codexMaxConcurrentThreads: 6,
      },
    });
  });
});

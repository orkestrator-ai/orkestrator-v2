import { describe, expect, expectTypeOf, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEnvironment,
  defaultConfig,
  defaultRepositoryConfig,
  StorageService,
} from "./storage.js";
import type {
  AppConfig,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
} from "./models.js";
import { MAX_CODEX_CONCURRENT_THREADS } from "./constants.js";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { PaneLayoutMergeInput } from "@orkestrator/protocol/pane-layout-merge";
import type { AgentModel } from "@orkestrator/protocol/native-agent";

async function withTemporaryStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-backend-storage-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

// The default model ids here are the backend source of truth used whenever a
// user has no persisted config. They must stay in sync with the renderer
// defaults (see apps/web/src/stores/configStore.test.ts) and the offered model catalogs.
describe("defaultConfig", () => {
  test("returns the current default model selection", () => {
    const { global } = defaultConfig();
    expect(global.opencodeModel).toBe("opencode/claude-sonnet-5");
    expect(global.claudeModel).toBe("claude-sonnet-5");
    expect(global.codexModel).toBe("gpt-5.4");
    expect(global.codexReasoningEffort).toBe("high");
  });

  test("keeps the existing web client behavior enabled by default", () => {
    expect(defaultConfig().global.webClientEnabled).toBe(true);
  });

  test("uses native Claude sessions by default", () => {
    expect(defaultConfig().global.claudeMode).toBe("native");
  });

  test("uses host GitHub CLI credentials by default", () => {
    expect(defaultConfig().global.useHostGitHubCredentials).toBe(true);
    expectTypeOf<AppConfig["global"]["useHostGitHubCredentials"]>()
      .toEqualTypeOf<boolean | undefined>();
  });

  test("allows five concurrent Codex subagent threads by default", () => {
    expect(defaultConfig().global.codexMaxConcurrentThreads).toBe(5);
    expectTypeOf<AppConfig["global"]["codexMaxConcurrentThreads"]>().toEqualTypeOf<number>();
  });

  test("uses the built-in shared review instruction until one is saved", () => {
    expect(defaultConfig().global.reviewInstruction).toBeUndefined();
    expectTypeOf<AppConfig["global"]["reviewInstruction"]>().toEqualTypeOf<string | undefined>();
  });

  test("keeps legacy agent systems enabled for an existing unconfigured installation", () => {
    expect(defaultConfig().global.enabledAgentPlatforms).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
  });

  test("does not point defaults at any retired model id", () => {
    const { global } = defaultConfig();
    const selected = [global.opencodeModel, global.claudeModel, global.codexModel];
    for (const retired of [
      "opencode/grok-code",
      "claude-sonnet-4-6",
      "gpt-5.3-codex",
    ]) {
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
      expect(loaded.global.defaultAgent).toBe("cursor");
    });
  });

  test("rejects an empty platform update and corrects a disabled default", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(storage.updateGlobalConfig({
        ...defaultConfig().global,
        enabledAgentPlatforms: [],
      })).rejects.toThrow("Select at least one agent platform");

      const updated = await storage.updateGlobalConfig({
        ...defaultConfig().global,
        enabledAgentPlatforms: ["cursor", "grok"],
        defaultAgent: "claude",
      });
      expect(updated.global.enabledAgentPlatforms).toEqual(["cursor", "grok"]);
      expect(updated.global.defaultAgent).toBe("cursor");
    });
  });
});

describe("Claude mode normalization", () => {
  test("upgrades a legacy config without a Claude mode to native", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const { claudeMode: _absent, ...legacyGlobal } = defaultConfig().global;
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          ...defaultConfig(),
          global: legacyGlobal,
        }),
        "utf8",
      );

      expect((await storage.loadConfig()).global.claudeMode).toBe("native");
    });
  });

  test("preserves an explicit terminal choice", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          ...defaultConfig(),
          global: {
            ...defaultConfig().global,
            claudeMode: "terminal",
          },
        }),
        "utf8",
      );

      expect((await storage.loadConfig()).global.claudeMode).toBe("terminal");
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
    const { openCodeModelProviders: _absent, ...legacyGlobal } = base.global;
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
      expect(providers).toEqual([
        "opencode",
        "opencode-go",
        "hpc-ai",
        "openrouter",
      ]);
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

      expect((await storage.loadConfig()).global.openCodeModelProviders).toEqual([
        "opencode",
      ]);
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

describe("ACP bridge runtime persistence", () => {
  test("round-trips and clears Cursor and Grok process coordinates", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-acp-runtime";
      await storage.addEnvironment(environment);

      await storage.updateEnvironment(environment.id, {
        cursorBridgePid: 4101,
        grokBridgePid: 4102,
        localCursorPort: 57101,
        localGrokPort: 57102,
      });

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect(await restarted.getEnvironment(environment.id)).toMatchObject({
        cursorBridgePid: 4101,
        grokBridgePid: 4102,
        localCursorPort: 57101,
        localGrokPort: 57102,
      });

      await restarted.updateEnvironment(environment.id, {
        cursorBridgePid: null,
        grokBridgePid: null,
        localCursorPort: null,
        localGrokPort: null,
      });
      expect(await restarted.getEnvironment(environment.id)).not.toMatchObject({
        cursorBridgePid: expect.any(Number),
        grokBridgePid: expect.any(Number),
        localCursorPort: expect.any(Number),
        localGrokPort: expect.any(Number),
      });
    });
  });
});

describe("backend-owned setup and build surfaces", () => {
  test("normalizes pre-setupPhase environment records on every read", async () => {
    await withTemporaryStorage(async (_storage, dataDir) => {
      const completed = createEnvironment("project-1");
      completed.id = "ready-legacy";
      completed.setupScriptsComplete = true;
      const incomplete = createEnvironment("project-1");
      incomplete.id = "pending-legacy";
      const legacy = [completed, incomplete].map((environment) => {
        const record = { ...environment };
        delete record.setupPhase;
        delete record.setupOverride;
        return record;
      });
      await fs.writeFile(
        path.join(dataDir, "environments.json"),
        `${JSON.stringify(legacy)}\n`,
      );

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.getEnvironment("ready-legacy"))?.setupPhase).toBe("ready");
      expect((await restarted.getEnvironment("pending-legacy"))?.setupPhase).toBe("pending");
    });
  });

  test("creates and refreshes the build tab in the authoritative pane layout", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-build-tab";
      environment.containerId = "container-1";
      await storage.addEnvironment(environment);

      const first = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: false,
      });
      expect(first.root).toMatchObject({
        kind: "leaf",
        activeTabId: "build-pipeline-1",
        tabs: [{
          type: "claude-build",
          buildTabData: { pipelineId: "pipeline-1", taskId: "task-1" },
        }],
      });

      const second = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-2",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: false,
      });
      expect(second.version).toBe(PANE_LAYOUT_VERSION);
      expect(second.revision).toBe(first.revision + 1);
      const root = second.root as {
        kind?: unknown;
        tabs?: Array<Record<string, unknown>>;
      };
      if (root.kind !== "leaf" || !Array.isArray(root.tabs)) {
        throw new Error("expected a leaf layout");
      }
      expect(root.tabs).toHaveLength(1);
      expect(root.tabs[0]).toMatchObject({
        id: "build-pipeline-1",
        buildTabData: { pipelineId: "pipeline-2", taskId: "task-1" },
      });
    });
  });

  test("publishes a backend-owned native startup tab beside the setup terminal", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-cursor-startup";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      const layout = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
      });

      expect(layout?.root).toMatchObject({
        kind: "leaf",
        activeTabId: "startup-agent",
        tabs: [
          { id: "default", type: "plain", isSetupTab: true },
          {
            id: "startup-agent",
            type: "agent-native",
            nativeAgentData: {
              platform: "cursor",
              environmentId: environment.id,
              sessionId: "cursor-session-1",
              isLocal: true,
            },
          },
        ],
      });
    });
  });

  test("repairs a malformed Cursor startup tab in place without resurrecting a closed tab", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-cursor-repair";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(environment.id, {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            { id: "startup-agent", type: "cursor" },
          ],
          activeTabId: "startup-agent",
        },
      }, 0);

      const repaired = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
        existingOnly: true,
      });
      expect(repaired?.revision).toBe(2);
      expect(repaired?.root).toMatchObject({
        tabs: [
          { id: "default", type: "plain", isSetupTab: true },
          {
            id: "startup-agent",
            type: "agent-native",
            nativeAgentData: { platform: "cursor", sessionId: "cursor-session-1" },
          },
        ],
      });

      const withoutStartup = createEnvironment("project-1");
      withoutStartup.id = "env-closed-startup";
      withoutStartup.environmentType = "local";
      withoutStartup.containerId = null;
      await storage.addEnvironment(withoutStartup);
      await storage.savePaneLayout(withoutStartup.id, {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{ id: "default", type: "plain" }],
          activeTabId: "default",
        },
      }, 0);
      await expect(storage.ensureStartupNativeAgentTab({
        environmentId: withoutStartup.id,
        agent: "cursor",
        providerSessionId: "closed-session",
        existingOnly: true,
      })).resolves.toBeNull();
      expect((await storage.getPaneLayout(withoutStartup.id))?.revision).toBe(1);
    });
  });

  test("preserves the user's own tab state when publishing provider identity", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-merge";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(environment.id, {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "startup-agent",
              type: "cursor",
              displayTitle: "Reviewer",
              agentHandoffId: "handoff-1",
              consumedAgentHandoffId: "handoff-0",
              initialAgentModel: "chosen-model",
              initialReasoningEffort: "high",
              initialConversationMode: "plan",
              initialFastMode: true,
              isReviewTab: true,
              // Payload for a tab kind this tab definitively is not.
              initialCommands: ["echo stale"],
              nativeAgentData: {
                platform: "cursor",
                environmentId: environment.id,
                hostPort: 4321,
              },
            },
          ],
          activeTabId: "startup-agent",
        },
      }, 0);

      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
      });

      const startupTab = (published?.root as {
        tabs: Array<Record<string, unknown>>;
      }).tabs[1]!;
      // Everything the backend does not own survives; only the native identity
      // is authored here. A wholesale rewrite silently dropped all of this.
      expect(startupTab).toMatchObject({
        id: "startup-agent",
        type: "agent-native",
        displayTitle: "Reviewer",
        agentHandoffId: "handoff-1",
        consumedAgentHandoffId: "handoff-0",
        initialAgentModel: "chosen-model",
        initialReasoningEffort: "high",
        initialConversationMode: "plan",
        initialFastMode: true,
        isReviewTab: true,
        nativeAgentData: {
          platform: "cursor",
          environmentId: environment.id,
          hostPort: 4321,
          sessionId: "cursor-session-1",
          isLocal: true,
        },
      });
      expect(startupTab.initialCommands).toBeUndefined();
    });
  });

  test("leaves a healthy native startup tab untouched when only upgrading", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-upgrade-only";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(environment.id, {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "default", type: "plain", isSetupTab: true },
            {
              id: "startup-agent",
              type: "agent-native",
              displayTitle: "Renamed by the user",
              nativeAgentData: {
                platform: "cursor",
                environmentId: environment.id,
                sessionId: "resumed-elsewhere",
                isLocal: true,
              },
            },
          ],
          activeTabId: "startup-agent",
        },
      }, 0);

      // The repair runs on every backend start, so a tab that already holds the
      // native identity must not be rewritten toward a different session.
      const result = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
        existingOnly: true,
        upgradeOnly: true,
      });

      expect(result?.revision).toBe(1);
      expect((await storage.getPaneLayout(environment.id))?.root).toMatchObject({
        tabs: [
          { id: "default" },
          {
            id: "startup-agent",
            displayTitle: "Renamed by the user",
            nativeAgentData: { sessionId: "resumed-elsewhere" },
          },
        ],
      });
    });
  });

  test("republishing an unchanged startup tab does not bump the layout revision", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-idempotent";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      const first = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });
      // The two-second launch sweep republishes while setup runs, so a repeat
      // call must be a read, not a write.
      const second = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });

      expect(second?.revision).toBe(first?.revision);
      expect(second?.updatedAt).toBe(first?.updatedAt);
    });
  });

  test("publishes the startup tab into the pane that already holds it in a split", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-split";
      environment.environmentType = "local";
      environment.containerId = null;
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(environment.id, {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "left",
        root: {
          kind: "split",
          id: "split-1",
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [
            {
              kind: "leaf",
              id: "left",
              tabs: [{ id: "default", type: "plain", isSetupTab: true }],
              activeTabId: "default",
            },
            {
              kind: "leaf",
              id: "right",
              tabs: [{ id: "startup-agent", type: "cursor" }],
              activeTabId: "startup-agent",
            },
          ],
        },
      }, 0);

      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "cursor",
        providerSessionId: "cursor-session-1",
      });

      // The walk must find the tab in the non-active leaf rather than appending
      // a duplicate into the active one.
      expect(published?.root).toMatchObject({
        kind: "split",
        children: [
          { id: "left", tabs: [{ id: "default" }] },
          {
            id: "right",
            tabs: [{
              id: "startup-agent",
              type: "agent-native",
              nativeAgentData: { sessionId: "cursor-session-1" },
            }],
          },
        ],
      });
    });
  });

  test("omits a container id the environment does not have yet", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-startup-precontainer";
      environment.environmentType = "containerized";
      environment.containerId = null;
      await storage.addEnvironment(environment);

      // Published while the environment is still `creating`, so there is no
      // container to name yet.
      const published = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
      });
      const startupTab = (published?.root as {
        tabs: Array<Record<string, unknown>>;
      }).tabs[1]!;
      expect(startupTab.nativeAgentData).toEqual({
        platform: "codex",
        environmentId: environment.id,
        isLocal: false,
      });

      await storage.updateEnvironment(environment.id, { containerId: "container-1" });
      const rebound = await storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent: "codex",
        providerSessionId: "codex-session-1",
      });
      expect((rebound?.root as {
        tabs: Array<Record<string, unknown>>;
      }).tabs[1]!.nativeAgentData).toEqual({
        platform: "codex",
        environmentId: environment.id,
        isLocal: false,
        containerId: "container-1",
        sessionId: "codex-session-1",
      });
    });
  });

  test("refuses a backend-owned build tab that would exceed the layout bound", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-build-tab-bound";
      await storage.addEnvironment(environment);
      const root = {
        kind: "leaf",
        id: "default",
        tabs: [] as Array<Record<string, unknown>>,
        activeTabId: null,
        padding: "",
      };
      const baseBytes = Buffer.byteLength(JSON.stringify(root), "utf8");
      root.padding = "x".repeat(256 * 1024 - baseBytes - 32);
      await storage.savePaneLayout(environment.id, {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "default",
        root,
      }, 0);

      await expect(storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-overflow",
        taskId: "task-overflow",
        environmentId: environment.id,
        isLocal: true,
      })).rejects.toThrow("Pane layout root exceeds the 256 KB limit");
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(1);
    });
  });

  test("distinguishes an unreadable pane-layout store from a valid empty store", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await expect(storage.loadPaneLayoutsForReconciliation()).resolves.toEqual({
        available: true,
        layouts: {},
      });
      await fs.writeFile(path.join(dataDir, "pane-layouts.json"), "{truncated", "utf8");
      await expect(storage.loadPaneLayoutsForReconciliation()).resolves.toEqual({
        available: false,
        layouts: {},
      });
    });
  });

  test("recovers pane layouts from a valid backup during reconciliation", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-layout-backup";
      await storage.addEnvironment(environment);
      const saved = await storage.savePaneLayout(environment.id, {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "default",
        root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
      }, 0);
      const filePath = path.join(dataDir, "pane-layouts.json");
      await fs.writeFile(
        `${filePath}.bak.1`,
        `${JSON.stringify({ [environment.id]: saved })}\n`,
        "utf8",
      );
      await fs.writeFile(filePath, "{truncated", "utf8");

      await expect(storage.loadPaneLayoutsForReconciliation()).resolves.toEqual({
        available: true,
        layouts: { [environment.id]: saved },
      });
    });
  });
});

describe("pane layout intent persistence", () => {
  const layout = (
    activeTabId: string | null,
    tabs = ["tab-a", "tab-b"],
  ): PaneLayoutMergeInput => ({
    version: PANE_LAYOUT_VERSION,
    containerId: null,
    activePaneId: "pane-1",
    root: {
      kind: "leaf",
      id: "pane-1",
      tabs: tabs.map((id) => ({ id, type: "plain" })),
      activeTabId,
    },
  });

  const persistedInput = (saved: {
    version: number;
    containerId: string | null;
    activePaneId: string;
    root: unknown;
  }): PaneLayoutMergeInput => ({
    version: saved.version,
    containerId: saved.containerId,
    activePaneId: saved.activePaneId,
    root: saved.root as PaneLayoutMergeInput["root"],
  });

  test("creates an initial local layout and applies explicit selection intent", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-intent";
      await storage.addEnvironment(environment);
      const base = layout("tab-a");

      const initial = await storage.applyPaneLayoutIntent(
        environment.id,
        base,
        base,
      );
      expect(initial).toMatchObject({
        environmentId: environment.id,
        containerId: null,
        revision: 1,
        root: base.root,
      });

      const selected = await storage.applyPaneLayoutIntent(
        environment.id,
        base,
        base,
        { activePaneId: "pane-1", activeTabIds: { "pane-1": "tab-b" } },
      );
      expect(selected.revision).toBe(2);
      expect((selected.root as { activeTabId: string }).activeTabId).toBe("tab-b");
    });
  });

  test("prevents a delayed setup-tab addition from reclaiming focus after setup", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-late-setup-tab";
      await storage.addEnvironment(environment);
      const initial = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const staleBase = persistedInput(initial);
      const staleDesired = structuredClone(staleBase);
      if (staleDesired.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const staleSetupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      staleDesired.root.tabs.push(staleSetupTab);
      staleDesired.root.activeTabId = "setup-terminal";

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const buildSelected = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const saved = await storage.applyPaneLayoutIntent(
        environment.id,
        staleBase,
        staleDesired,
        {
          activePaneId: "default",
          activeTabIds: { default: "setup-terminal" },
        },
      );

      expect(saved.revision).toBe(buildSelected.revision + 1);
      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "build-pipeline-1",
      });
      expect((saved.root as { tabs: Array<{ id: string }> }).tabs)
        .not.toContainEqual(expect.objectContaining({ id: "setup-terminal" }));
    });
  });

  test("allows completed setup output that was already durable to be selected", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-durable-setup-tab";
      await storage.addEnvironment(environment);
      const initial = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const beforeSetup = persistedInput(initial);
      const withSetup = structuredClone(beforeSetup);
      if (withSetup.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const setupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      withSetup.root.tabs.push(setupTab);
      withSetup.root.activeTabId = "setup-terminal";
      await storage.applyPaneLayoutIntent(
        environment.id,
        beforeSetup,
        withSetup,
        { activeTabIds: { default: "setup-terminal" } },
      );

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const buildSelected = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const manualBase = persistedInput(buildSelected);
      const manuallySelected = structuredClone(manualBase);
      if (manuallySelected.root.kind !== "leaf") throw new Error("expected a leaf layout");
      manuallySelected.root.activeTabId = "setup-terminal";
      const saved = await storage.applyPaneLayoutIntent(
        environment.id,
        manualBase,
        manuallySelected,
        { activeTabIds: { default: "setup-terminal" } },
      );

      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "setup-terminal",
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: "setup-terminal", isSetupTab: true }),
        ]),
      });
    });
  });

  test("prevents a stale durable setup selection from overriding the build handoff", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-stale-durable-setup-focus";
      await storage.addEnvironment(environment);
      const initial = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const beforeSetup = persistedInput(initial);
      const withSetup = structuredClone(beforeSetup);
      if (withSetup.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const setupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      withSetup.root.tabs.push(setupTab);
      withSetup.root.activeTabId = "setup-terminal";
      const setupSelected = await storage.applyPaneLayoutIntent(
        environment.id,
        beforeSetup,
        withSetup,
        { activeTabIds: { default: "setup-terminal" } },
      );

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const buildSelected = await storage.ensureBuildPipelineTab({
        pipelineId: "pipeline-1",
        taskId: "task-1",
        environmentId: environment.id,
        isLocal: true,
      });
      const staleSetupSelection = persistedInput(setupSelected);
      const saved = await storage.applyPaneLayoutIntent(
        environment.id,
        staleSetupSelection,
        staleSetupSelection,
        { activeTabIds: { default: "setup-terminal" } },
      );

      expect(saved.revision).toBe(buildSelected.revision + 1);
      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "build-pipeline-1",
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: "setup-terminal", isSetupTab: true }),
        ]),
      });
    });
  });

  test("prevents stale setup focus from overriding an agent-tab handoff", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-agent-setup-handoff";
      await storage.addEnvironment(environment);
      const setupLayout = layout("setup-terminal", ["setup-terminal"]);
      if (setupLayout.root.kind !== "leaf") throw new Error("expected a leaf layout");
      const setupTab = {
        id: "setup-terminal",
        type: "plain",
        isSetupTab: true,
      };
      setupLayout.root.tabs[0] = setupTab;
      const setupSelected = await storage.applyPaneLayoutIntent(
        environment.id,
        setupLayout,
        setupLayout,
        { activeTabIds: { "pane-1": "setup-terminal" } },
      );

      await storage.updateEnvironment(environment.id, {
        setupScriptsComplete: true,
        setupPhase: "ready",
      });
      const agentBase = persistedInput(setupSelected);
      const agentDesired = structuredClone(agentBase);
      if (agentDesired.root.kind !== "leaf") throw new Error("expected a leaf layout");
      agentDesired.root.tabs.push({
        id: "startup-agent",
        type: "codex-native",
      });
      agentDesired.root.activeTabId = "startup-agent";
      const agentSelected = await storage.applyPaneLayoutIntent(
        environment.id,
        agentBase,
        agentDesired,
        { activeTabIds: { "pane-1": "startup-agent" } },
      );
      const staleSetupSelection = persistedInput(setupSelected);
      const saved = await storage.applyPaneLayoutIntent(
        environment.id,
        staleSetupSelection,
        staleSetupSelection,
        { activeTabIds: { "pane-1": "setup-terminal" } },
      );

      expect(saved.revision).toBe(agentSelected.revision + 1);
      expect(saved.root).toMatchObject({
        kind: "leaf",
        activeTabId: "startup-agent",
        tabs: expect.arrayContaining([
          expect.objectContaining({ id: "setup-terminal", isSetupTab: true }),
          expect.objectContaining({ id: "startup-agent", type: "codex-native" }),
        ]),
      });
    });
  });

  test("rejects malformed and stale generations without consuming a revision", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-layout-generation";
      environment.containerId = "container-new";
      await storage.addEnvironment(environment);
      const current = {
        ...layout("tab-a"),
        containerId: "container-new",
      };
      await storage.savePaneLayout(environment.id, current, 0);
      const stale = { ...current, containerId: "container-old" };
      await expect(storage.applyPaneLayoutIntent(environment.id, stale, stale))
        .rejects.toThrow("stale environment generation");

      const cyclicRoot: Record<string, unknown> = { kind: "leaf" };
      cyclicRoot.self = cyclicRoot;
      await expect(storage.applyPaneLayoutIntent(
        environment.id,
        current,
        { ...current, root: cyclicRoot } as unknown as PaneLayoutMergeInput,
      )).rejects.toThrow("JSON serializable");

      await expect(storage.applyPaneLayoutIntent(
        environment.id,
        current,
        current,
        {
          activeTabIds: Object.fromEntries(
            Array.from({ length: 1_025 }, (_, index) => [`pane-${index}`, null]),
          ),
        },
      )).rejects.toThrow("1024 entry limit");
      await expect(storage.applyPaneLayoutIntent(
        environment.id,
        current,
        current,
        { activePaneId: "p".repeat(64 * 1024) },
      )).rejects.toThrow("64 KB limit");
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(1);
    });
  });

  test("rejects a stale merge ancestor even when the desired generation is current", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-layout-base-generation";
      environment.containerId = "container-new";
      await storage.addEnvironment(environment);
      const current = { ...layout("tab-a"), containerId: "container-new" };
      await storage.savePaneLayout(environment.id, current, 0);

      // Both sides of the merge come from the renderer. A dead ancestor still
      // merges against the durable tree, which resurrects the tabs it carried.
      await expect(storage.applyPaneLayoutIntent(
        environment.id,
        { ...current, containerId: "container-old" },
        current,
      )).rejects.toThrow("stale environment generation");
      expect((await storage.getPaneLayout(environment.id))?.revision).toBe(1);
    });
  });

  test("preserves a concurrently replaced layout during revision-guarded deletion", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-guarded-delete";
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(environment.id, layout("tab-a"), 0);
      const newer = await storage.savePaneLayout(
        environment.id,
        layout("tab-b"),
        1,
      );

      await expect(storage.deletePaneLayout(environment.id, 1))
        .rejects.toThrow("expected 1, current 2");
      expect(await storage.getPaneLayout(environment.id)).toEqual(newer);

      await storage.deletePaneLayout(environment.id, 2);
      expect(await storage.getPaneLayout(environment.id)).toBeNull();
    });
  });

  test("rejects a container generation on a local environment from both write paths", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-local-generation";
      // A local environment has no container, so only null is a live generation
      // - even if a stale containerId is still recorded on the environment.
      environment.containerId = "container-ghost";
      await storage.addEnvironment(environment);
      const containerLayout = { ...layout("tab-a"), containerId: "container-ghost" };

      await expect(storage.savePaneLayout(environment.id, containerLayout, 0))
        .rejects.toThrow("stale environment generation");
      await expect(storage.applyPaneLayoutIntent(
        environment.id,
        containerLayout,
        containerLayout,
      )).rejects.toThrow("stale environment generation");
      expect(await storage.getPaneLayout(environment.id)).toBeNull();

      await expect(storage.savePaneLayout(environment.id, layout("tab-a"), 0))
        .resolves.toMatchObject({ revision: 1, containerId: null });
    });
  });

  test("replaces rather than merges when the persisted layout version differs", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-version-generation";
      await storage.addEnvironment(environment);
      await storage.savePaneLayout(
        environment.id,
        { ...layout("tab-a", ["tab-a", "tab-b"]), version: PANE_LAYOUT_VERSION - 1 },
        0,
      );

      // The persisted record is a different layout version, so there is no
      // common ancestor to rebase onto: the intent replaces it wholesale.
      const desired = layout("tab-c", ["tab-c"]);
      const saved = await storage.applyPaneLayoutIntent(environment.id, desired, desired);
      expect(saved).toMatchObject({
        version: PANE_LAYOUT_VERSION,
        revision: 2,
        root: desired.root,
      });
    });
  });

  test("recovers the mutation queue after a filesystem write failure", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = createEnvironment("project-1", { environmentType: "local" });
      environment.id = "env-layout-write-recovery";
      await storage.addEnvironment(environment);
      const filePath = path.join(dataDir, "pane-layouts.json");
      await fs.mkdir(filePath);

      await expect(storage.applyPaneLayoutIntent(
        environment.id,
        layout("tab-a"),
        layout("tab-a"),
      )).rejects.toThrow();
      await fs.rm(filePath, { recursive: true, force: true });
      await expect(storage.applyPaneLayoutIntent(
        environment.id,
        layout("tab-a"),
        layout("tab-b"),
      )).resolves.toMatchObject({ revision: 1 });
    });
  });
});

describe("durable tab teardown intents", () => {
  test("atomically preserves concurrent intents and clears only the completed generation", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = createEnvironment("project-1");
      environment.id = "env-teardown-intents";
      await storage.addEnvironment(environment);
      const first = {
        tabId: "tab-1",
        kind: "terminal" as const,
        createdAt: "2026-08-04T10:00:00.000Z",
      };
      const second = {
        tabId: "tab-2",
        kind: "codex-native" as const,
        createdAt: "2026-08-04T10:00:01.000Z",
      };

      await Promise.all([
        storage.setTabTeardownIntent(environment.id, first),
        storage.setTabTeardownIntent(environment.id, second),
      ]);
      expect((await storage.getEnvironment(environment.id))?.tabTeardownIntents)
        .toEqual({ "tab-1": first, "tab-2": second });

      await storage.setTabTeardownIntent(environment.id, {
        ...first,
        createdAt: "2026-08-04T10:00:02.000Z",
      });
      await storage.clearTabTeardownIntent(environment.id, first.tabId, first.createdAt);
      expect((await storage.getEnvironment(environment.id))?.tabTeardownIntents)
        .toHaveProperty("tab-1.createdAt", "2026-08-04T10:00:02.000Z");
    });
  });
});

describe("PR completion refresh intent", () => {
  test("rejects missing environments and ignores every ineligible PR state", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(storage.armPrRecheckAfterAgentCompletion("missing"))
        .rejects.toThrow("Environment not found: missing");

      for (const [index, metadata] of ([
        { prUrl: null, prState: null, hasMergeConflicts: null },
        { prUrl: "https://github.com/acme/repo/pull/1", prState: "closed", hasMergeConflicts: true },
        { prUrl: "https://github.com/acme/repo/pull/1", prState: "open", hasMergeConflicts: false },
        { prUrl: "https://github.com/acme/repo/pull/1", prState: "open", hasMergeConflicts: null },
      ] as const).entries()) {
        const environment = { ...createEnvironment("project-1"), id: `env-${index}`, ...metadata };
        await storage.addEnvironment(environment);
        expect((await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt)
          .toBeNull();
      }
    });
  });

  test("survives restart and token-safe rollback preserves a newer arm", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const first = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.getEnvironment(environment.id))
        ?.prRecheckAfterAgentCompletionArmedAt).toBe(first);

      const second = (await restarted.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
      expect(second).not.toBe(first);
      expect((await restarted.disarmPrRecheckAfterAgentCompletion(environment.id, first))
        .prRecheckAfterAgentCompletionArmedAt).toBe(second);
      expect((await restarted.disarmPrRecheckAfterAgentCompletion(environment.id, second))
        .prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
      await expect(restarted.disarmPrRecheckAfterAgentCompletion("missing", second))
        .rejects.toThrow("Environment not found: missing");
    });
  });

  test("returns no token when a later arm is refused without exposing the existing token", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-refused-rearm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const first = await storage.armPrRecheckAfterAgentCompletion(environment.id);
      await storage.updateEnvironment(environment.id, { hasMergeConflicts: null });

      const refused = await storage.armPrRecheckAfterAgentCompletion(environment.id);

      expect(first.armedAt).toEqual(expect.any(String));
      expect(refused.armedAt).toBeNull();
      expect(refused.environment.prRecheckAfterAgentCompletionArmedAt).toBe(first.armedAt!);
    });
  });

  test("generates strictly increasing arm tokens in the same millisecond and after clock rollback", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-monotonic-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const now = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const first = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        const second = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        now.mockReturnValue(1_700_000_000_000);
        const third = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;

        expect(Date.parse(second)).toBe(Date.parse(first) + 1);
        expect(Date.parse(third)).toBe(Date.parse(second) + 1);
      } finally {
        now.mockRestore();
      }
    });
  });

  test("replaces an unparseable stored arm token", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-invalid-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "not-a-date",
      };
      await storage.addEnvironment(environment);

      const armedAt = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt;

      expect(armedAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(armedAt!))).toBe(true);
    });
  });

  test("serializes monitor state ahead of a concurrent stale arm", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-race",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);

      const stateUpdate = storage.updateEnvironment(environment.id, {
        hasMergeConflicts: false,
        prRecheckAfterAgentCompletionArmedAt: undefined,
      });
      const staleArm = storage.armPrRecheckAfterAgentCompletion(environment.id);
      await Promise.all([stateUpdate, staleArm]);

      expect(await storage.getEnvironment(environment.id)).toMatchObject({
        hasMergeConflicts: false,
      });
      expect((await storage.getEnvironment(environment.id))
        ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
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
  ] as const)(
    "%s",
    async (_label, source, githubToken, expected) => {
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
        await fs.writeFile(
          path.join(dataDir, "config.json"),
          `${JSON.stringify(config)}\n`,
          "utf8",
        );

        const loaded = await storage.loadConfig();
        expect(loaded.global.useHostGitHubCredentials).toBe(expected);
        expect(loaded.global.githubToken).toBe(githubToken);
      });
    },
  );
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

describe("hot store read caching", () => {
  test("serves repeated environment reads from the cache and re-validates by stat", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const environmentsPath = path.join(dataDir, "environments.json");

      const readSpy = spyOn(fs, "readFile");
      const environmentReads = () =>
        readSpy.mock.calls.filter(([file]) => String(file).endsWith("environments.json")).length;
      try {
        await storage.loadEnvironments();
        const readsAfterFirstLoad = environmentReads();

        // Steady state: no further reads of the file, only stats.
        await storage.loadEnvironments();
        await storage.getEnvironment(environment.id);
        await storage.getEnvironmentsByProject("project-1");
        expect(environmentReads()).toBe(readsAfterFirstLoad);

        // Mutating a returned value must not poison the cache: reads hand
        // out clones precisely because every mutation path edits in place.
        (await storage.loadEnvironments())[0]!.name = "mutated-by-caller";
        expect((await storage.getEnvironment(environment.id))!.name)
          .toBe(environment.name);

        // A save through this process invalidates the cached parse.
        await storage.updateEnvironment(environment.id, { name: "renamed" });
        expect((await storage.getEnvironment(environment.id))!.name).toBe("renamed");

        // A foreign in-place write (another backend process) is observed via
        // the stat fingerprint even though this process never wrote.
        const foreign = JSON.parse(
          await fs.readFile(environmentsPath, "utf8"),
        ) as Array<Record<string, unknown>>;
        foreign[0]!.name = "foreign-writer";
        await fs.writeFile(environmentsPath, JSON.stringify(foreign));
        expect((await storage.getEnvironment(environment.id))!.name)
          .toBe("foreign-writer");
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  test("refreshes one recovery backup for volatile writes without rotating history", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const backupPath = path.join(dataDir, "environments.json.bak.1");

      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        new Date(Date.now() + 1_000).toISOString(),
        "frontend",
        "renderer-token",
      );
      await storage.recordEnvironmentActivity(
        environment.id,
        new Date(Date.now() + 2_000).toISOString(),
      );
      // Activity-only writes keep one current recovery point without shifting
      // five timestamp-only copies through the historical backup chain.
      await fs.access(backupPath);
      await expect(fs.access(path.join(dataDir, "environments.json.bak.2")))
        .rejects.toThrow();

      // A structural mutation still pays for the rotation.
      await storage.updateEnvironment(environment.id, { name: "renamed" });
      await fs.access(path.join(dataDir, "environments.json.bak.2"));
    });
  });

  test("recovers the latest structural state after later activity-only writes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.updateEnvironment(environment.id, { name: "structurally-renamed" });
      const occurredAt = new Date(Date.now() + 1_000).toISOString();
      await storage.recordEnvironmentActivity(environment.id, occurredAt);

      await fs.writeFile(path.join(dataDir, "environments.json"), "{corrupt", "utf8");
      const recovered = await new StorageService(dataDir).getEnvironment(environment.id);
      expect(recovered).toMatchObject({
        id: environment.id,
        name: "structurally-renamed",
        lastActivityAt: occurredAt,
      });
    });
  });

  test("invalidates project and config caches after external writes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await storage.addProject({
        id: "project-cache",
        name: "Before",
        gitUrl: "https://example.invalid/cache.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      });
      const config = defaultConfig();
      await storage.saveConfig(config);
      await storage.loadProjects();
      await storage.loadConfig();

      const projectsPath = path.join(dataDir, "projects.json");
      const projects = JSON.parse(await fs.readFile(projectsPath, "utf8")) as Array<{
        name: string;
      }>;
      projects[0]!.name = "After!";
      await fs.writeFile(projectsPath, `${JSON.stringify(projects)}\n`, "utf8");

      const configPath = path.join(dataDir, "config.json");
      const foreignConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as AppConfig;
      foreignConfig.global.webClientEnabled = false;
      await fs.writeFile(configPath, `${JSON.stringify(foreignConfig)}\n`, "utf8");

      expect((await storage.loadProjects())[0]!.name).toBe("After!");
      expect((await storage.loadConfig()).global.webClientEnabled).toBe(false);
    });
  });

  test("recovers from backup when the store cannot be stat'd", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      // The second write is what puts a full record into the rotated backup:
      // the first found no primary file to copy.
      await storage.updateEnvironment(environment.id, { name: "renamed" });

      const environmentsPath = path.join(dataDir, "environments.json");
      const realStat = fs.stat.bind(fs);
      const statSpy = spyOn(fs, "stat").mockImplementation((async (
        target: Parameters<typeof fs.stat>[0],
      ) => {
        if (String(target) === environmentsPath) {
          throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
        }
        return realStat(target);
      }) as typeof fs.stat);
      try {
        expect((await storage.loadEnvironments()).map((item) => item.id))
          .toEqual([environment.id]);
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  test("surfaces an unreadable store instead of presenting it as empty", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environmentsPath = path.join(dataDir, "environments.json");
      const stored = createEnvironment("project-1");
      // Written directly so no backup exists to recover from.
      await fs.writeFile(environmentsPath, `${JSON.stringify([stored])}\n`, "utf8");

      const realStat = fs.stat.bind(fs);
      const statSpy = spyOn(fs, "stat").mockImplementation((async (
        target: Parameters<typeof fs.stat>[0],
      ) => {
        if (String(target) === environmentsPath) {
          throw Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" });
        }
        return realStat(target);
      }) as typeof fs.stat);
      try {
        await expect(storage.loadEnvironments()).rejects.toThrow("EIO");
        // The empty view was never the real damage: the next mutation would
        // have appended to that empty list and written it back over the
        // user's intact data.
        await expect(storage.addEnvironment(createEnvironment("project-1")))
          .rejects.toThrow("EIO");
      } finally {
        statSpy.mockRestore();
      }

      expect((await storage.loadEnvironments()).map((item) => item.id)).toEqual([stored.id]);
    });
  });

  test("skips the lease sweep without the cross-process lock when no leases exist", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await storage.addEnvironment(createEnvironment("project-1"));
      const lockPath = path.join(dataDir, "environments.json.lock");
      // A fresh foreign lock blocks the mutation path for its full 20s
      // timeout; the sweep must not need it when nothing can expire.
      await fs.writeFile(lockPath, "held-by-another-process");
      try {
        await expect(storage.expireFrontendAgentActivityLeases()).resolves.toEqual([]);
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    });
  });
});

describe("environment completion and unread state", () => {
  test("records a per-session completion even when its timestamp collides with aggregate activity", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const collision = environment.lastActivityAt!;

      const completed = await storage.recordEnvironmentSessionCompletion(
        environment.id,
        collision,
      );

      expect(completed.hasUnreadWork).toBe(true);
      expect(Date.parse(completed.lastActivityAt!)).toBe(Date.parse(collision) + 1);
      await expect(
        storage.recordEnvironmentSessionCompletion(environment.id, "not-an-iso-time"),
      ).rejects.toThrow("occurredAt must be a valid ISO timestamp");
      await expect(
        storage.recordEnvironmentSessionCompletion("missing", new Date().toISOString()),
      ).rejects.toThrow("Environment not found: missing");
    });
  });

  test("does not move the unread activity token backwards for a fresh observer", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const completion = new Date(Date.now() + 60_000).toISOString();
      await storage.recordEnvironmentCompletion(environment.id, completion);
      const olderTransition = new Date(Date.now() + 1_000).toISOString();

      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        olderTransition,
        "frontend",
        "fresh-observer",
      );

      expect((await storage.getEnvironment(environment.id))?.lastActivityAt).toBe(completion);
    });
  });

  test("records a newer completion and ignores stale completion timestamps", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const previousActivityAt = environment.lastActivityAt!;
      const newer = new Date(
        new Date(previousActivityAt).getTime() + 1,
      ).toISOString();
      const completed = await storage.recordEnvironmentCompletion(environment.id, newer);
      expect(completed).toMatchObject({
        lastActivityAt: newer,
        hasUnreadWork: true,
      });

      await storage.setEnvironmentUnread(environment.id, false, newer);
      const stale = await storage.recordEnvironmentCompletion(
        environment.id,
        previousActivityAt,
      );
      expect(stale).toMatchObject({
        lastActivityAt: newer,
        hasUnreadWork: false,
      });
      await expect(storage.recordEnvironmentCompletion(environment.id, "invalid"))
        .rejects.toThrow("occurredAt must be a valid ISO timestamp");
    });
  });

  test("clears unread only when the expected activity token still matches", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const previousActivityAt = environment.lastActivityAt!;
      const activityAt = new Date(
        new Date(previousActivityAt).getTime() + 1,
      ).toISOString();
      await storage.recordEnvironmentCompletion(environment.id, activityAt);

      const staleClear = await storage.setEnvironmentUnread(
        environment.id,
        false,
        previousActivityAt,
      );
      expect(staleClear.hasUnreadWork).toBe(true);

      const cleared = await storage.setEnvironmentUnread(
        environment.id,
        false,
        activityAt,
      );
      expect(cleared.hasUnreadWork).toBe(false);
      expect((await storage.getEnvironment(environment.id))!.hasUnreadWork).toBe(false);
      await expect(
        storage.setEnvironmentUnread(environment.id, true, 123 as never),
      ).rejects.toThrow("expectedLastActivityAt must be a string or null");
    });
  });
});

describe("Kanban point reads", () => {
  test("returns one task by id and null when it is absent", async () => {
    await withTemporaryStorage(async (storage) => {
      const task = await storage.addKanbanTask("project-1", "Build", "Details");
      await storage.addKanbanTask("project-2", "Other", "Other details");

      await expect(storage.getKanbanTask(task.id)).resolves.toEqual(task);
      await expect(storage.getKanbanTask("missing-task")).resolves.toBeNull();
    });
  });
});

describe("session buffer deletion", () => {
  test("removes an existing buffer and is idempotent when it is already absent", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.saveSessionBuffer("session-delete", "sensitive terminal output");
      expect(await storage.loadSessionBuffer("session-delete")).toBe(
        "sensitive terminal output",
      );

      await storage.deleteSessionBuffer("session-delete");
      await storage.deleteSessionBuffer("session-delete");

      expect(await storage.loadSessionBuffer("session-delete")).toBeNull();
    });
  });
});

describe("OpenCode model catalogue cache", () => {
  const projectId = "project-a";
  const models = [
    {
      id: "openrouter/openai/gpt-5",
      name: "GPT-5",
      provider: "openrouter",
      variants: ["low", "high"],
      contextWindow: 400_000,
    },
    {
      id: "anthropic/claude-sonnet",
      name: "Claude Sonnet",
      provider: "anthropic",
    },
  ];

  test("persists a normalized catalogue in the application config folder", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const snapshot = await storage.cacheOpenCodeModelCatalog(projectId, models);

      expect(snapshot.schemaVersion).toBe(2);
      expect(snapshot.projectId).toBe(projectId);
      expect(snapshot.models.map((model) => model.id)).toEqual([
        "anthropic/claude-sonnet",
        "openrouter/openai/gpt-5",
      ]);
      expect(await storage.getOpenCodeModelCatalog(projectId)).toEqual(snapshot);
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(dataDir, "opencode-model-catalog.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        schemaVersion: 2,
        catalogs: { [projectId]: snapshot },
      });
    });
  });

  test("keeps cache versions stable per project until its discovered models change", async () => {
    await withTemporaryStorage(async (storage) => {
      const initial = await storage.cacheOpenCodeModelCatalog(projectId, models);
      const unchanged = await storage.cacheOpenCodeModelCatalog(
        projectId,
        [...models].reverse(),
      );
      expect(unchanged).toEqual(initial);

      const updated = await storage.cacheOpenCodeModelCatalog(
        projectId,
        [
          ...models,
          {
            id: "openrouter/google/gemini",
            name: "Gemini",
            provider: "openrouter",
          },
        ],
      );
      expect(updated.catalogVersion).not.toBe(initial.catalogVersion);
      expect(updated.models).toHaveLength(3);
    });
  });

  test("isolates project catalogues in one scoped store", async () => {
    await withTemporaryStorage(async (storage) => {
      const first = await storage.cacheOpenCodeModelCatalog("project-a", models);
      const second = await storage.cacheOpenCodeModelCatalog("project-b", [{
        id: "local/model",
        name: "Local",
        provider: "local",
      }]);

      expect(await storage.getOpenCodeModelCatalog("project-a")).toEqual(first);
      expect(await storage.getOpenCodeModelCatalog("project-b")).toEqual(second);
      expect(await storage.getOpenCodeModelCatalog("project-c")).toBeNull();

      const prototypeNamed = await storage.cacheOpenCodeModelCatalog(
        "constructor",
        models,
      );
      expect(await storage.getOpenCodeModelCatalog("constructor")).toEqual(
        prototypeNamed,
      );
    });
  });

  test("normalizes whitespace, variants, duplicates, and optional numeric boundaries", async () => {
    await withTemporaryStorage(async (storage) => {
      const snapshot = await storage.cacheOpenCodeModelCatalog(projectId, [
        {
          id: " provider/model ",
          name: " Model ",
          provider: " provider ",
          variants: [" high ", "", "low", "high", "   "],
          inputCost: 0,
          outputCost: Number.MAX_VALUE,
          contextWindow: Number.MAX_SAFE_INTEGER,
        },
        {
          id: "provider/model",
          name: "Z model",
          provider: "provider",
          inputCost: -1,
          outputCost: Number.POSITIVE_INFINITY,
          contextWindow: 1.5,
        },
        {
          id: "provider/invalid-numerics",
          name: "Invalid numerics",
          provider: "provider",
          variants: [" ", ""],
          inputCost: -1,
          outputCost: Number.POSITIVE_INFINITY,
          contextWindow: 1.5,
        },
        ...([
          null,
          {},
          { id: "blank/name", name: " ", provider: "provider" },
          { id: "blank/provider", name: "Name", provider: " " },
        ] as unknown as typeof models),
      ]);

      expect(snapshot.models).toEqual([
        {
          id: "provider/invalid-numerics",
          name: "Invalid numerics",
          provider: "provider",
        },
        {
          id: "provider/model",
          name: "Model",
          provider: "provider",
          variants: ["high", "low"],
          inputCost: 0,
          outputCost: Number.MAX_VALUE,
          contextWindow: Number.MAX_SAFE_INTEGER,
        },
      ]);
    });
  });

  test("rejects blank scopes and empty or all-invalid catalogues", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(storage.getOpenCodeModelCatalog(" \t")).rejects.toThrow(
        "projectId must be a non-blank string",
      );
      await expect(
        storage.cacheOpenCodeModelCatalog("", models),
      ).rejects.toThrow("projectId must be a non-blank string");
      await expect(
        storage.cacheOpenCodeModelCatalog(projectId, []),
      ).rejects.toThrow("must contain at least one model");
      await expect(
        storage.cacheOpenCodeModelCatalog(
          projectId,
          [{ id: "", name: "", provider: "" }],
        ),
      ).rejects.toThrow("must contain at least one model");
    });
  });

  test("repairs stored dates, versions, and normalized model data while reading", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "opencode-model-catalog.json"),
        JSON.stringify({
          schemaVersion: 2,
          catalogs: {
            " project-a ": {
              schemaVersion: 999,
              projectId: "wrong-project",
              catalogVersion: "not-the-content-digest",
              updatedAt: "not-a-date",
              models: [{
                id: " provider/model ",
                name: " Model ",
                provider: " provider ",
                variants: ["z", "a", "z"],
              }],
            },
            malformed: { models: [{ id: "missing-fields" }] },
          },
        }),
      );

      const snapshot = await storage.getOpenCodeModelCatalog(projectId);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.schemaVersion).toBe(2);
      expect(snapshot?.projectId).toBe(projectId);
      expect(snapshot?.updatedAt).toBe(new Date(0).toISOString());
      expect(snapshot?.catalogVersion).toHaveLength(64);
      expect(snapshot?.catalogVersion).not.toBe("not-the-content-digest");
      expect(snapshot?.models).toEqual([{
        id: "provider/model",
        name: "Model",
        provider: "provider",
        variants: ["a", "z"],
      }]);
      expect(await storage.getOpenCodeModelCatalog("malformed")).toBeNull();
    });
  });

  test("does not assign the legacy host-global cache to a requesting project", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const legacy = {
        schemaVersion: 1,
        catalogVersion: "legacy",
        updatedAt: new Date().toISOString(),
        models,
      };
      const file = path.join(dataDir, "opencode-model-catalog.json");
      await fs.writeFile(file, JSON.stringify(legacy));

      expect(await storage.getOpenCodeModelCatalog(projectId)).toBeNull();
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(legacy);

      const scoped = await storage.cacheOpenCodeModelCatalog(projectId, models);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
        schemaVersion: 2,
        catalogs: { [projectId]: scoped },
        legacyUnscoped: legacy,
      });
    });
  });

  test("serializes overlapping writes and preserves every project", async () => {
    await withTemporaryStorage(async (storage) => {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          storage.cacheOpenCodeModelCatalog(`project-${index}`, [{
            id: `provider/model-${index}`,
            name: `Model ${index}`,
            provider: "provider",
          }])
        ),
      );

      for (let index = 0; index < 12; index += 1) {
        expect(
          (await storage.getOpenCodeModelCatalog(`project-${index}`))?.models[0]?.id,
        ).toBe(`provider/model-${index}`);
      }
    });
  });

  test("recovers the mutation queue after a failed write", async () => {
    await withTemporaryStorage(async (storage) => {
      const internals = storage as unknown as {
        saveJson: (filePath: string, value: unknown) => Promise<void>;
      };
      const saveJson = internals.saveJson.bind(storage);
      let failNext = true;
      internals.saveJson = async (filePath, value) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected cache write failure");
        }
        await saveJson(filePath, value);
      };

      await expect(
        storage.cacheOpenCodeModelCatalog("project-failed", models),
      ).rejects.toThrow("injected cache write failure");
      const recovered = await storage.cacheOpenCodeModelCatalog(
        "project-recovered",
        models,
      );
      expect(recovered.projectId).toBe("project-recovered");
      expect(await storage.getOpenCodeModelCatalog("project-failed")).toBeNull();
    });
  });

  test("a read concurrent with a write sees one coherent snapshot", async () => {
    await withTemporaryStorage(async (storage) => {
      const first = await storage.cacheOpenCodeModelCatalog(projectId, models);

      // Reads deliberately skip the mutation lock, so they rely on the write
      // being atomic. A torn read would surface as a null or a partial model
      // list rather than one of the two whole snapshots.
      const [, ...reads] = await Promise.all([
        storage.cacheOpenCodeModelCatalog(projectId, [
          ...models,
          { id: "provider/added", name: "Added", provider: "provider" },
        ]),
        ...Array.from({ length: 24 }, () =>
          storage.getOpenCodeModelCatalog(projectId)
        ),
      ]);

      const second = await storage.getOpenCodeModelCatalog(projectId);
      expect(second?.models).toHaveLength(3);
      for (const read of reads) {
        expect(read).not.toBeNull();
        expect([first.catalogVersion, second?.catalogVersion]).toContain(
          read?.catalogVersion,
        );
        expect(read?.models).toEqual(
          read?.catalogVersion === first.catalogVersion
            ? first.models
            : second!.models,
        );
      }
    });
  });

  test("serializes separate StorageService instances sharing a data directory", async () => {
    await withTemporaryStorage(async (first, dataDir) => {
      const second = new StorageService(dataDir);
      await second.init();
      await Promise.all([
        first.cacheOpenCodeModelCatalog("project-a", models),
        second.cacheOpenCodeModelCatalog("project-b", [{
          id: "provider/second",
          name: "Second",
          provider: "provider",
        }]),
      ]);

      expect(await first.getOpenCodeModelCatalog("project-a")).not.toBeNull();
      expect(await first.getOpenCodeModelCatalog("project-b")).not.toBeNull();
    });
  });
});

describe("host agent model catalogue cache", () => {
  test("round-trips host agent catalogues across storage instances", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const claudeModels: ClaudeModelCatalogEntry[] = [{
        id: "claude-opus-latest",
        name: "Claude Opus Latest",
        description: "Most capable",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      }];
      const codexModels: CodexModelCatalogEntry[] = [{
        id: "gpt-latest",
        name: "GPT Latest",
        description: "Latest coding model",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"],
        defaultReasoningEffort: "medium",
      }];
      const cursorModels: AgentModel[] = [{
        platform: "cursor",
        id: "composer-latest",
        label: "Composer Latest",
        providerLabel: "Cursor",
        reasoning: [{ id: "high", label: "High", annotation: "Slower" }],
        defaultReasoningId: "high",
        supportsSpeed: true,
        supportsMode: true,
      }];
      const grokModels: AgentModel[] = [{
        platform: "grok",
        id: "grok-code-latest",
        label: "Grok Code Latest",
        providerLabel: "Grok",
        supportsMode: true,
      }];

      await storage.cacheAgentModelCatalog("claude", claudeModels);
      await storage.cacheAgentModelCatalog("codex", codexModels);
      await storage.cacheAgentModelCatalog("cursor", cursorModels);
      await storage.cacheAgentModelCatalog("grok", grokModels);

      const reopened = new StorageService(dataDir);
      await reopened.init();
      expect(await reopened.getAgentModelCatalogCache()).toMatchObject({
        schemaVersion: 1,
        claude: { models: claudeModels },
        codex: { models: codexModels },
        cursor: { models: cursorModels },
        grok: { models: grokModels },
      });
    });
  });

  test("does not rewrite an unchanged catalogue and ignores malformed persisted entries", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const models = [{ id: "gpt-latest", name: "GPT Latest" }];
      const first = await storage.cacheAgentModelCatalog("codex", models);
      const second = await storage.cacheAgentModelCatalog("codex", models);
      expect(second.codex?.updatedAt).toBe(first.codex?.updatedAt);

      await fs.writeFile(
        path.join(dataDir, "agent-model-catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          claude: {
            updatedAt: "not-a-date",
            models: [{ id: "", name: "Broken" }],
          },
          codex: {
            updatedAt: new Date().toISOString(),
            models: [{ id: "gpt-broken", name: "Broken", reasoningEfforts: ["impossible"] }],
          },
          cursor: {
            updatedAt: new Date().toISOString(),
            models: [{ platform: "grok", id: "wrong-provider", label: "Wrong" }],
          },
          grok: {
            updatedAt: new Date().toISOString(),
            models: [{ platform: "grok", id: "broken", label: 42 }],
          },
        }),
      );
      expect(await storage.getAgentModelCatalogCache()).toEqual({
        schemaVersion: 1,
      });
    });
  });

  test("normalizes whitespace and drops duplicate or malformed model entries", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.cacheAgentModelCatalog("claude", [
        {
          id: "  claude-opus-latest  ",
          resolvedModel: "  claude-opus-20260701  ",
          name: "  Claude Opus Latest  ",
          description: "  Most capable  ",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
        { id: "claude-opus-latest", name: "Duplicate" },
        { id: "claude-invalid-boolean", name: "Invalid", supportsEffort: "yes" },
        {
          id: "claude-invalid-effort",
          name: "Invalid",
          supportedEffortLevels: ["impossible"],
        },
        {
          id: "claude-invalid-description",
          name: "Invalid",
          description: 42,
        },
        {
          id: "claude-invalid-resolved-model",
          name: "Invalid",
          resolvedModel: false,
        },
      ] as unknown as ClaudeModelCatalogEntry[]);
      await storage.cacheAgentModelCatalog("codex", [
        {
          id: "  gpt-latest  ",
          name: "  GPT Latest  ",
          description: "  Coding model  ",
          reasoningEfforts: ["minimal", "medium", "ultra"],
          reasoningOptions: [{
            effort: "medium",
            label: "  Balanced  ",
            description: "  Default choice  ",
          }],
          defaultReasoningEffort: "medium",
        },
        { id: "gpt-latest", name: "Duplicate" },
        {
          id: "gpt-invalid-effort",
          name: "Invalid",
          reasoningEfforts: ["impossible"],
        },
        {
          id: "gpt-invalid-option",
          name: "Invalid",
          reasoningOptions: [{ effort: "medium", label: "   " }],
        },
        {
          id: "gpt-invalid-description",
          name: "Invalid",
          description: 42,
        },
      ] as unknown as CodexModelCatalogEntry[]);

      expect(await storage.getAgentModelCatalogCache()).toMatchObject({
        claude: {
          models: [{
            id: "claude-opus-latest",
            resolvedModel: "claude-opus-20260701",
            name: "Claude Opus Latest",
            description: "Most capable",
            supportsEffort: true,
            supportedEffortLevels: ["low", "high"],
          }],
        },
        codex: {
          models: [{
            id: "gpt-latest",
            name: "GPT Latest",
            description: "Coding model",
            reasoningEfforts: ["minimal", "medium", "ultra"],
            reasoningOptions: [{
              effort: "medium",
              label: "Balanced",
              description: "Default choice",
            }],
            defaultReasoningEffort: "medium",
          }],
        },
      });
    });
  });

  test("retains valid models while replacing an invalid persisted timestamp", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "agent-model-catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          codex: {
            updatedAt: "not-a-date",
            models: [{
              id: "gpt-valid",
              name: "GPT Valid",
              reasoningEfforts: ["medium"],
            }],
          },
        }),
      );

      expect(await storage.getAgentModelCatalogCache()).toEqual({
        schemaVersion: 1,
        codex: {
          updatedAt: new Date(0).toISOString(),
          models: [{
            id: "gpt-valid",
            name: "GPT Valid",
            reasoningEfforts: ["medium"],
          }],
        },
      });
    });
  });

  test("rejects catalogues without any valid model", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(
        storage.cacheAgentModelCatalog(
          "claude",
          [{ id: "", name: "Invalid" }],
        ),
      ).rejects.toThrow("at least one valid model");
      await expect(
        storage.cacheAgentModelCatalog(
          "codex",
          [{
            id: "gpt-invalid",
            name: "Invalid",
            defaultReasoningEffort: "impossible",
          }] as unknown as CodexModelCatalogEntry[],
        ),
      ).rejects.toThrow("at least one valid model");
      await expect(
        storage.cacheAgentModelCatalog("cursor", [{
          platform: "grok",
          id: "wrong-provider",
          label: "Wrong provider",
        }] as AgentModel[]),
      ).rejects.toThrow("at least one valid model");
    });
  });

  test("serializes separate storage instances without losing either agent", async () => {
    await withTemporaryStorage(async (first, dataDir) => {
      const second = new StorageService(dataDir);
      await second.init();
      await Promise.all([
        first.cacheAgentModelCatalog("claude", [{
          id: "claude-opus-latest",
          name: "Claude Opus Latest",
        }]),
        second.cacheAgentModelCatalog("codex", [{
          id: "gpt-latest",
          name: "GPT Latest",
        }]),
      ]);

      expect(await first.getAgentModelCatalogCache()).toMatchObject({
        claude: { models: [{ id: "claude-opus-latest" }] },
        codex: { models: [{ id: "gpt-latest" }] },
      });
    });
  });

  test("recovers the mutation queue after a failed write", async () => {
    await withTemporaryStorage(async (storage) => {
      const internals = storage as unknown as {
        saveJson: (filePath: string, value: unknown) => Promise<void>;
      };
      const saveJson = internals.saveJson.bind(storage);
      let failNext = true;
      internals.saveJson = async (filePath, value) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected agent cache write failure");
        }
        await saveJson(filePath, value);
      };

      await expect(
        storage.cacheAgentModelCatalog("claude", [{
          id: "claude-failed",
          name: "Claude Failed",
        }]),
      ).rejects.toThrow("injected agent cache write failure");
      await expect(
        storage.cacheAgentModelCatalog("codex", [{
          id: "gpt-recovered",
          name: "GPT Recovered",
        }]),
      ).resolves.toMatchObject({
        codex: { models: [{ id: "gpt-recovered" }] },
      });
      expect(await storage.getAgentModelCatalogCache()).toEqual({
        schemaVersion: 1,
        codex: expect.objectContaining({
          models: [{ id: "gpt-recovered", name: "GPT Recovered" }],
        }),
      });
    });
  });

  test("a read concurrent with a write sees one coherent snapshot", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.cacheAgentModelCatalog("codex", [{
        id: "gpt-first",
        name: "GPT First",
      }]);

      const [, ...reads] = await Promise.all([
        storage.cacheAgentModelCatalog("codex", [{
          id: "gpt-second",
          name: "GPT Second",
        }]),
        ...Array.from({ length: 24 }, () =>
          storage.getAgentModelCatalogCache()
        ),
      ]);
      const final = await storage.getAgentModelCatalogCache();
      expect(final.codex?.models).toEqual([{
        id: "gpt-second",
        name: "GPT Second",
      }]);
      const coherentSnapshots: CodexModelCatalogEntry[][] = [
        [{ id: "gpt-first", name: "GPT First" }],
        [{ id: "gpt-second", name: "GPT Second" }],
      ];
      for (const read of reads) {
        if (!read.codex) throw new Error("Codex catalogue disappeared during write");
        expect(coherentSnapshots).toContainEqual(read.codex.models);
      }
    });
  });
});

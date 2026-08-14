import { describe, expect, mock, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { isPrMonitorSnapshot } from "@orkestrator/protocol/pr-monitor";
import {
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
} from "@orkestrator/protocol/agent-interactions";
import {
  __testing as commandTesting,
  createCommandRegistry,
  findKanbanTaskForEnvironment,
  getPrMonitorDetectionRequest,
  parsePrMonitorDetectionResponse,
  shutdownPrMonitorTracking,
  toClientEnvironment,
  type CommandContext,
} from "./commands.js";
import { StorageService } from "./storage.js";
import { ClaudeStatePollManager } from "./tmux.js";
import {
  NativeAgentService,
  nativeAgentSessionStorageKey,
} from "./native-agent-service.js";

/**
 * Registry-level coverage for the commands that back the backend-owned state
 * introduced with the change feed. These run against a real StorageService
 * because the argument coercion in the registry is exactly what decides whether
 * storage's own validation is reachable.
 */

async function withCommands<T>(
  run: (
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
    storage: StorageService,
    dataDir: string,
    commands: ReturnType<typeof createCommandRegistry>,
  ) => Promise<T>,
  options: {
    claudeStatePolls?: ClaudeStatePollManager;
    environment?: Record<string, unknown>;
    buildPipelines?: CommandContext["buildPipelines"];
    loopedReviews?: CommandContext["loopedReviews"];
    multiReviews?: CommandContext["multiReviews"];
    nativeAgents?: CommandContext["nativeAgents"];
    nativeAgentsFactory?: (storage: StorageService) => CommandContext["nativeAgents"];
    tabTeardown?: NonNullable<Parameters<typeof createCommandRegistry>[0]>["tabTeardown"];
  } = {},
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-state-sync-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "e1", name: "Env", projectId: "proj-1", status: "running",
    environmentType: "local", branch: "main", order: 0,
    containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
    networkAccessMode: "restricted", createdAt: new Date(0).toISOString(),
    ...options.environment,
  } as Parameters<StorageService["addEnvironment"]>[0]);
  const commands = createCommandRegistry({
    claudeStatePolls: options.claudeStatePolls,
    tabTeardown: options.tabTeardown,
  });
  const context = {
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    emit: () => undefined,
    storage,
    buildPipelines: options.buildPipelines,
    loopedReviews: options.loopedReviews,
    multiReviews: options.multiReviews,
    nativeAgents: options.nativeAgents ?? options.nativeAgentsFactory?.(storage),
  } as unknown as CommandContext;

  const invoke = async (command: string, args: Record<string, unknown>) => {
    const handler = commands.get(command);
    if (!handler) throw new Error(`Command not registered: ${command}`);
    return await handler(args, context);
  };

  try {
    return await run(invoke, storage, dataDir, commands);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const KEY = "claude env-e1:tab-1";

/** `updateGlobalConfig` replaces the whole block, so edit a loaded copy. */
async function setOpenCodeModelProviders(
  storage: StorageService,
  openCodeModelProviders: string[],
): Promise<void> {
  const config = await storage.loadConfig();
  await storage.updateGlobalConfig({
    ...config.global,
    openCodeModelProviders,
  });
}

describe("create-environment agent preference command", () => {
  test("persists a successful agent-enabled create selection without replacing repository settings", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.updateRepositoryConfig("proj-1", {
        defaultBranch: "develop",
        prBaseBranch: "release",
        lastEnvironmentType: "local",
      });

      await invoke("remember_environment_agent_selection", {
        projectId: "proj-1",
        platform: "codex",
        mode: "terminal",
        model: "gpt-remembered",
        reasoningEffort: "xhigh",
      });

      expect(await storage.getRepositoryConfig("proj-1")).toEqual({
        defaultBranch: "develop",
        prBaseBranch: "release",
        lastEnvironmentType: "local",
        lastEnvironmentAgentSelection: {
          platform: "codex",
          mode: "terminal",
          model: "gpt-remembered",
          reasoningEffort: "xhigh",
        },
      });

      await invoke("update_environment_agent_settings", {
        environmentId: "e1",
        defaultAgent: "claude",
        claudeMode: "native",
        claudeNativeBackend: null,
        opencodeMode: null,
        codexMode: null,
        pendingAgentLaunch: false,
      });

      expect((await storage.getRepositoryConfig("proj-1"))
        .lastEnvironmentAgentSelection?.platform).toBe("codex");
    });
  });

  test("records provider-default model and reasoning choices as omitted fields", async () => {
    await withCommands(async (invoke, storage) => {
      await invoke("remember_environment_agent_selection", {
        projectId: "proj-1",
        platform: "opencode",
        mode: "native",
      });

      expect((await storage.getRepositoryConfig("proj-1"))
        .lastEnvironmentAgentSelection).toEqual({
          platform: "opencode",
          mode: "native",
        });
    });
  });

  test("preserves backend-owned create state when stale repository settings are saved", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.updateRepositoryConfig("proj-1", {
        defaultBranch: "main",
        prBaseBranch: "main",
        lastEnvironmentType: "local",
        lastEnvironmentAgentSelection: {
          platform: "codex",
          mode: "terminal",
          model: "gpt-current",
        },
      });

      await invoke("update_repository_config", {
        projectId: "proj-1",
        repoConfig: {
          defaultBranch: "develop",
          prBaseBranch: "release",
          lastEnvironmentType: "containerized",
          lastEnvironmentAgentSelection: {
            platform: "claude",
            mode: "native",
            model: "stale-model",
          },
        },
      });

      expect(await storage.getRepositoryConfig("proj-1")).toEqual({
        defaultBranch: "develop",
        prBaseBranch: "release",
        lastEnvironmentType: "local",
        lastEnvironmentAgentSelection: {
          platform: "codex",
          mode: "terminal",
          model: "gpt-current",
        },
      });
    });
  });

  test("serializes concurrent repository settings and remembered-selection writes", async () => {
    await withCommands(async (_invoke, storage) => {
      await storage.updateRepositoryConfig("proj-1", {
        defaultBranch: "main",
        prBaseBranch: "main",
        lastEnvironmentType: "local",
      });

      await Promise.all([
        storage.updateRepositorySettings("proj-1", {
          defaultBranch: "develop",
          prBaseBranch: "release",
        }),
        storage.patchRepositoryConfig("proj-1", {
          lastEnvironmentAgentSelection: {
            platform: "codex",
            mode: "terminal",
            model: "gpt-concurrent",
          },
        }),
      ]);

      expect(await storage.getRepositoryConfig("proj-1")).toEqual({
        defaultBranch: "develop",
        prBaseBranch: "release",
        lastEnvironmentType: "local",
        lastEnvironmentAgentSelection: {
          platform: "codex",
          mode: "terminal",
          model: "gpt-concurrent",
        },
      });
    });
  });

  test("rejects malformed remembered agent selections", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("remember_environment_agent_selection", {
        projectId: "proj-1",
        platform: "codex",
        mode: "background",
      })).rejects.toThrow("Expected mode to be terminal or native");
      await expect(invoke("remember_environment_agent_selection", {
        projectId: "proj-1",
        platform: "unknown",
        mode: "native",
      })).rejects.toThrow("Expected platform to be a supported agent platform");
    });
  });
});

describe("native agent model catalogue command", () => {
  test("normalizes provider catalogues and filters OpenCode to the configured providers", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.updateEnvironment("e1", {
        claudeModelCatalog: {
          environmentId: "e1",
          models: [{
            id: "claude-opus",
            name: "Opus",
            supportedEffortLevels: ["low", "high"],
          }],
          source: "sdk",
          fetchedAt: new Date(0).toISOString(),
          stale: false,
        },
      });
      await storage.cacheAgentModelCatalog("codex", [{
        id: "gpt-codex",
        name: "Codex",
        reasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "high",
      }]);
      await storage.cacheAgentModelCatalog("cursor", [{
        platform: "cursor",
        id: "composer-cached",
        label: "Composer Cached",
        providerLabel: "Cursor",
        supportsSpeed: true,
        supportsMode: true,
      }]);
      await storage.cacheAgentModelCatalog("grok", [{
        platform: "grok",
        id: "grok-cached",
        label: "Grok Cached",
        providerLabel: "Grok",
        supportsMode: true,
      }]);
      await storage.cacheOpenCodeModelCatalog("proj-1", [
        { id: "opencode/a", name: "OpenCode A", provider: "opencode" },
        { id: "opencode-go/b", name: "OpenCode Go B", provider: "opencode-go" },
        { id: "openrouter/c", name: "OpenRouter C", provider: "openrouter" },
      ]);

      // Both picker-facing reads filter, so a cache written before the
      // allowlist changed cannot leak an excluded provider to the renderer.
      const cached = await invoke("get_opencode_model_catalog_cache", {
        projectId: "proj-1",
      }) as { models: Array<{ provider: string }> };
      expect(cached.models.map((model) => model.provider)).toEqual([
        "opencode-go",
        "opencode",
      ]);

      const models = await invoke("get_native_agent_model_catalog", {
        environmentId: "e1",
      }) as Array<Record<string, unknown>>;

      expect(models.map((model) => model.id)).toEqual([
        "claude-opus",
        "gpt-codex",
        "opencode-go/b",
        "opencode/a",
        "composer-cached",
        "grok-cached",
      ]);
      expect(models.slice(2, 4).map((model) => model.providerLabel)).toEqual([
        "OpenCode/opencode-go",
        "OpenCode/opencode",
      ]);

      // Storage stays the complete durable record; only the reads narrow.
      const rewritten = await invoke("cache_opencode_model_catalog", {
        projectId: "proj-1",
        models: [
          { id: "opencode/a", name: "OpenCode A", provider: "opencode" },
          { id: "hpc-ai/b", name: "HPC B", provider: "hpc-ai" },
        ],
      }) as { models: Array<{ provider: string }> };
      expect(rewritten.models.map((model) => model.provider)).toEqual([
        "hpc-ai",
        "opencode",
      ]);
    });
  });

  test("widens the catalogue when a provider is added to the configured list", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.cacheOpenCodeModelCatalog("proj-1", [
        { id: "opencode/a", name: "OpenCode A", provider: "opencode" },
        { id: "openrouter/c", name: "OpenRouter C", provider: "openrouter" },
      ]);
      await setOpenCodeModelProviders(storage, [
        "opencode",
        "opencode-go",
        "openrouter",
      ]);

      const cached = await invoke("get_opencode_model_catalog_cache", {
        projectId: "proj-1",
      }) as { models: Array<{ provider: string }> };
      expect(cached.models.map((model) => model.provider)).toEqual([
        "opencode",
        "openrouter",
      ]);

      const models = await invoke("get_native_agent_model_catalog", {
        environmentId: "e1",
      }) as Array<Record<string, unknown>>;
      expect(models.map((model) => model.id)).toEqual([
        "opencode/a",
        "openrouter/c",
      ]);
    });
  });

  test("offers every provider when the configured list is emptied", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.cacheOpenCodeModelCatalog("proj-1", [
        { id: "opencode/a", name: "OpenCode A", provider: "opencode" },
        { id: "hpc-ai/b", name: "HPC B", provider: "hpc-ai" },
      ]);
      await setOpenCodeModelProviders(storage, []);

      const models = await invoke("get_native_agent_model_catalog", {
        environmentId: "e1",
      }) as Array<Record<string, unknown>>;
      expect(models.map((model) => model.id)).toEqual([
        "hpc-ai/b",
        "opencode/a",
      ]);
    });
  });
});

describe("bridge readiness command", () => {
  test("coalesces waiters and returns the authoritative ready endpoint", async () => {
    await withCommands(async (invoke, storage, _dataDir, commands) => {
      const start = mock(async () => ({ port: 4321, authToken: "bridge-token" }));
      commands.set("start_local_codex_server_cmd", start);
      const first = invoke("await_bridge_ready", {
        environmentId: "e1",
        agent: "codex",
        timeoutMs: 2_000,
      });
      const second = invoke("await_bridge_ready", {
        environmentId: "e1",
        agent: "codex",
        timeoutMs: 2_000,
      });
      setTimeout(() => {
        void storage.updateEnvironment("e1", {
          status: "running",
          setupPhase: "ready",
        });
      }, 10);

      await expect(Promise.all([first, second])).resolves.toEqual([
        { status: "ready", port: 4321, authToken: "bridge-token" },
        { status: "ready", port: 4321, authToken: "bridge-token" },
      ]);
      expect(start).toHaveBeenCalledTimes(1);
    }, {
      environment: {
        status: "creating",
        setupPhase: "running",
        worktreePath: "/tmp/ready-worktree",
        createdAt: new Date().toISOString(),
      },
    });
  });

  test("gives coalesced callers independent deadlines while sharing startup", async () => {
    await withCommands(async (invoke, storage, _dataDir, commands) => {
      const start = mock(async () => ({ port: 4321, authToken: "bridge-token" }));
      commands.set("start_local_codex_server_cmd", start);
      const short = invoke("await_bridge_ready", {
        environmentId: "e1", agent: "codex", timeoutMs: 1_000,
      });
      const long = invoke("await_bridge_ready", {
        environmentId: "e1", agent: "codex", timeoutMs: 2_500,
      });
      setTimeout(() => {
        void storage.updateEnvironment("e1", { status: "running", setupPhase: "ready" });
      }, 1_200);

      await expect(short).resolves.toEqual({
        status: "timed-out",
        error: {
          message: "codex bridge did not become ready before the caller deadline",
          retryable: true,
          retryAfterMs: 1_000,
        },
      });
      await expect(long).resolves.toEqual({
        status: "ready", port: 4321, authToken: "bridge-token",
      });
      expect(start).toHaveBeenCalledTimes(1);
    }, {
      environment: {
        status: "creating", setupPhase: "pending",
        worktreePath: "/tmp/ready-worktree",
      },
    });
  }, 4_000);

  test("extends the shared probe so a late caller receives its full deadline", async () => {
    await withCommands(async (invoke, storage, _dataDir, commands) => {
      const start = mock(async () => ({ port: 4321, authToken: "bridge-token" }));
      commands.set("start_local_codex_server_cmd", start);

      const first = invoke("await_bridge_ready", {
        environmentId: "e1", agent: "codex", timeoutMs: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      const late = invoke("await_bridge_ready", {
        environmentId: "e1", agent: "codex", timeoutMs: 1_000,
      });
      setTimeout(() => {
        void storage.updateEnvironment("e1", { status: "running", setupPhase: "ready" });
      }, 450);

      await expect(first).resolves.toEqual({
        status: "timed-out",
        error: {
          message: "codex bridge did not become ready before the caller deadline",
          retryable: true,
          retryAfterMs: 1_000,
        },
      });
      await expect(late).resolves.toEqual({
        status: "ready", port: 4321, authToken: "bridge-token",
      });
      expect(start).toHaveBeenCalledTimes(1);
    }, {
      environment: {
        status: "creating", setupPhase: "pending",
        worktreePath: "/tmp/ready-worktree",
      },
    });
  }, 4_000);

  test("fails closed for missing, failed, and incomplete bridge state", async () => {
    await withCommands(async (invoke, storage, _dataDir, commands) => {
      await expect(invoke("await_bridge_ready", {
        environmentId: "missing",
        agent: "codex",
        timeoutMs: 1_000,
      })).resolves.toEqual({
        status: "failed",
        error: { message: "Environment not found", retryable: false },
      });

      await storage.updateEnvironment("e1", { setupPhase: "failed" });
      await expect(invoke("await_bridge_ready", {
        environmentId: "e1",
        agent: "codex",
        timeoutMs: 1_000,
      })).resolves.toEqual({
        status: "failed",
        error: { message: "Environment setup failed", retryable: false },
      });

      await storage.updateEnvironment("e1", { setupPhase: "ready" });
      commands.set("start_local_codex_server_cmd", async () => ({ port: 4321 }));
      await expect(invoke("await_bridge_ready", {
        environmentId: "e1",
        agent: "codex",
        timeoutMs: 1_000,
      })).resolves.toEqual({
        status: "failed",
        error: {
          message: "codex bridge returned an incomplete ready endpoint",
          retryable: false,
        },
      });
    }, {
      environment: {
        status: "running",
        setupPhase: "ready",
        worktreePath: "/tmp/ready-worktree",
        createdAt: new Date().toISOString(),
      },
    });
  });

  test("observes deletion while an environment is still starting", async () => {
    await withCommands(async (invoke, storage) => {
      const waiting = invoke("await_bridge_ready", {
        environmentId: "e1",
        agent: "codex",
        timeoutMs: 2_000,
      });
      setTimeout(() => {
        void storage.removeEnvironment("e1");
      }, 10);
      await expect(waiting).resolves.toEqual({
        status: "failed",
        error: { message: "Environment was deleted", retryable: false },
      });
    }, {
      environment: {
        status: "creating",
        setupPhase: "running",
        createdAt: new Date().toISOString(),
      },
    });
  });

  test("returns a structured durable-window timeout instead of an error string", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("await_bridge_ready", {
        environmentId: "e1",
        agent: "codex",
        timeoutMs: 1_000,
      })).resolves.toEqual({
        status: "timed-out",
        error: {
          message: "codex bridge did not become ready before the caller deadline",
          retryable: true,
          retryAfterMs: 1_000,
        },
      });
    }, {
      environment: {
        status: "creating",
        setupPhase: "running",
        createdAt: new Date(0).toISOString(),
      },
    });
  });

  test("keeps retryable local startup races inside the durable wait", async () => {
    await withCommands(async (invoke, _storage, _dataDir, commands) => {
      const startedAt = Date.now();
      let clockReads = 0;
      const now = spyOn(Date, "now").mockImplementation(
        () => clockReads++ === 0 ? startedAt : startedAt + 1_000,
      );
      commands.set("start_local_codex_server_cmd", async () => {
        throw { message: "not ready", retryable: true, retryAfterMs: 500 };
      });

      try {
        await expect(invoke("await_bridge_ready", {
          environmentId: "e1",
          agent: "codex",
          timeoutMs: 1_000,
        })).resolves.toEqual({
          status: "timed-out",
          error: {
            message: "codex bridge did not become ready before the caller deadline",
            retryable: true,
            retryAfterMs: 1_000,
          },
        });
      } finally {
        now.mockRestore();
      }
    }, {
      environment: {
        status: "running",
        setupPhase: "ready",
        worktreePath: "/tmp/ready-worktree",
        createdAt: new Date().toISOString(),
      },
    });
  });

  test("validates arguments and rechecks environment state after a retryable start failure", async () => {
    await withCommands(async (invoke, storage, _dataDir, commands) => {
      await expect(invoke("await_bridge_ready", {
        environmentId: "e1", agent: "unknown", timeoutMs: 1_000,
      })).rejects.toThrow("agent must be one of");
      await expect(invoke("await_bridge_ready", {
        environmentId: "e1", agent: "codex", timeoutMs: 999,
      })).rejects.toThrow("between 1000 and 120000");
      await expect(invoke("await_bridge_ready", {
        environmentId: "e1", agent: "codex", timeoutMs: 1_000, extra: true,
      })).rejects.toThrow("Unexpected arguments field");

      commands.set("start_local_codex_server_cmd", async () => {
        await storage.updateEnvironment("e1", { status: "stopped" });
        throw { message: "not ready", retryable: true, retryAfterMs: 0 };
      });
      await expect(invoke("await_bridge_ready", {
        environmentId: "e1", agent: "codex", timeoutMs: 1_000,
      })).resolves.toEqual({
        status: "failed",
        error: { message: "Environment is not running", retryable: false },
      });
    }, {
      environment: {
        status: "running", setupPhase: "ready", worktreePath: "/tmp/ready-worktree",
      },
    });
  });
});

describe("initial prompt attachment command", () => {
  test("writes a validated local batch in an isolated request directory", async () => {
    const worktreePath = path.join(tmpdir(), `ork-attachments-${crypto.randomUUID()}`);
    await fs.mkdir(worktreePath, { recursive: true });
    try {
      await withCommands(async (invoke) => {
        const result = await invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [
            { id: "one", name: "screen shot.png", base64Data: "QQ==" },
            { id: "two", name: "screen-shot.png", base64Data: "Qg==" },
          ],
        });
        expect(result).toEqual([
          { name: "screen-shot.png", path: expect.any(String) },
          { name: "screen-shot-2.png", path: expect.any(String) },
        ]);
        const saved = result as Array<{ name: string; path: string }>;
        const canonicalWorktree = await fs.realpath(worktreePath);
        expect(path.dirname(saved[0]!.path)).toBe(path.dirname(saved[1]!.path));
        expect(path.dirname(saved[0]!.path)).toStartWith(
          path.join(canonicalWorktree, ".orkestrator/initial-prompt/"),
        );
        await expect(fs.readFile(saved[0]!.path, "utf8")).resolves.toBe("A");
        await expect(fs.readFile(saved[1]!.path, "utf8")).resolves.toBe("B");

        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [
            { id: "first", name: "cleanup.png", base64Data: "Qw==" },
            { id: "broken", base64Data: "RA==" },
          ],
        })).rejects.toThrow("attachment.name");
        const batchDirectories = await fs.readdir(path.join(
          worktreePath,
          ".orkestrator/initial-prompt",
        ));
        expect(batchDirectories).toHaveLength(1);
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("rejects symlink ancestors without modifying their external target", async () => {
    const worktreePath = path.join(tmpdir(), `ork-attachments-worktree-${crypto.randomUUID()}`);
    const externalPath = path.join(tmpdir(), `ork-attachments-external-${crypto.randomUUID()}`);
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.mkdir(externalPath, { recursive: true });
    await fs.symlink(externalPath, path.join(worktreePath, ".orkestrator"));
    try {
      await withCommands(async (invoke) => {
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [{ id: "one", name: "image.png", base64Data: "QQ==" }],
        })).rejects.toThrow("symlink or non-directory ancestor");
        expect(await fs.readdir(externalPath)).toEqual([]);
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
      await fs.rm(externalPath, { recursive: true, force: true });
    }
  });

  test("keeps concurrent same-name batches isolated and validates before writing", async () => {
    const worktreePath = path.join(tmpdir(), `ork-attachments-concurrent-${crypto.randomUUID()}`);
    await fs.mkdir(worktreePath, { recursive: true });
    try {
      await withCommands(async (invoke) => {
        const [first, second] = await Promise.all([
          invoke("write_initial_prompt_attachments", {
            environmentId: "e1",
            attachments: [{ id: "one", name: "same.png", base64Data: "QQ==" }],
          }),
          invoke("write_initial_prompt_attachments", {
            environmentId: "e1",
            attachments: [{ id: "two", name: "same.png", base64Data: "Qg==" }],
          }),
        ]) as [Array<{ path: string }>, Array<{ path: string }>];
        expect(first[0]!.path).not.toBe(second[0]!.path);
        await expect(fs.readFile(first[0]!.path, "utf8")).resolves.toBe("A");
        await expect(fs.readFile(second[0]!.path, "utf8")).resolves.toBe("B");

        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [
            { id: "valid", name: "never-written.png", base64Data: "Qw==" },
            { id: "invalid", name: "bad.png", base64Data: "not base64" },
          ],
        })).rejects.toThrow("not valid base64");
        const allFiles = await fs.readdir(
          path.join(worktreePath, ".orkestrator/initial-prompt"),
          { recursive: true },
        );
        expect(allFiles).not.toContain("never-written.png");
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("writes container batches through stdin and cleans its directory after partial failure", async () => {
    const fakeRoot = await fs.mkdtemp(path.join(tmpdir(), "ork-attachment-docker-"));
    const binDir = path.join(fakeRoot, "bin");
    const dockerLog = path.join(fakeRoot, "docker.log");
    const payloadLog = path.join(fakeRoot, "payload.log");
    const writeCount = path.join(fakeRoot, "write-count");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "docker"), `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_ATTACHMENT_DOCKER_LOG"
case "$*" in
  *"rm -rf"*) exit 9 ;;
esac
if [ "$1" = "exec" ] && [ "$2" = "-i" ]; then
  count=0
  [ ! -f "$FAKE_ATTACHMENT_WRITE_COUNT" ] || count="$(cat "$FAKE_ATTACHMENT_WRITE_COUNT")"
  count=$((count + 1))
  printf '%s' "$count" > "$FAKE_ATTACHMENT_WRITE_COUNT"
  cat >> "$FAKE_ATTACHMENT_PAYLOAD_LOG"
  [ "$count" -lt 3 ] || exit 7
fi
exit 0
`);
    await fs.chmod(path.join(binDir, "docker"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.FAKE_ATTACHMENT_DOCKER_LOG = dockerLog;
    process.env.FAKE_ATTACHMENT_PAYLOAD_LOG = payloadLog;
    process.env.FAKE_ATTACHMENT_WRITE_COUNT = writeCount;
    try {
      await withCommands(async (invoke) => {
        const saved = await invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          // Whitespace is stripped before the payload reaches `base64 -d`
          // rather than relying on the decoder to tolerate it.
          attachments: [{ id: "one", name: "container.png", base64Data: "Q\n Q=\t=" }],
        }) as Array<{ name: string; path: string }>;
        expect(saved).toEqual([{
          name: "container.png",
          path: expect.stringMatching(
            /^\/workspace\/\.orkestrator\/initial-prompt\/[0-9a-f-]+\/container\.png$/,
          ),
        }]);
        await expect(fs.readFile(payloadLog, "utf8")).resolves.toBe("QQ==");
        // Old batches are pruned inside the container before a new one lands.
        await expect(fs.readFile(dockerLog, "utf8")).resolves.toContain("batches.slice(Number(keep))");

        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [
            { id: "two", name: "first.png", base64Data: "Qg==" },
            { id: "three", name: "second.png", base64Data: "Qw==" },
          ],
        })).rejects.toThrow("docker exec exited with 7");
        const calls = await fs.readFile(dockerLog, "utf8");
        expect(calls).toContain("process.chdir(current)");
        expect(calls).toContain("fs.linkSync(temp, filename)");
      }, {
        environment: {
          environmentType: "containerized",
          containerId: "container-1",
          worktreePath: null,
        },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      delete process.env.FAKE_ATTACHMENT_DOCKER_LOG;
      delete process.env.FAKE_ATTACHMENT_PAYLOAD_LOG;
      delete process.env.FAKE_ATTACHMENT_WRITE_COUNT;
      await fs.rm(fakeRoot, { recursive: true, force: true });
    }
  });

  test("rejects attachment count, identity, and unavailable environment targets", async () => {
    await withCommands(async (invoke, storage) => {
      await expect(invoke("write_initial_prompt_attachments", {
        environmentId: "e1",
        attachments: [],
      })).rejects.toThrow("between 1 and 20");
      await expect(invoke("write_initial_prompt_attachments", {
        environmentId: "e1",
        attachments: [{ id: "", name: "bad.png", base64Data: "QQ==" }],
      })).rejects.toThrow("attachment.id");
      await expect(invoke("write_initial_prompt_attachments", {
        environmentId: "missing",
        attachments: [{ id: "one", name: "bad.png", base64Data: "QQ==" }],
      })).rejects.toThrow("Environment not found");

      await storage.updateEnvironment("e1", {
        environmentType: "containerized",
        containerId: null,
        worktreePath: undefined,
      });
      await expect(invoke("write_initial_prompt_attachments", {
        environmentId: "e1",
        attachments: [{ id: "one", name: "bad.png", base64Data: "QQ==" }],
      })).rejects.toThrow("Container environment is not ready");
    }, { environment: { worktreePath: "/tmp/attachment-validation-worktree" } });
  });

  test("accepts twenty attachments and rejects the twenty-first", async () => {
    const worktreePath = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-count-"));
    try {
      await withCommands(async (invoke) => {
        const batch = (count: number) => Array.from({ length: count }, (_, index) => ({
          id: `id-${index}`,
          name: `image-${index}.png`,
          base64Data: "QQ==",
        }));
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: batch(20),
        })).resolves.toHaveLength(20);
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: batch(21),
        })).rejects.toThrow("between 1 and 20");
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("rejects an aggregate payload above the total limit and an empty one", async () => {
    const worktreePath = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-size-"));
    try {
      await withCommands(async (invoke) => {
        // Each item is inside the 8MB per-payload cap; together they are not.
        const oversized = Buffer.alloc(7 * 1024 * 1024).toString("base64");
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: Array.from({ length: 6 }, (_, index) => ({
            id: `id-${index}`,
            name: `image-${index}.png`,
            base64Data: oversized,
          })),
        })).rejects.toThrow("total limit");

        // 0 % 4 === 0, so an empty payload used to pass every structural check
        // and produce a 0-byte file still advertised to the agent.
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [{ id: "one", name: "empty.png", base64Data: "" }],
        })).rejects.toThrow("must not be empty");
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [{ id: "one", name: "odd.png", base64Data: "QQQ" }],
        })).rejects.toThrow("not valid base64");
        await expect(fs.readdir(path.join(worktreePath, ".orkestrator"))).rejects.toThrow("ENOENT");
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("allocates a safe unique name for every hostile or colliding attachment name", async () => {
    const worktreePath = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-names-"));
    try {
      await withCommands(async (invoke) => {
        const saved = await invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [
            { id: "a", name: ".", base64Data: "QQ==" },
            { id: "b", name: "..", base64Data: "Qg==" },
            { id: "c", name: "   ", base64Data: "Qw==" },
            { id: "d", name: "shot.png", base64Data: "RA==" },
            { id: "e", name: "shot.png", base64Data: "RQ==" },
            { id: "f", name: "shot.png", base64Data: "Rg==" },
            { id: "g", name: "../../etc/passwd", base64Data: "Rw==" },
          ],
        }) as Array<{ name: string; path: string }>;

        expect(saved.map(({ name }) => name)).toEqual([
          "clipboard.png",
          "clipboard-2.png",
          "clipboard-3.png",
          "shot.png",
          "shot-2.png",
          "shot-3.png",
          // Dots survive sanitization; separators do not, so no traversal
          // segment can reach the filesystem.
          "..-..-etc-passwd",
        ]);
        const batchDirectory = path.dirname(saved[0]!.path);
        expect(new Set(saved.map(({ path: saved }) => path.dirname(saved)))).toEqual(
          new Set([batchDirectory]),
        );
        // A successful batch owns exactly its own directory: nothing is written
        // beside it, and nothing is left in the shared parent.
        expect((await fs.readdir(batchDirectory)).sort()).toEqual(
          saved.map(({ name }) => name).sort(),
        );
        expect(await fs.readdir(path.dirname(batchDirectory))).toEqual([
          path.basename(batchDirectory),
        ]);
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("bounds long attachment names while preserving unique suffixes", async () => {
    const worktreePath = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-long-names-"));
    try {
      await withCommands(async (invoke) => {
        const longName = `${"a".repeat(300)}.png`;
        const saved = await invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [
            { id: "a", name: longName, base64Data: "QQ==" },
            { id: "b", name: longName, base64Data: "Qg==" },
          ],
        }) as Array<{ name: string; path: string }>;
        expect(saved[0]!.name.length).toBeLessThanOrEqual(128);
        expect(saved[1]!.name.length).toBeLessThanOrEqual(132);
        expect(saved[1]!.name).toEndWith("-2");
        await expect(fs.readFile(saved[0]!.path, "utf8")).resolves.toBe("A");
        await expect(fs.readFile(saved[1]!.path, "utf8")).resolves.toBe("B");
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("prunes local batch directories beyond the retention bound", async () => {
    const worktreePath = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-prune-"));
    const batchesDirectory = path.join(worktreePath, ".orkestrator/initial-prompt");
    try {
      await withCommands(async (invoke) => {
        // Sequential, so each directory gets a distinct, increasing mtime.
        const batches: string[] = [];
        for (let index = 0; index < 13; index += 1) {
          const saved = await invoke("write_initial_prompt_attachments", {
            environmentId: "e1",
            attachments: [{ id: `id-${index}`, name: "shot.png", base64Data: "QQ==" }],
          }) as Array<{ path: string }>;
          batches.push(path.basename(path.dirname(saved[0]!.path)));
        }

        const remaining = await fs.readdir(batchesDirectory);
        expect(remaining).toHaveLength(10);
        expect(new Set(remaining)).toEqual(new Set(batches.slice(-10)));
      }, { environment: { worktreePath } });
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("does not prune through a staging-directory replacement race", async () => {
    const worktreePath = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-prune-race-"));
    const staging = path.join(worktreePath, ".orkestrator/initial-prompt");
    const displaced = path.join(worktreePath, ".orkestrator/initial-prompt-displaced");
    const external = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-prune-external-"));
    await fs.mkdir(staging, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await fs.mkdir(path.join(external, `sentinel-${index}`));
    }
    const canonicalStaging = await fs.realpath(staging);
    const realLstat = fs.lstat.bind(fs);
    let reads = 0;
    const lstatSpy = spyOn(fs, "lstat").mockImplementation((async (target: string, ...rest: unknown[]) => {
      const stats = await realLstat(target as never, ...rest as never[]);
      if (target === canonicalStaging && ++reads === 2) {
        await fs.rename(staging, displaced);
        await fs.symlink(external, staging);
      }
      return stats;
    }) as typeof fs.lstat);
    try {
      await withCommands(async (invoke) => {
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [{ id: "one", name: "shot.png", base64Data: "QQ==" }],
        })).rejects.toThrow("symlink or non-directory ancestor");
        expect(await fs.readdir(external)).toHaveLength(12);
      }, { environment: { worktreePath } });
    } finally {
      lstatSpy.mockRestore();
      await fs.rm(worktreePath, { recursive: true, force: true });
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  test("removes the whole local batch and rethrows the original mid-batch failure", async () => {
    const worktreePath = await fs.mkdtemp(path.join(tmpdir(), "ork-attachments-partial-"));
    const batchesDirectory = path.join(worktreePath, ".orkestrator/initial-prompt");
    const realRealpath = fs.realpath.bind(fs);
    const readsByBatch = new Map<string, number>();
    let failNextCleanupRoot = false;
    let simulateCleanupFailure = false;
    const realpathSpy = spyOn(fs, "realpath").mockImplementation((async (target: string, ...rest: unknown[]) => {
      if (target === worktreePath && failNextCleanupRoot) {
        failNextCleanupRoot = false;
        throw new Error("cleanup exploded");
      }
      if (typeof target === "string" && /initial-prompt\/[0-9a-f-]+$/.test(target)) {
        const reads = (readsByBatch.get(target) ?? 0) + 1;
        readsByBatch.set(target, reads);
        if (reads > 1) {
          failNextCleanupRoot = simulateCleanupFailure;
          throw new Error("simulated attachment write failure");
        }
      }
      return realRealpath(target as never, ...rest as never[]);
    }) as typeof fs.realpath);
    try {
      await withCommands(async (invoke) => {
        const batch = {
          environmentId: "e1",
          attachments: [
            { id: "one", name: "first.png", base64Data: "QQ==" },
            { id: "two", name: "second.png", base64Data: "Qg==" },
          ],
        };
        await expect(invoke("write_initial_prompt_attachments", batch))
          .rejects.toThrow("simulated attachment write failure");
        // The first item was already on disk; the batch directory goes with it.
        expect(await fs.readdir(batchesDirectory)).toEqual([]);

        // A cleanup that itself fails must not replace the failure the caller
        // is being told about.
        simulateCleanupFailure = true;
        await expect(invoke("write_initial_prompt_attachments", batch))
          .rejects.toThrow("simulated attachment write failure");
      }, { environment: { worktreePath } });
    } finally {
      realpathSpy.mockRestore();
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  test("surfaces container mkdir and spawn failures without writing anything", async () => {
    const fakeRoot = await fs.mkdtemp(path.join(tmpdir(), "ork-attachment-docker-fail-"));
    const binDir = path.join(fakeRoot, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "docker"), `#!/bin/sh
case "$*" in
  *"process.chdir(current)"*) echo "mkdir refused" >&2; exit 3 ;;
esac
exit 0
`);
    await fs.chmod(path.join(binDir, "docker"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await withCommands(async (invoke) => {
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [{ id: "one", name: "container.png", base64Data: "QQ==" }],
        })).rejects.toThrow("docker exec exited with 3");
      }, {
        environment: {
          environmentType: "containerized",
          containerId: "container-1",
          worktreePath: null,
        },
      });

      // A docker binary that cannot be spawned at all reaches the child "error"
      // listener rather than the exit listener.
      await fs.rm(path.join(binDir, "docker"));
      await withCommands(async (invoke) => {
        await expect(invoke("write_initial_prompt_attachments", {
          environmentId: "e1",
          attachments: [{ id: "one", name: "container.png", base64Data: "QQ==" }],
        })).rejects.toThrow();
      }, {
        environment: {
          environmentType: "containerized",
          containerId: "container-1",
          worktreePath: null,
        },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(fakeRoot, { recursive: true, force: true });
    }
  });
});

describe("container attachment confinement helpers", () => {
  const runHelper = async (
    script: string,
    args: string[],
    stdin = "",
  ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const child = spawn(process.execPath, ["-e", script, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
    child.stdin.end(stdin);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return { code, stdout, stderr };
  };

  const spawnReadyHelper = async (script: string, args: string[]) => {
    const child = spawn(process.execPath, ["-e", script, ...args, "READY"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes("READY\n")) resolve();
      });
      child.once("exit", (code) => reject(new Error(`helper exited before ready: ${code}`)));
    });
    return child;
  };

  test("rejects symlink ancestors and never follows a final symlink", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "ork-container-helper-root-"));
    const external = await fs.mkdtemp(path.join(tmpdir(), "ork-container-helper-external-"));
    try {
      await fs.symlink(external, path.join(root, "stage"));
      const ancestor = await runHelper(
        commandTesting.CONTAINER_PINNED_ATTACHMENT_WRITE,
        [root, "stage/batch", "image.png", "1"],
        "QQ==",
      );
      expect(ancestor.code).not.toBe(0);
      expect(await fs.readdir(external)).toEqual([]);

      await fs.rm(path.join(root, "stage"));
      await fs.mkdir(path.join(root, "stage/batch"), { recursive: true });
      const sentinel = path.join(external, "sentinel");
      await fs.writeFile(sentinel, "outside");
      await fs.symlink(sentinel, path.join(root, "stage/batch/image.png"));
      const finalSymlink = await runHelper(
        commandTesting.CONTAINER_PINNED_ATTACHMENT_WRITE,
        [root, "stage/batch", "image.png", "1"],
        "QQ==",
      );
      expect(finalSymlink.code).not.toBe(0);
      await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("outside");

      await fs.rm(path.join(root, "stage/batch/image.png"));
      const written = await runHelper(
        commandTesting.CONTAINER_PINNED_ATTACHMENT_WRITE,
        [root, "stage/batch", "image.png", "1"],
        "QQ==",
      );
      expect(written.code).toBe(0);
      await expect(fs.readFile(path.join(root, "stage/batch/image.png"), "utf8"))
        .resolves.toBe("A");
      expect(await fs.readdir(path.join(root, "stage/batch"))).toEqual(["image.png"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  test("keeps a write inside its pinned directory during ancestor replacement", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "ork-container-helper-race-"));
    const external = await fs.mkdtemp(path.join(tmpdir(), "ork-container-helper-race-external-"));
    const displaced = path.join(root, "stage-original");
    await fs.mkdir(path.join(root, "stage/batch"), { recursive: true });
    await fs.mkdir(path.join(external, "batch"));
    try {
      const child = await spawnReadyHelper(
        commandTesting.CONTAINER_PINNED_ATTACHMENT_WRITE,
        [root, "stage/batch", "image.png", "1"],
      );
      await fs.rename(path.join(root, "stage"), displaced);
      await fs.symlink(external, path.join(root, "stage"));
      child.stdin.end("QQ==");
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(code).toBe(0);
      await expect(fs.readFile(path.join(displaced, "batch/image.png"), "utf8"))
        .resolves.toBe("A");
      expect(await fs.readdir(path.join(external, "batch"))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  test("keeps recursive cleanup confined during ancestor replacement", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "ork-container-cleanup-race-"));
    const external = await fs.mkdtemp(path.join(tmpdir(), "ork-container-cleanup-external-"));
    const displaced = path.join(root, "stage-original");
    await fs.mkdir(path.join(root, "stage/batch"), { recursive: true });
    await fs.writeFile(path.join(root, "stage/batch/inside"), "inside");
    await fs.mkdir(path.join(external, "batch"));
    await fs.writeFile(path.join(external, "batch/sentinel"), "outside");
    try {
      const child = await spawnReadyHelper(
        commandTesting.CONTAINER_PINNED_ATTACHMENT_REMOVE,
        [root, "stage/batch"],
      );
      await fs.rename(path.join(root, "stage"), displaced);
      await fs.symlink(external, path.join(root, "stage"));
      child.stdin.end();
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(code).toBe(0);
      await expect(fs.stat(path.join(displaced, "batch"))).rejects.toThrow("ENOENT");
      await expect(fs.readFile(path.join(external, "batch/sentinel"), "utf8"))
        .resolves.toBe("outside");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(external, { recursive: true, force: true });
    }
  });
});

describe("pane layout intent command", () => {
  test("rebases concurrent optimistic additions inside the backend mutation queue", async () => {
    await withCommands(async (invoke) => {
      const layout = (tabIds: string[]) => ({
        version: 3,
        containerId: null,
        activePaneId: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          tabs: tabIds.map((id) => ({ id, type: "plain" })),
          activeTabId: tabIds.at(-1) ?? null,
        },
      });
      const base = layout(["base"]);
      await invoke("save_pane_layout", {
        environmentId: "e1",
        layout: base,
        expectedRevision: 0,
      });
      await invoke("apply_pane_layout_intent", {
        environmentId: "e1",
        baseLayout: base,
        desiredLayout: layout(["base", "window-a"]),
      });
      const saved = await invoke("apply_pane_layout_intent", {
        environmentId: "e1",
        baseLayout: base,
        desiredLayout: layout(["base", "window-b"]),
      }) as { root: { tabs: Array<{ id: string }> }; revision: number };
      expect(saved.root.tabs.map(({ id }) => id)).toEqual([
        "base",
        "window-a",
        "window-b",
      ]);
      expect(saved.revision).toBe(3);
    });
  });

  test("rejects a stale container generation without replacing its layout", async () => {
    await withCommands(async (invoke, storage) => {
      const layout = (containerId: string, tabId: string) => ({
        version: 3,
        containerId,
        activePaneId: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          tabs: [{ id: tabId, type: "plain" }],
          activeTabId: tabId,
        },
      });
      const current = layout("container-new", "current");
      await invoke("save_pane_layout", {
        environmentId: "e1",
        layout: current,
        expectedRevision: 0,
      });
      await expect(invoke("apply_pane_layout_intent", {
        environmentId: "e1",
        baseLayout: layout("container-old", "base"),
        desiredLayout: layout("container-old", "stale"),
      })).rejects.toThrow("stale environment generation");
      expect(await storage.getPaneLayout("e1")).toMatchObject({
        containerId: "container-new",
        revision: 1,
        root: current.root,
      });
    }, {
      environment: {
        environmentType: "containerized",
        containerId: "container-new",
      },
    });
  });

  test("rejects malformed layout envelopes and oversized selection intents", async () => {
    await withCommands(async (invoke) => {
      const layout = {
        version: 3,
        containerId: null,
        activePaneId: "pane-1",
        root: { kind: "leaf", id: "pane-1", tabs: [], activeTabId: null },
      };
      await expect(invoke("apply_pane_layout_intent", {
        environmentId: "e1",
        baseLayout: { ...layout, injected: true },
        desiredLayout: layout,
      })).rejects.toThrow("Unexpected baseLayout field");
      await expect(invoke("apply_pane_layout_intent", {
        environmentId: "e1",
        baseLayout: layout,
        desiredLayout: { ...layout, root: [] },
      })).rejects.toThrow("desiredLayout.root");
      await expect(invoke("apply_pane_layout_intent", {
        environmentId: "e1",
        baseLayout: layout,
        desiredLayout: layout,
        selectionIntent: { activeTabIds: { "": "tab" } },
      })).rejects.toThrow("keys to be non-empty");
      await expect(invoke("apply_pane_layout_intent", {
        environmentId: "e1",
        baseLayout: layout,
        desiredLayout: layout,
        selectionIntent: {
          activeTabIds: Object.fromEntries(
            Array.from({ length: 1_025 }, (_, index) => [`pane-${index}`, null]),
          ),
        },
      })).rejects.toThrow("1024 entry limit");
    });
  });
});

describe("setup session wait command", () => {
  test("rehydrates a durable setup session and validates timeout boundaries", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.updateEnvironment("e1", {
        setupPhase: "running",
        setupSessionId: "e1:setup",
        setupStartedAt: "2026-08-05T10:00:00.000Z",
      });
      await expect(invoke("await_environment_setup_session", {
        environmentId: "e1",
        timeoutMs: 0,
      })).resolves.toEqual(expect.objectContaining({
        environmentId: "e1",
        sessionId: "e1:setup",
        running: true,
        terminalRunning: false,
      }));
      await expect(invoke("await_environment_setup_session", {
        environmentId: "e1",
        timeoutMs: -1,
      })).rejects.toThrow("between 0 and 60000");
      await expect(invoke("await_environment_setup_session", {
        environmentId: "e1",
        timeoutMs: 60_001,
      })).rejects.toThrow("between 0 and 60000");
    });
  });

  test("returns null when no setup is running or the wait expires", async () => {
    await withCommands(async (invoke, storage) => {
      await expect(invoke("await_environment_setup_session", {
        environmentId: "e1",
        timeoutMs: 0,
      })).resolves.toBeNull();
      await storage.updateEnvironment("e1", { setupPhase: "running" });
      await expect(invoke("await_environment_setup_session", {
        environmentId: "e1",
        timeoutMs: 0,
      })).resolves.toBeNull();
    });
  });

  test("waits through pending setup until the durable session is published", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.updateEnvironment("e1", { setupPhase: "pending" });
      setTimeout(() => {
        void storage.updateEnvironment("e1", {
          setupPhase: "running",
          setupSessionId: "e1:setup",
          setupStartedAt: "2026-08-05T10:00:00.000Z",
        });
      }, 10);
      await expect(invoke("await_environment_setup_session", {
        environmentId: "e1",
        timeoutMs: 1_000,
      })).resolves.toEqual(expect.objectContaining({
        sessionId: "e1:setup",
        running: true,
      }));
    });
  });
});

describe("durable tab teardown commands", () => {
  test("disconnects persistent terminal sessions and clears direct and replayed intents", async () => {
    await withCommands(async (invoke, storage) => {
      const direct = await storage.createSession("e1", "local", "tab-direct", "plain");
      await expect(invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-direct",
        kind: "terminal",
        persistentSessionId: direct.id,
      })).resolves.toEqual({ completed: true });
      expect((await storage.getSession(direct.id))?.status).toBe("disconnected");
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();

      const replayed = await storage.createSession("e1", "local", "tab-replayed", "plain");
      await storage.setTabTeardownIntent("e1", {
        tabId: "tab-replayed",
        kind: "terminal",
        persistentSessionId: replayed.id,
        createdAt: "2026-08-04T10:00:00.000Z",
      });
      await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
      expect((await storage.getSession(replayed.id))?.status).toBe("disconnected");
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    });
  });

  test("skips every destructive orphan path when the layout store is unreadable", async () => {
    await withCommands(async (invoke, _storage, dataDir) => {
      await fs.writeFile(path.join(dataDir, "pane-layouts.json"), "{truncated", "utf8");
      await expect(invoke("reconcile_orphaned_tab_resources", {})).resolves.toEqual({
        terminals: 0,
        nativeSessions: 0,
        tmuxSessions: 0,
        skipped: true,
      });
    });
  });

  test("validates teardown inputs before journaling", async () => {
    await withCommands(async (invoke, storage) => {
      await expect(invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-1",
        kind: "unknown",
      })).rejects.toThrow("kind is not a supported tab teardown kind");
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    });
  });

  test("delegates tmux teardown and retires every native-provider mapping", async () => {
    await withCommands(async (invoke, storage, _dataDir, commands) => {
      const stopTmux = mock(async () => undefined);
      commands.set("claude_tmux_stop", stopTmux);
      await expect(invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-tmux",
        kind: "claude-tmux",
      })).resolves.toEqual({ completed: true });
      expect(stopTmux).toHaveBeenCalledWith(
        { environmentId: "e1", tabId: "tab-tmux" },
        expect.any(Object),
      );

      for (const [agent, kind] of [
        ["claude", "claude-native"],
        ["codex", "codex-native"],
        ["opencode", "opencode-native"],
      ] as const) {
        const tabId = `tab-${agent}`;
        const logicalSessionKey = `env-e1:${tabId}`;
        const key = nativeAgentSessionStorageKey("e1", agent, logicalSessionKey);
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "e1",
          agent,
          logicalSessionKey,
          providerSessionId: `${agent}-provider-session`,
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        });

        await expect(invoke("teardown_tab", {
          environmentId: "e1",
          tabId,
          kind,
        })).resolves.toEqual({ completed: true });
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      }
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    }, {
      tabTeardown: {
        peekBridge: async () => ({ port: 4000, authToken: "test-token" }),
        fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      },
    });
  });

  test("refuses terminal resources owned by another tab or environment", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.addEnvironment({
        id: "e2", name: "Other", projectId: "proj-1", status: "running",
        environmentType: "local", branch: "other", order: 1,
        containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
        networkAccessMode: "restricted", createdAt: new Date(0).toISOString(),
      });
      const otherTab = await invoke("create_local_terminal_session", {
        environmentId: "e1",
        terminalKey: "tab-other",
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: false,
      }) as { sessionId: string };
      const otherEnvironment = await storage.createSession(
        "e2",
        "local",
        "tab-target",
        "plain",
      );

      await expect(invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-target",
        kind: "terminal",
        sessionId: otherTab.sessionId,
      })).rejects.toThrow("not owned by the requested environment and tab");
      expect(await invoke("create_local_terminal_session", {
        environmentId: "e1",
        terminalKey: "tab-other",
        cols: 80,
        rows: 24,
        trackEnvironmentActivity: false,
      })).toEqual({
        sessionId: otherTab.sessionId,
        created: false,
        bootstrapped: false,
      });

      await expect(invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-target",
        kind: "terminal",
        persistentSessionId: otherEnvironment.id,
      })).rejects.toThrow("not owned by the requested environment and tab");
      expect((await storage.getSession(otherEnvironment.id))?.status).toBe("connected");

      await invoke("close_local_terminal_session", { sessionId: otherTab.sessionId });
    });
  });

  test("refuses a native provider session owned by another tab or environment", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.addEnvironment({
        id: "e2", name: "Other", projectId: "proj-1", status: "running",
        environmentType: "local", branch: "other", order: 1,
        containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
        networkAccessMode: "restricted", createdAt: new Date(0).toISOString(),
      });
      for (const [environmentId, tabId] of [
        ["e1", "tab-other"],
        ["e2", "tab-target"],
      ] as const) {
        const logicalSessionKey = `env-${environmentId}:${tabId}`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey(environmentId, "codex", logicalSessionKey),
          environmentId,
          agent: "codex",
          logicalSessionKey,
          providerSessionId: `provider-${environmentId}-${tabId}`,
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        });
      }

      for (const providerSessionId of [
        "provider-e1-tab-other",
        "provider-e2-tab-target",
      ]) {
        await expect(invoke("teardown_tab", {
          environmentId: "e1",
          tabId: "tab-target",
          kind: "codex-native",
          sessionId: providerSessionId,
        })).rejects.toThrow("owned by a different environment or tab");
      }
      expect(await storage.listNativeAgentSessions()).toHaveLength(2);
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents)
        .toHaveProperty("tab-target");
    });
  });

  test("retains the native mapping and intent while the bridge is unavailable", async () => {
    const peekBridge = mock(async () => null as { port: number; authToken: string } | null);
    peekBridge.mockResolvedValueOnce(null);
    peekBridge.mockResolvedValue({ port: 4000, authToken: "test-token" });
    const deleteRequest = mock(async () => new Response(null, { status: 204 }));
    await withCommands(async (invoke, storage) => {
      const logicalSessionKey = "env-e1:tab-codex";
      const key = nativeAgentSessionStorageKey("e1", "codex", logicalSessionKey);
      await storage.adoptNativeAgentSession({
        key,
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey,
        providerSessionId: "provider-codex",
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      });

      await expect(invoke("teardown_tab", {
        environmentId: "e1",
        tabId: "tab-codex",
        kind: "codex-native",
        sessionId: "provider-codex",
      })).rejects.toThrow("unavailable or unhealthy");
      expect(await storage.getNativeAgentSession(key)).not.toBeNull();
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents)
        .toHaveProperty("tab-codex");
      expect(deleteRequest).not.toHaveBeenCalled();

      await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
      expect(deleteRequest).toHaveBeenCalledTimes(1);
      expect(await storage.getNativeAgentSession(key)).toBeNull();
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents).toBeUndefined();
    }, {
      tabTeardown: {
        peekBridge,
        fetch: deleteRequest as unknown as typeof fetch,
      },
    });
  });

  test("times out a hanging provider delete without blocking other intents", async () => {
    const deleteRequest = mock((input: string | URL | Request, _init?: RequestInit) => {
      if (!String(input).includes("provider-hanging")) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      // Deliberately ignore AbortSignal. The command's own deadline must bound
      // reconciliation even if the transport never settles cooperatively.
      return new Promise<Response>(() => undefined);
    });
    await withCommands(async (invoke, storage) => {
      for (const [tabId, providerSessionId] of [
        ["tab-hanging", "provider-hanging"],
        ["tab-fast", "provider-fast"],
      ] as const) {
        const logicalSessionKey = `env-e1:${tabId}`;
        await storage.adoptNativeAgentSession({
          key: nativeAgentSessionStorageKey("e1", "codex", logicalSessionKey),
          environmentId: "e1",
          agent: "codex",
          logicalSessionKey,
          providerSessionId,
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        });
        await storage.setTabTeardownIntent("e1", {
          tabId,
          kind: "codex-native",
          sessionId: providerSessionId,
          createdAt: `2026-08-04T10:00:0${tabId === "tab-hanging" ? "0" : "1"}.000Z`,
        });
      }

      const startedAt = performance.now();
      await expect(invoke("reconcile_tab_teardowns", {})).resolves.toEqual({ completed: 1 });
      expect(performance.now() - startedAt).toBeLessThan(250);

      const hangingKey = nativeAgentSessionStorageKey(
        "e1",
        "codex",
        "env-e1:tab-hanging",
      );
      const fastKey = nativeAgentSessionStorageKey("e1", "codex", "env-e1:tab-fast");
      expect(await storage.getNativeAgentSession(hangingKey)).not.toBeNull();
      expect(await storage.getNativeAgentSession(fastKey)).toBeNull();
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents)
        .toHaveProperty("tab-hanging");
      expect((await storage.getEnvironment("e1"))?.tabTeardownIntents)
        .not.toHaveProperty("tab-fast");
    }, {
      tabTeardown: {
        peekBridge: async () => ({ port: 4000, authToken: "test-token" }),
        fetch: deleteRequest as unknown as typeof fetch,
        deleteTimeoutMs: 20,
      },
    });
  });
});

describe("prompt queue commands", () => {
  test("wakes the native dispatcher after durable enqueue", async () => {
    const notifyPromptQueueChanged = mock((_queueKey: string) => undefined);
    await withCommands(async (invoke) => {
      await invoke("enqueue_prompt_queue_message", {
        queueKey: "opencode\u0000env-e1:review-tab",
        environmentId: "e1",
        message: { id: "review-1", text: "Review" },
      });

      expect(notifyPromptQueueChanged).toHaveBeenCalledWith(
        "opencode\u0000env-e1:review-tab",
      );
    }, {
      nativeAgents: { notifyPromptQueueChanged } as never,
    });
  });

  test("mutates and reads back a backend-owned queue", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m1" },
      })).resolves.toMatchObject({ queueKey: KEY, revision: 1 });
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m2" },
      });
      await invoke("move_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "m2",
        direction: "up",
      });

      await expect(invoke("get_prompt_queue", { queueKey: KEY }))
        .resolves.toMatchObject({ messages: [{ id: "m2" }, { id: "m1" }] });
      await expect(invoke("list_prompt_queues", { environmentId: "e1" }))
        .resolves.toHaveLength(1);
      await expect(invoke("remove_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m2",
      })).resolves.toMatchObject({
        removed: { id: "m2" },
        queue: { messages: [{ id: "m1" }] },
      });
    });
  });

  test("explicitly retries a terminal queue dispatch", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.savePromptQueue(KEY, "e1", [{ id: "m1", text: "invalid" }]);
      await storage.reservePromptQueueHeadForDispatch(KEY);
      await storage.failPromptQueueDispatch(KEY, "m1");

      await expect(invoke("retry_prompt_queue_dispatch", { queueKey: KEY }))
        .resolves.toMatchObject({
          messages: [{ id: "m1", text: "invalid" }],
        });
      expect((await storage.getPromptQueue(KEY))?.dispatchError).toBeUndefined();
    });
  });

  test("atomically claims the expected queue head", async () => {
    await withCommands(async (invoke) => {
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m1" },
      });
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: { id: "m2" },
      });
      const first = await invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
      }) as { claimToken: string };
      expect(first).toMatchObject({
        claimed: { id: "m1" },
        queue: { messages: [{ id: "m2" }], revision: 3 },
      });

      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m2",
      })).resolves.toMatchObject({
        claimed: null,
        claimToken: null,
        queue: {
          messages: [{ id: "m2" }],
          revision: 3,
          outstandingClaim: { message: { id: "m1" } },
        },
      });
      await expect(invoke("acknowledge_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: first.claimToken,
      })).resolves.toMatchObject({
        messages: [{ id: "m2" }],
        revision: 4,
      });
    });
  });

  test("requeues, nacks, and acknowledges through registry commands", async () => {
    await withCommands(async (invoke) => {
      await invoke("requeue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: { id: "m1", text: "first", attachments: [] },
      });
      const claim = await invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
      }) as { claimToken: string };
      await expect(invoke("reject_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: claim.claimToken,
      })).resolves.toMatchObject({ messages: [{ id: "m1" }] });

      const retry = await invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
      }) as { claimToken: string };
      await expect(invoke("acknowledge_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: retry.claimToken,
      })).resolves.toMatchObject({ messages: [] });
    });
  });

  test("atomically transfers the authoritative queued payload to a draft", async () => {
    await withCommands(async (invoke) => {
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: {
          id: "m1",
          text: "authoritative",
          attachments: [{ id: "attachment-1" }],
          mode: "plan",
        },
      });
      await expect(invoke("transfer_prompt_queue_message_to_compose_draft", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "m1",
        draftKey: "compose:e1:tab-1",
        ownerType: "environment",
        ownerId: "e1",
        expectedDraftRevision: 0,
      })).resolves.toMatchObject({
        removed: { id: "m1", mode: "plan" },
        queue: { messages: [] },
        draft: {
          value: {
            text: "authoritative",
            mentions: [],
            attachments: [{ id: "attachment-1" }],
          },
        },
      });
    });
  });

  test("rejects malformed atomic-claim arguments", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "",
      })).rejects.toThrow();
      await expect(invoke("enqueue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: "bad",
      })).rejects.toThrow("non-blank ID");
      await expect(invoke("acknowledge_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: "",
      })).rejects.toThrow();
      await expect(invoke("reject_prompt_queue_claim", {
        queueKey: KEY,
        environmentId: "e1",
        claimToken: "",
      })).rejects.toThrow();
      await expect(invoke("transfer_prompt_queue_message_to_compose_draft", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "",
        draftKey: "compose:e1:tab-1",
        ownerType: "environment",
        ownerId: "e1",
      })).rejects.toThrow();
    });
  });

  test("rejects malformed reorder, removal, and requeue arguments", async () => {
    // Each of these coerces at the registry boundary, so a bad payload must
    // fail there rather than reaching storage as a plausible-looking value.
    await withCommands(async (invoke) => {
      await expect(invoke("move_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m1", direction: 1,
      })).rejects.toThrow("direction");
      await expect(invoke("move_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m1",
      })).rejects.toThrow("direction");
      await expect(invoke("move_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: "m1", direction: "sideways",
      })).rejects.toThrow("must be up or down");
      await expect(invoke("remove_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", messageId: 7,
      })).rejects.toThrow("messageId");
      await expect(invoke("requeue_prompt_queue_message", {
        queueKey: KEY, environmentId: "e1", message: "bad",
      })).rejects.toThrow("non-blank ID");
    });
  });

  test("rejects a non-numeric expected draft revision before the transfer runs", async () => {
    await withCommands(async (invoke, storage) => {
      await invoke("enqueue_prompt_queue_message", {
        queueKey: KEY,
        environmentId: "e1",
        message: { id: "m1", text: "queued", attachments: [] },
      });

      await expect(invoke("transfer_prompt_queue_message_to_compose_draft", {
        queueKey: KEY,
        environmentId: "e1",
        messageId: "m1",
        draftKey: "compose:e1:tab-1",
        ownerType: "environment",
        ownerId: "e1",
        expectedDraftRevision: "1",
      })).rejects.toThrow("expectedDraftRevision");

      expect(await storage.getPromptQueue(KEY)).toMatchObject({ messages: [{ id: "m1" }] });
      expect(await storage.getComposeDraft("compose:e1:tab-1")).toBeNull();
    });
  });

  test("rejects blank identifiers", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("enqueue_prompt_queue_message", {
        queueKey: "", environmentId: "e1", message: { id: "m1" },
      })).rejects.toThrow();
      await expect(invoke("get_prompt_queue", { queueKey: "" })).rejects.toThrow();
      await expect(invoke("list_prompt_queues", { environmentId: "" })).rejects.toThrow();
    });
  });
});

describe("draft commands", () => {
  test("forwards compare-and-swap revisions for compose and file mutations", async () => {
    await withCommands(async (invoke) => {
      const compose = await invoke("save_compose_draft", {
        draftKey: "compose:e1:tab",
        ownerType: "environment",
        ownerId: "e1",
        value: "first",
        expectedRevision: 0,
      }) as { revision: number };
      const file = await invoke("save_file_draft", {
        draftKey: "file:e1:a",
        environmentId: "e1",
        filePath: "a.ts",
        content: "first",
        originalContent: "disk",
        expectedRevision: 0,
      }) as { revision: number };

      await invoke("save_compose_draft", {
        draftKey: "compose:e1:tab",
        ownerType: "environment",
        ownerId: "e1",
        value: "second",
        expectedRevision: compose.revision,
      });
      await invoke("save_file_draft", {
        draftKey: "file:e1:a",
        environmentId: "e1",
        filePath: "a.ts",
        content: "second",
        originalContent: "disk",
        expectedRevision: file.revision,
      });

      await expect(invoke("delete_compose_draft", {
        draftKey: "compose:e1:tab",
        expectedRevision: compose.revision,
      })).rejects.toThrow("revision conflict");
      await expect(invoke("delete_file_draft", {
        draftKey: "file:e1:a",
        expectedRevision: file.revision,
      })).rejects.toThrow("revision conflict");
      await expect(invoke("delete_compose_draft", {
        draftKey: "compose:e1:tab",
        expectedRevision: 2,
      })).resolves.toBeUndefined();
      await expect(invoke("delete_file_draft", {
        draftKey: "file:e1:a",
        expectedRevision: 2,
      })).resolves.toBeUndefined();
    });
  });

  test("rejects malformed revision arguments before draft mutation", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_file_draft", {
        draftKey: "file:e1:a",
        environmentId: "e1",
        filePath: "a.ts",
        content: "first",
        originalContent: "disk",
        expectedRevision: "zero",
      })).rejects.toThrow("Expected expectedRevision to be a number");
      await expect(invoke("delete_compose_draft", {
        draftKey: "compose:e1:tab",
        expectedRevision: "zero",
      })).rejects.toThrow("Expected expectedRevision to be a number");
      await expect(invoke("delete_file_draft", {
        draftKey: "file:e1:a",
        expectedRevision: "zero",
      })).rejects.toThrow("Expected expectedRevision to be a number");
    });
  });
});

describe("agent handoff commands", () => {
  test("saves, reads, and deletes an environment-owned handoff", async () => {
    await withCommands(async (invoke, storage) => {
      const snapshot = {
        sourceProvider: "claude",
        destinationProvider: "codex",
        messages: [{ id: "m1" }],
      };
      await expect(invoke("save_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
        version: 1,
        snapshot,
      })).resolves.toMatchObject({
        id: "h1",
        environmentId: "e1",
        version: 1,
        snapshot,
      });
      await expect(invoke("get_agent_handoff", { handoffId: "h1" }))
        .resolves.toMatchObject({ id: "h1", snapshot });
      await expect(invoke("delete_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
      })).resolves.toBe(true);
      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
      await expect(invoke("delete_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
      })).resolves.toBe(false);
    });
  });

  test("rejects malformed command arguments before mutation", async () => {
    await withCommands(async (invoke, storage) => {
      await expect(invoke("save_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
        version: "1",
        snapshot: {},
      })).rejects.toThrow("version");
      await expect(invoke("save_agent_handoff", {
        handoffId: "h1",
        environmentId: "e1",
        version: 1,
        snapshot: [],
      })).rejects.toThrow("must be an object");
      await expect(invoke("get_agent_handoff", { handoffId: 1 }))
        .rejects.toThrow("handoffId");
      await expect(invoke("delete_agent_handoff", {
        handoffId: "h1",
        environmentId: null,
      })).rejects.toThrow("environmentId");
      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
    });
  });

  test("prunes handoffs the restored layout no longer references", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.saveAgentHandoff("kept", "e1", 1, { messages: [] });
      await storage.saveAgentHandoff("orphan", "e1", 1, { messages: [] });

      await expect(invoke("prune_agent_handoffs", {
        environmentId: "e1",
        referencedHandoffIds: ["kept"],
      })).resolves.toEqual(["orphan"]);
      await expect(storage.getAgentHandoff("kept")).resolves.not.toBeNull();
      await expect(storage.getAgentHandoff("orphan")).resolves.toBeNull();
    });
  });

  test("refuses a prune whose reference list is not an array of strings", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.saveAgentHandoff("kept", "e1", 1, { messages: [] });

      /*
       * `asStringArray` would coerce each of these to `[]`, which here reads as
       * "nothing is referenced" and would delete every transcript in the
       * environment. Prune has to reject the request instead.
       */
      for (const referencedHandoffIds of [undefined, null, "kept", { 0: "kept" }]) {
        await expect(invoke("prune_agent_handoffs", {
          environmentId: "e1",
          referencedHandoffIds,
        })).rejects.toThrow("referencedHandoffIds");
      }
      await expect(invoke("prune_agent_handoffs", {
        environmentId: "e1",
        referencedHandoffIds: ["kept", 7],
      })).rejects.toThrow("only strings");
      await expect(invoke("prune_agent_handoffs", {
        environmentId: 1,
        referencedHandoffIds: [],
      })).rejects.toThrow("environmentId");

      await expect(storage.getAgentHandoff("kept")).resolves.not.toBeNull();
    });
  });
});

describe("native agent and looped-review controller commands", () => {
  test("uses the real native service for interaction monitor commands", async () => {
    let service: NativeAgentService | undefined;
    await withCommands(async (invoke) => {
      try {
        await expect(invoke("get_agent_interaction_observations", {}))
          .resolves.toEqual([]);
        await expect(invoke("reconcile_agent_interactions", {}))
          .resolves.toEqual([]);
        await expect(invoke("set_agent_interaction_monitor_adoption", {
          enabled: false,
        })).resolves.toEqual({ enabled: false });
      } finally {
        await service?.shutdown();
      }
    }, {
      nativeAgentsFactory: (storage) => {
        service = new NativeAgentService(storage, async () => {
          throw new Error("disabled monitor must not invoke commands");
        });
        return service;
      },
    });
  });

  test("reports unavailable interaction monitoring and propagates reconciliation failures", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("get_agent_interaction_observations", {}))
        .rejects.toThrow("Native agent service is unavailable");
      await expect(invoke("reconcile_agent_interactions", {}))
        .rejects.toThrow("Native agent service is unavailable");
      await expect(invoke("set_agent_interaction_monitor_adoption", {
        enabled: true,
      })).rejects.toThrow("Native agent service is unavailable");
    });

    const reconcileAgentInteractions = mock(async () => {
      throw new Error("interaction scan failed");
    });
    const getInteractionObservations = mock(() => []);
    await withCommands(async (invoke) => {
      await expect(invoke("reconcile_agent_interactions", {}))
        .rejects.toThrow("interaction scan failed");
      expect(reconcileAgentInteractions).toHaveBeenCalledTimes(1);
      expect(getInteractionObservations).not.toHaveBeenCalled();
    }, {
      nativeAgents: {
        reconcileAgentInteractions,
        getInteractionObservations,
      } as unknown as NonNullable<CommandContext["nativeAgents"]>,
    });
  });

  test("maps native session and dispatch arguments to the backend authority", async () => {
    const ensureSession = mock(async (input: unknown) => ({
      operation: "ensure",
      input,
    }));
    const dispatchPrompt = mock(async (input: unknown) => ({
      operation: "dispatch",
      input,
    }));
    const adoptSession = mock(async (input: unknown) => ({
      operation: "adopt",
      input,
    }));
    const observations = [{
      provider: "codex",
      kind: "question",
      workflowSurface: "looped-review",
      phase: "discovery",
      firstDetectedAt: 1,
      lastDetectedAt: 1,
      count: 1,
      providerState: "blocked",
    }];
    const getInteractionObservations = mock(() => observations);
    const reconcileAgentInteractions = mock(async () => undefined);
    const setInteractionMonitorAdoptionEnabled = mock((_enabled: boolean) => undefined);
    const nativeAgents = {
      ensureSession,
      adoptSession,
      dispatchPrompt,
      getInteractionObservations,
      reconcileAgentInteractions,
      setInteractionMonitorAdoptionEnabled,
    } as unknown as NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        title: "Review",
        model: "gpt-test",
        reasoningEffort: "high",
        phase: "review",
      })).resolves.toMatchObject({ operation: "ensure" });
      expect(ensureSession).toHaveBeenCalledWith({
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        title: "Review",
        model: "gpt-test",
        reasoningEffort: "high",
        phase: "review",
      });

      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:tab-adopted",
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
        model: "provider/model",
        reasoningEffort: "high",
      })).resolves.toMatchObject({ operation: "adopt" });
      expect(adoptSession).toHaveBeenCalledWith({
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:tab-adopted",
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        providerSessionId: "provider-new",
        expectedProviderSessionId: "provider-old",
        title: undefined,
        model: "provider/model",
        reasoningEffort: "high",
        phase: undefined,
      });

      const schema = { type: "object" };
      const images = [{ filename: "reference.png", data: "cG5n" }];
      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        prompt: "Review this",
        requestId: "request-1",
        images,
        schema,
      })).resolves.toMatchObject({ operation: "dispatch" });
      expect(dispatchPrompt).toHaveBeenCalledWith({
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        title: undefined,
        model: undefined,
        reasoningEffort: undefined,
        phase: undefined,
        prompt: "Review this",
        requestId: "request-1",
        images,
        attachments: undefined,
        schema,
        // An absent mode must resolve to the restrictive direction: undefined
        // reaches the Claude bridge as bypassPermissions.
        mode: "plan",
        fastMode: undefined,
        subAgent: undefined,
        includeLocalSettings: undefined,
        promptSuggestions: undefined,
      });

      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        prompt: " ",
        requestId: "request-2",
      })).rejects.toThrow("non-blank string");
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:tab-adopted",
        providerSessionId: " ",
      })).rejects.toThrow("non-blank string");
      expect(dispatchPrompt).toHaveBeenCalledTimes(1);
      expect(adoptSession).toHaveBeenCalledTimes(1);

      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:invalid-origin",
        origin: "scheduled-task",
      })).rejects.toThrow("supported agent interaction origin");
      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:invalid-policy",
        prompt: "Review",
        requestId: "request-invalid-policy",
        interactionPolicy: {
          ...UNATTENDED_AGENT_INTERACTION_POLICY,
          authorization: "await-user",
        },
      })).rejects.toThrow("valid agent interaction policy");
      // The third registration site coerces the same two arguments and must
      // reject them just as the other two do.
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:invalid-origin",
        providerSessionId: "provider-new",
        origin: "scheduled-task",
      })).rejects.toThrow("supported agent interaction origin");
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "opencode",
        logicalSessionKey: "env-e1:invalid-policy",
        providerSessionId: "provider-new",
        interactionPolicy: {
          ...INTERACTIVE_AGENT_INTERACTION_POLICY,
          unknown: "await-user",
        },
      })).rejects.toThrow("valid agent interaction policy");
      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:non-string-origin",
        origin: 7,
      })).rejects.toThrow("supported agent interaction origin");
      expect(ensureSession).toHaveBeenCalledTimes(1);
      expect(dispatchPrompt).toHaveBeenCalledTimes(1);
      expect(adoptSession).toHaveBeenCalledTimes(1);

      await expect(invoke("get_agent_interaction_observations", {}))
        .resolves.toEqual(observations);
      await expect(invoke("reconcile_agent_interactions", {}))
        .resolves.toEqual(observations);
      expect(reconcileAgentInteractions).toHaveBeenCalledTimes(1);
      await expect(invoke("set_agent_interaction_monitor_adoption", {
        enabled: false,
      })).resolves.toEqual({ enabled: false });
      expect(setInteractionMonitorAdoptionEnabled).toHaveBeenCalledWith(false);
      await expect(invoke("set_agent_interaction_monitor_adoption", {
        enabled: "false",
      })).rejects.toThrow("enabled to be a boolean");
    }, { nativeAgents });
  });

  test("rejects malformed dispatch images, attachments and schema", async () => {
    const dispatchPrompt = mock(async () => ({ operation: "dispatch" }));
    const nativeAgents = { dispatchPrompt } as unknown as
      NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (invoke) => {
      const base = {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        prompt: "Review this",
        requestId: "request-1",
      };
      // Cast straight through, a malformed element surfaced as a TypeError deep
      // inside the provider — which the drain path then retried forever.
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        images: [{}],
      })).rejects.toThrow("filename must be a non-empty string");
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        images: [{ filename: "a.png", data: "not base64!" }],
      })).rejects.toThrow("valid base64");
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        images: Array.from({ length: 21 }, () => ({ filename: "a.png", data: "AA==" })),
      })).rejects.toThrow("At most 20 prompt images");
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        attachments: [{ type: "image" }],
      })).rejects.toThrow("path must be a non-empty string");
      expect(dispatchPrompt).not.toHaveBeenCalled();

      // typeof x === "object" admits arrays, so a JSON array must not pass as a
      // JSON Schema object.
      await expect(invoke("dispatch_native_agent_prompt", {
        ...base,
        schema: [{ type: "object" }],
      })).resolves.toMatchObject({ operation: "dispatch" });
      expect(dispatchPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ schema: undefined }),
      );
    }, { nativeAgents });
  });

  test("forwards an explicit dispatch mode and its per-prompt options", async () => {
    const dispatchPrompt = mock(async () => ({ operation: "dispatch" }));
    const nativeAgents = { dispatchPrompt } as unknown as
      NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (invoke) => {
      await invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "claude",
        logicalSessionKey: "env-e1:tab-2",
        prompt: "Ship it",
        requestId: "request-1",
        mode: "build",
        fastMode: true,
        subAgent: "reviewer",
        includeLocalSettings: false,
        promptSuggestions: true,
      });
      expect(dispatchPrompt).toHaveBeenCalledWith(expect.objectContaining({
        mode: "build",
        fastMode: true,
        subAgent: "reviewer",
        includeLocalSettings: false,
        promptSuggestions: true,
      }));
    }, { nativeAgents });
  });

  test("reports unavailable native supervision before accepting work", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("ensure_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
      })).rejects.toThrow("Native agent service is unavailable");
      await expect(invoke("dispatch_native_agent_prompt", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        prompt: "Build",
        requestId: "request-1",
      })).rejects.toThrow("Native agent service is unavailable");
      await expect(invoke("adopt_native_agent_session", {
        environmentId: "e1",
        agent: "codex",
        logicalSessionKey: "env-e1:tab-1",
        providerSessionId: "provider-1",
      })).rejects.toThrow("Native agent service is unavailable");
    });
  });

  test("acknowledges only the startup session identified by optional fencing fields", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.updateEnvironment("e1", {
        startupAgentSession: {
          tabId: "startup-agent",
          agent: "codex",
          style: "native",
          providerSessionId: "provider-1",
          status: "running",
          startedAt: "2026-07-29T12:00:00.000Z",
        },
      });

      await expect(invoke("acknowledge_startup_agent_session", {
        environmentId: "e1",
        providerSessionId: "provider-old",
      })).resolves.toMatchObject({
        startupAgentSession: { providerSessionId: "provider-1" },
      });
      await expect(invoke("acknowledge_startup_agent_session", {
        environmentId: "e1",
        providerSessionId: "provider-1",
        startedAt: "2026-07-29T12:00:00.000Z",
      })).resolves.toMatchObject({ id: "e1" });
      expect((await storage.getEnvironment("e1"))?.startupAgentSession)
        .toBeUndefined();

      await expect(invoke("acknowledge_startup_agent_session", {
        environmentId: "e1",
        providerSessionId: " ",
      })).rejects.toThrow("non-blank string");
    });
  });

  test("claims, validates, and releases a fenced looped-review controller lease", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.saveLoopedReviewWorkflow(
        "workflow-1",
        "e1",
        1,
        { id: "workflow-1", phase: "reviewing", controllerFence: "snapshot-token" },
      );

      const claimed = await invoke("claim_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        leaseMs: 15_000,
      }) as { granted: boolean; token: string; expiresAt: string };
      expect(claimed.granted).toBe(true);
      expect(typeof claimed.token).toBe("string");
      expect(claimed.token.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(claimed.expiresAt))).toBe(true);
      const rendererWorkflow = await invoke("get_looped_review_workflow", {
        workflowId: "workflow-1",
      }) as { snapshot: Record<string, unknown> };
      expect(rendererWorkflow).not.toHaveProperty("controllerLease");
      expect(rendererWorkflow.snapshot).not.toHaveProperty("controllerFence");
      const listed = await invoke("list_looped_review_workflows", {
        environmentId: "e1",
      }) as Array<Record<string, unknown>>;
      expect(listed).toHaveLength(1);
      expect(listed[0]).not.toHaveProperty("controllerLease");
      expect(listed[0]?.snapshot).not.toHaveProperty("controllerFence");
      const valid = await invoke("validate_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        token: claimed.token,
      });
      expect(valid).toBe(true);
      await expect(invoke("save_looped_review_workflow", {
        workflowId: "workflow-1",
        environmentId: "e1",
        version: 1,
        snapshot: { id: "workflow-1", phase: "fixing" },
        expectedRevision: 1,
        controllerOwnerId: "desktop",
        controllerToken: claimed.token,
      })).resolves.toMatchObject({
        revision: 2,
        snapshot: { id: "workflow-1", phase: "fixing" },
      });
      await expect(invoke("save_looped_review_workflow", {
        workflowId: "workflow-1",
        environmentId: "e1",
        version: 1,
        snapshot: { id: "workflow-1", phase: "stale" },
        expectedRevision: 2,
        controllerOwnerId: "desktop",
      })).rejects.toThrow("controllerToken");
      await expect(invoke("release_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        token: claimed.token,
      })).resolves.toBeUndefined();
      await expect(invoke("validate_looped_review_controller", {
        workflowId: "workflow-1",
        ownerId: "desktop",
        token: claimed.token,
      })).resolves.toBe(false);
    });
  });

  test("reconciles a pending launch after setup and re-reads authoritative state", async () => {
    const reconcileInitialLaunch = mock(async (_environmentId: string) => undefined);
    const nativeAgents = {
      reconcileInitialLaunch,
    } as unknown as NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (_invoke, storage) => {
      reconcileInitialLaunch.mockImplementationOnce(async (environmentId) => {
        await storage.updateEnvironment(environmentId, {
          pendingAgentLaunch: false,
          startupAgentSession: {
            tabId: "startup-agent",
            agent: "codex",
            style: "native",
            providerSessionId: "provider-1",
            status: "running",
          },
        });
      });
      const environment = await storage.getEnvironment("e1");
      if (!environment) throw new Error("Test environment is missing");
      const completed = await commandTesting.completeEnvironmentSetup(
        environment,
        {
          storage,
          emit: () => undefined,
          appRoot: "",
          resourceRoot: "",
          environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
          nativeAgents,
        },
      );

      expect(reconcileInitialLaunch).toHaveBeenCalledWith("e1");
      expect(completed).toMatchObject({
        setupScriptsComplete: true,
        pendingAgentLaunch: false,
        startupAgentSession: {
          providerSessionId: "provider-1",
          status: "running",
        },
      });
    }, {
      nativeAgents,
      environment: {
        createdFromCommit: "commit-1",
        pendingAgentLaunch: true,
      },
    });
  });

  test("a setup override restores readiness and reconciles a pending agent launch", async () => {
    const reconcileInitialLaunch = mock(async (_environmentId: string) => undefined);
    const nativeAgents = {
      reconcileInitialLaunch,
    } as unknown as NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (invoke, storage) => {
      reconcileInitialLaunch.mockImplementationOnce(async (environmentId) => {
        await storage.updateEnvironment(environmentId, { pendingAgentLaunch: false });
      });

      const result = await invoke("override_environment_setup", {
        environmentId: "e1",
      });

      expect(reconcileInitialLaunch).toHaveBeenCalledWith("e1");
      expect(result).toMatchObject({
        id: "e1",
        status: "running",
        setupScriptsComplete: true,
        setupPhase: "ready",
        setupOverride: true,
        lifecycleError: null,
        pendingAgentLaunch: false,
      });
      await expect(storage.getEnvironment("e1")).resolves.toMatchObject({
        status: "running",
        setupScriptsComplete: true,
        setupPhase: "ready",
        pendingAgentLaunch: false,
      });
    }, {
      nativeAgents,
      environment: {
        status: "error",
        setupScriptsComplete: false,
        setupPhase: "failed",
        lifecycleError: "Setup script failed",
        pendingAgentLaunch: true,
      },
    });
  });

  test("keeps setup complete and launch pending when reconciliation fails", async () => {
    const nativeAgents = {
      reconcileInitialLaunch: mock(async () => {
        throw new Error("bridge unavailable");
      }),
    } as unknown as NonNullable<CommandContext["nativeAgents"]>;

    await withCommands(async (_invoke, storage) => {
      const environment = await storage.getEnvironment("e1");
      if (!environment) throw new Error("Test environment is missing");
      await expect(commandTesting.completeEnvironmentSetup(
        environment,
        {
          storage,
          emit: () => undefined,
          appRoot: "",
          resourceRoot: "",
          environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
          nativeAgents,
        },
      )).resolves.toMatchObject({
        setupScriptsComplete: true,
        pendingAgentLaunch: true,
      });
    }, {
      nativeAgents,
      environment: {
        createdFromCommit: "commit-1",
        pendingAgentLaunch: true,
      },
    });
  });
});

describe("looped review commands", () => {
  const startInput = {
    environmentId: "e1",
    projectId: "proj-1",
    agent: "codex",
    model: "gpt-5.4",
    targetBranch: "main",
    allowance: 6,
  } as const;

  const workflowSnapshot = (
    id: string,
    phase: "preparing" | "cancelled" | "completed" = "preparing",
  ) => {
    const timestamp = new Date(0).toISOString();
    return {
      version: 2,
      controller: "backend",
      id,
      environmentId: "e1",
      projectId: "proj-1",
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
      startingAllowance: 6,
      currentAllowance: 6,
      currentRound: 1,
      currentPass: 0,
      phase,
      rounds: [{
        round: 1,
        allowance: 6,
        status: phase === "completed" ? "completed" : "preparing",
        passes: [],
        startedAt: timestamp,
      }],
      sessions: [],
      activePool: { issues: [], coverageGaps: [] },
      archivedPools: [],
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      pr: { status: "pending" },
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 1,
    };
  };

  test("delegates every renderer lifecycle command to the backend supervisor", async () => {
    const start = mock(async (input: unknown) => ({ operation: "start", input }));
    const pause = mock(async (id: string) => ({ operation: "pause", id }));
    const resume = mock(async (id: string) => ({ operation: "resume", id }));
    const retry = mock(async (id: string) => ({ operation: "retry", id }));
    const cancel = mock(async (id: string) => ({ operation: "cancel", id }));
    const providerSession = mock(async (id: string, sessionId?: string) => ({
      providerSessionId: `${id}:${sessionId ?? "active"}`,
    }));
    const supervisor = {
      start, pause, resume, retry, cancel, providerSession,
    } as unknown as NonNullable<CommandContext["loopedReviews"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("start_looped_review", startInput))
        .resolves.toMatchObject({ operation: "start" });
      await expect(invoke("pause_looped_review", { workflowId: "review-1" }))
        .resolves.toEqual({ operation: "pause", id: "review-1" });
      await expect(invoke("resume_looped_review", { workflowId: "review-1" }))
        .resolves.toEqual({ operation: "resume", id: "review-1" });
      await expect(invoke("retry_looped_review", { workflowId: "review-1" }))
        .resolves.toEqual({ operation: "retry", id: "review-1" });
      await expect(invoke("cancel_looped_review", { workflowId: "review-1" }))
        .resolves.toEqual({ operation: "cancel", id: "review-1" });
      await expect(invoke("get_looped_review_provider_session", {
        workflowId: "review-1", sessionId: "session-1",
      })).resolves.toEqual({ providerSessionId: "review-1:session-1" });
      await expect(invoke("get_looped_review_provider_session", {
        workflowId: "review-1",
      })).resolves.toEqual({ providerSessionId: "review-1:active" });

      expect(start).toHaveBeenCalledWith(startInput);
      expect(providerSession).toHaveBeenCalledWith("review-1", "session-1");
      expect(providerSession).toHaveBeenCalledWith("review-1", undefined);
    }, { loopedReviews: supervisor });
  });

  test("strips the controller fence from every lifecycle response", async () => {
    // The supervisor stamps the live lease token onto the workflow it returns,
    // and the renderer installs these responses straight into its store — in
    // gateway mode across a network. `get`/`list` already redact it; the
    // lifecycle commands must not be the hole in that guarantee.
    const workflow = (operation: string) => ({
      operation, id: "review-1", phase: "preparing", controllerFence: "secret-fence",
    });
    const supervisor = {
      start: mock(async () => workflow("start")),
      pause: mock(async () => workflow("pause")),
      resume: mock(async () => workflow("resume")),
      retry: mock(async () => workflow("retry")),
      cancel: mock(async () => workflow("cancel")),
      providerSession: mock(async () => null),
    } as unknown as NonNullable<CommandContext["loopedReviews"]>;

    await withCommands(async (invoke) => {
      const commands: Array<[string, Record<string, unknown>]> = [
        ["start_looped_review", startInput as unknown as Record<string, unknown>],
        ["pause_looped_review", { workflowId: "review-1" }],
        ["resume_looped_review", { workflowId: "review-1" }],
        ["retry_looped_review", { workflowId: "review-1" }],
        ["cancel_looped_review", { workflowId: "review-1" }],
      ];
      for (const [command, args] of commands) {
        const result = await invoke(command, args) as Record<string, unknown>;
        expect(result).not.toHaveProperty("controllerFence");
        // The rest of the snapshot must survive untouched.
        expect(result.id).toBe("review-1");
        expect(result.phase).toBe("preparing");
      }
    }, { loopedReviews: supervisor });
  });

  test("validates lifecycle input and rejects renderer writes to version 2", async () => {
    const supervisor = {
      start: mock(async () => undefined),
      pause: mock(async () => undefined),
      resume: mock(async () => undefined),
      retry: mock(async () => undefined),
      cancel: mock(async () => undefined),
      providerSession: mock(async () => undefined),
    } as unknown as NonNullable<CommandContext["loopedReviews"]>;

    await withCommands(async (invoke, storage) => {
      await expect(invoke("start_looped_review", { ...startInput, allowance: 11 }))
        .rejects.toThrow("Invalid looped review start request");
      await expect(invoke("pause_looped_review", { workflowId: " " }))
        .rejects.toThrow("non-blank string");

      await storage.saveLoopedReviewWorkflow(
        "review-1", "e1", 2, { id: "review-1", controllerFence: "snapshot-token" }, 0,
      );
      const claim = await storage.claimLoopedReviewController(
        "review-1",
        "backend-controller",
        15_000,
      );
      const rendererWorkflow = await invoke("get_looped_review_workflow", {
        workflowId: "review-1",
      }) as { snapshot: Record<string, unknown> };
      expect(rendererWorkflow).not.toHaveProperty("controllerLease");
      expect(rendererWorkflow.snapshot).not.toHaveProperty("controllerFence");
      await expect(invoke("save_looped_review_workflow", {
        workflowId: "review-1", environmentId: "e1", version: 2,
        snapshot: { id: "review-1", phase: "paused" }, expectedRevision: 1,
      })).rejects.toThrow("only be changed through workflow commands");
      await expect(invoke("save_looped_review_workflow", {
        workflowId: "review-1", environmentId: "e1", version: 1,
        snapshot: { id: "review-1", phase: "paused" }, expectedRevision: 1,
      })).rejects.toThrow("only be changed through workflow commands");
      await expect(invoke("claim_looped_review_controller", {
        workflowId: "review-1", ownerId: "renderer", leaseMs: 15_000,
      })).rejects.toThrow("not available to renderers");
      await expect(invoke("validate_looped_review_controller", {
        workflowId: "review-1", ownerId: "backend-controller", token: claim.token,
      })).rejects.toThrow("not available to renderers");
      await expect(invoke("release_looped_review_controller", {
        workflowId: "review-1", ownerId: "backend-controller", token: claim.token,
      })).rejects.toThrow("not available to renderers");
      expect(await storage.validateLoopedReviewController(
        "review-1",
        "backend-controller",
        claim.token,
      )).toBe(true);

      await expect(invoke("get_looped_review_provider_session", {
        workflowId: "review-1", sessionId: " ",
      })).rejects.toThrow("non-blank string");
      await expect(invoke("get_looped_review_provider_session", {
        workflowId: " ",
      })).rejects.toThrow("non-blank string");
    }, { loopedReviews: supervisor });
  });

  test("refuses active deletion and removes terminal backend-owned workflows", async () => {
    await withCommands(async (invoke, storage) => {
      await storage.saveLoopedReviewWorkflow(
        "review-active",
        "e1",
        2,
        workflowSnapshot("review-active"),
      );
      await storage.saveLoopedReviewWorkflow(
        "review-terminal",
        "e1",
        2,
        workflowSnapshot("review-terminal", "completed"),
      );

      await expect(invoke("delete_looped_review_workflow", {
        workflowId: "review-active",
      })).rejects.toThrow("must be cancelled before deletion");
      await expect(invoke("delete_looped_review_workflow", {
        workflowId: "review-terminal",
      })).resolves.toBeUndefined();
      expect(await storage.getLoopedReviewWorkflow("review-active")).not.toBeNull();
      expect(await storage.getLoopedReviewWorkflow("review-terminal")).toBeNull();
    });
  });

  test("fails every lifecycle command closed when the supervisor is unavailable", async () => {
    await withCommands(async (invoke) => {
      const calls: Array<[string, Record<string, unknown>]> = [
        ["start_looped_review", startInput],
        ["pause_looped_review", { workflowId: "review-1" }],
        ["resume_looped_review", { workflowId: "review-1" }],
        ["retry_looped_review", { workflowId: "review-1" }],
        ["cancel_looped_review", { workflowId: "review-1" }],
        ["get_looped_review_provider_session", { workflowId: "review-1" }],
      ];
      for (const [command, args] of calls) {
        await expect(invoke(command, args))
          .rejects.toThrow("Looped review supervisor is unavailable");
      }
    });
  });
});

describe("multi review commands", () => {
  const startInput = {
    environmentId: "e1", projectId: "proj-1", targetBranch: "main",
    reviewers: [
      { agent: "claude", model: "opus" },
      { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    ],
    fixModel: { agent: "codex", model: "gpt-5.6" },
  } as const;

  test("delegates lifecycle intents and strips the backend controller fence", async () => {
    const workflow = (operation: string) => ({
      operation, id: "multi-1", phase: "reviewing", controllerFence: "secret-fence",
    });
    const start = mock(async (_input: unknown) => workflow("start"));
    const address = mock(async (id: string) => ({ ...workflow("address"), id }));
    const retry = mock(async (id: string) => ({ ...workflow("retry"), id }));
    const cancel = mock(async (id: string) => ({ ...workflow("cancel"), id }));
    const supervisor = { start, address, retry, cancel } as unknown as NonNullable<CommandContext["multiReviews"]>;

    await withCommands(async (invoke) => {
      const calls: Array<[string, Record<string, unknown>]> = [
        ["start_multi_review", startInput as unknown as Record<string, unknown>],
        ["address_multi_review", { workflowId: "multi-1" }],
        ["retry_multi_review", { workflowId: "multi-1" }],
        ["cancel_multi_review", { workflowId: "multi-1" }],
      ];
      for (const [command, args] of calls) {
        const result = await invoke(command, args) as Record<string, unknown>;
        expect(result).not.toHaveProperty("controllerFence");
        expect(result.id).toBe("multi-1");
      }
      expect(start).toHaveBeenCalledWith(startInput);
      expect(address).toHaveBeenCalledWith("multi-1");
      expect(retry).toHaveBeenCalledWith("multi-1");
      expect(cancel).toHaveBeenCalledWith("multi-1");
    }, { multiReviews: supervisor });
  });

  test("rejects malformed start and lifecycle requests before supervision", async () => {
    const start = mock(async () => undefined);
    const lifecycle = mock(async () => undefined);
    const supervisor = { start, address: lifecycle, retry: lifecycle, cancel: lifecycle } as unknown as NonNullable<CommandContext["multiReviews"]>;
    await withCommands(async (invoke) => {
      await expect(invoke("start_multi_review", {
        ...startInput,
        reviewers: [{ ...startInput.reviewers[0], id: "renderer-injected" }],
      })).rejects.toThrow("Invalid multi review start request");
      await expect(invoke("address_multi_review", { workflowId: " " }))
        .rejects.toThrow("non-blank string");
      expect(start).not.toHaveBeenCalled();
      expect(lifecycle).not.toHaveBeenCalled();
    }, { multiReviews: supervisor });
  });

  test("delegates authoritative reviewer transcript reads", async () => {
    const reviewerTranscript = mock(async (workflowId: string, reviewerId: string) => ({
      workflowId, reviewerId, agent: "codex", model: "gpt-5.6",
      status: "running", messages: [{ id: "progress" }],
    }));
    const supervisor = { reviewerTranscript } as unknown as NonNullable<CommandContext["multiReviews"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("get_multi_review_reviewer_transcript", {
        workflowId: "multi-1", reviewerId: "reviewer-1",
      })).resolves.toMatchObject({
        workflowId: "multi-1", reviewerId: "reviewer-1", messages: [{ id: "progress" }],
      });
      expect(reviewerTranscript).toHaveBeenCalledWith("multi-1", "reviewer-1");
      await expect(invoke("get_multi_review_reviewer_transcript", {
        workflowId: "multi-1", reviewerId: " ",
      })).rejects.toThrow("non-blank string");
    }, { multiReviews: supervisor });
  });
});

describe("build pipeline commands", () => {
  const startInput = {
    taskId: "task-1",
    projectId: "proj-1",
    environmentType: "local",
    agentType: "codex",
    taskTitle: "Implement the feature",
    taskSnapshot: {
      title: "Implement the feature",
      description: "Do the work",
      acceptanceCriteria: "It works",
      comments: [],
      images: [],
    },
  } as const;

  test("delegates lifecycle operations to the backend supervisor", async () => {
    const start = mock(async (input: unknown) => ({ operation: "start", input }));
    const pause = mock(async (id: string) => ({ operation: "pause", id }));
    const resume = mock(async (id: string) => ({ operation: "resume", id }));
    const cancel = mock(async (id: string) => ({ operation: "cancel", id }));
    const retryCompletionComment = mock(async (id: string) => ({
      operation: "retry",
      id,
    }));
    const remove = mock(async (id: string) => ({ operation: "remove", id }));
    const sendMessage = mock(async (id: string, text: string) => ({
      operation: "send",
      id,
      text,
    }));
    const retryReview = mock(async (id: string) => ({
      operation: "retry-review",
      id,
    }));
    const retryStage = mock(async (id: string) => ({
      operation: "retry-stage",
      id,
    }));
    const retryInteractionFailure = mock(async (id: string) => ({
      operation: "retry-interaction",
      id,
    }));
    const supervisor = {
      start,
      pause,
      resume,
      cancel,
      retryCompletionComment,
      remove,
      sendMessage,
      retryReview,
      retryStage,
      retryInteractionFailure,
    } as unknown as NonNullable<CommandContext["buildPipelines"]>;

    await withCommands(async (invoke, storage) => {
      await expect(invoke("start_build_pipeline", startInput))
        .resolves.toMatchObject({ operation: "start" });
      await expect(invoke("pause_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "pause", id: "pipeline-1" });
      await expect(invoke("resume_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "resume", id: "pipeline-1" });
      await expect(invoke("cancel_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "cancel", id: "pipeline-1" });
      await expect(invoke("retry_build_pipeline_completion_comment", {
        pipelineId: "pipeline-1",
      })).resolves.toEqual({ operation: "retry", id: "pipeline-1" });
      await expect(invoke("send_build_pipeline_message", {
        pipelineId: "pipeline-1",
        text: "also update the README",
      })).resolves.toEqual({
        operation: "send",
        id: "pipeline-1",
        text: "also update the README",
      });
      await expect(invoke("retry_build_pipeline_review", {
        pipelineId: "pipeline-1",
      })).resolves.toEqual({ operation: "retry-review", id: "pipeline-1" });
      await expect(invoke("retry_build_pipeline_stage", {
        pipelineId: "pipeline-1",
      })).resolves.toEqual({ operation: "retry-stage", id: "pipeline-1" });
      await expect(invoke("retry_build_pipeline_interaction_failure", {
        pipelineId: "pipeline-1",
      })).resolves.toEqual({ operation: "retry-interaction", id: "pipeline-1" });

      await storage.saveBuildPipeline("pipeline-1", "proj-1", "e1", 1, {
        id: "pipeline-1",
      });
      await expect(invoke("delete_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toEqual({ operation: "remove", id: "pipeline-1" });
      expect(await storage.getBuildPipeline("pipeline-1")).not.toBeNull();

      expect(start).toHaveBeenCalledWith(startInput);
      expect(pause).toHaveBeenCalledWith("pipeline-1");
      expect(resume).toHaveBeenCalledWith("pipeline-1");
      expect(cancel).toHaveBeenCalledWith("pipeline-1");
      expect(retryCompletionComment).toHaveBeenCalledWith("pipeline-1");
      expect(remove).toHaveBeenCalledWith("pipeline-1");
      expect(sendMessage)
        .toHaveBeenCalledWith("pipeline-1", "also update the README");
      expect(retryReview).toHaveBeenCalledWith("pipeline-1");
      expect(retryStage).toHaveBeenCalledWith("pipeline-1");
      expect(retryInteractionFailure).toHaveBeenCalledWith("pipeline-1");
    }, { buildPipelines: supervisor });
  });

  test("validates lifecycle arguments before invoking the supervisor", async () => {
    const start = mock(async () => undefined);
    const pause = mock(async () => undefined);
    const supervisor = {
      start,
      pause,
      resume: pause,
      cancel: pause,
      retryCompletionComment: pause,
      remove: pause,
    } as unknown as NonNullable<CommandContext["buildPipelines"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("start_build_pipeline", {
        ...startInput,
        taskSnapshot: { ...startInput.taskSnapshot, images: "not-an-array" },
      })).rejects.toThrow("Invalid build pipeline start request");
      await expect(invoke("pause_build_pipeline", { pipelineId: "   " }))
        .rejects.toThrow("non-blank string");
      await expect(invoke("resume_build_pipeline", { pipelineId: 7 }))
        .rejects.toThrow("string");
      await expect(invoke("cancel_build_pipeline", {}))
        .rejects.toThrow("string");
      await expect(invoke("retry_build_pipeline_completion_comment", {
        pipelineId: "",
      })).rejects.toThrow("non-blank string");
      await expect(invoke("retry_build_pipeline_interaction_failure", {
        pipelineId: " ",
      })).rejects.toThrow("non-blank string");
      await expect(invoke("delete_build_pipeline", { pipelineId: " " }))
        .rejects.toThrow("non-blank string");
      await expect(invoke("get_build_pipeline", { pipelineId: "" }))
        .rejects.toThrow("non-blank string");
      await expect(invoke("list_build_pipelines", { projectId: " " }))
        .rejects.toThrow("non-blank string");

      expect(start).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    }, { buildPipelines: supervisor });
  });

  test("imports legacy snapshots only through the backend supervisor", async () => {
    const importLegacy = mock(async (projectId: string, snapshots: unknown[]) => ({
      importedIds: snapshots.map((_, index) => `${projectId}-${index}`),
      skipped: 0,
    }));
    const snapshots = [{ id: "legacy-1" }, { id: "legacy-2" }];
    const supervisor = {
      importLegacy,
    } as unknown as NonNullable<CommandContext["buildPipelines"]>;

    await withCommands(async (invoke) => {
      await expect(invoke("import_legacy_build_pipelines", {
        projectId: "proj-1",
        snapshots,
      })).resolves.toEqual({
        importedIds: ["proj-1-0", "proj-1-1"],
        skipped: 0,
      });
      expect(importLegacy).toHaveBeenCalledWith("proj-1", snapshots);

      await expect(invoke("import_legacy_build_pipelines", {
        projectId: " ",
        snapshots,
      })).rejects.toThrow("non-blank string");
      await expect(invoke("import_legacy_build_pipelines", {
        projectId: "proj-1",
        snapshots: {},
      })).rejects.toThrow("snapshots to be an array");
      await expect(invoke("import_legacy_build_pipelines", {
        projectId: "proj-1",
        snapshots: Array.from({ length: 101 }, () => ({})),
      })).rejects.toThrow("limited to 100 snapshots");
      expect(importLegacy).toHaveBeenCalledTimes(1);
    }, { buildPipelines: supervisor });
  });

  test("reports unavailable supervision and keeps deletion recoverable", async () => {
    await withCommands(async (invoke, storage) => {
      for (const [command, args] of [
        ["start_build_pipeline", startInput],
        ["pause_build_pipeline", { pipelineId: "pipeline-1" }],
        ["resume_build_pipeline", { pipelineId: "pipeline-1" }],
        ["cancel_build_pipeline", { pipelineId: "pipeline-1" }],
        ["retry_build_pipeline_completion_comment", { pipelineId: "pipeline-1" }],
        ["send_build_pipeline_message", {
          pipelineId: "pipeline-1",
          text: "hello",
        }],
        ["retry_build_pipeline_review", { pipelineId: "pipeline-1" }],
        ["retry_build_pipeline_stage", { pipelineId: "pipeline-1" }],
        ["retry_build_pipeline_interaction_failure", {
          pipelineId: "pipeline-1",
        }],
        ["import_legacy_build_pipelines", {
          projectId: "proj-1",
          snapshots: [],
        }],
      ] as const) {
        await expect(invoke(command, args))
          .rejects.toThrow("Build pipeline supervisor is unavailable");
      }

      await storage.saveBuildPipeline("pipeline-1", "proj-1", "e1", 1, {
        id: "pipeline-1",
      });
      await expect(invoke("delete_build_pipeline", { pipelineId: "pipeline-1" }))
        .resolves.toBeUndefined();
      expect(await storage.getBuildPipeline("pipeline-1")).toBeNull();
    });
  });

  test("rejects client-authored snapshots while preserving reads and deletion", async () => {
    await withCommands(async (invoke, storage) => {
      await expect(invoke("save_build_pipeline", {
        pipelineId: "p1",
        projectId: "proj-1",
        environmentId: "e1",
        version: 1,
        snapshot: { id: "p1", phase: "building" },
      })).rejects.toThrow("backend-owned");

      await storage.saveBuildPipeline("p1", "proj-1", "e1", 2, {
        id: "p1",
        phase: "building",
        controller: "backend",
      });

      await expect(invoke("list_build_pipelines", { projectId: "proj-1" }))
        .resolves.toHaveLength(1);

      await invoke("delete_build_pipeline", { pipelineId: "p1" });
      await expect(invoke("get_build_pipeline", { pipelineId: "p1" })).resolves.toBeNull();
    });
  });

  test("clears every task pipeline before updating the task and deduplicates the linked id", async () => {
    const operations: string[] = [];
    const remove = mock(async (pipelineId: string) => {
      operations.push(`remove:${pipelineId}`);
    });
    const supervisor = {
      remove,
    } as unknown as NonNullable<CommandContext["buildPipelines"]>;

    await withCommands(async (invoke, storage) => {
      const task = await storage.addKanbanTask("proj-1", "Build task", "");
      await storage.updateKanbanTask(task.id, {
        environmentId: "e1",
        buildPipelineId: "pipeline-linked",
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
      });
      await storage.saveBuildPipeline("pipeline-linked", "proj-1", "e1", 1, {
        taskId: task.id,
      });
      await storage.saveBuildPipeline("pipeline-secondary", "proj-1", "e1", 1, {
        taskId: task.id,
      });
      await storage.saveBuildPipeline("pipeline-unrelated", "proj-1", "e1", 1, {
        taskId: "another-task",
      });

      const updateKanbanTask = storage.updateKanbanTask.bind(storage);
      const updateSpy = spyOn(storage, "updateKanbanTask").mockImplementation(
        async (taskId, updates, expectedProjectId) => {
          operations.push(`update:${taskId}`);
          return updateKanbanTask(taskId, updates, expectedProjectId);
        },
      );

      const result = await invoke("clear_task_build_status", {
        taskId: task.id,
      }) as {
        task: { id: string; environmentId?: string; buildPipelineId?: string; prUrl?: string };
        removedPipelineIds: string[];
      };

      expect(result.removedPipelineIds).toEqual([
        "pipeline-linked",
        "pipeline-secondary",
      ]);
      expect(result.task).toMatchObject({ id: task.id, prUrl: "" });
      expect(result.task.environmentId).toBeUndefined();
      expect(result.task.buildPipelineId).toBeUndefined();
      expect(remove.mock.calls.map(([pipelineId]) => pipelineId)).toEqual([
        "pipeline-linked",
        "pipeline-secondary",
      ]);
      expect(operations).toEqual([
        "remove:pipeline-linked",
        "remove:pipeline-secondary",
        `update:${task.id}`,
      ]);
      expect(updateSpy).toHaveBeenCalledWith(task.id, {
        environmentId: undefined,
        buildPipelineId: undefined,
        prUrl: "",
        prState: undefined,
      });
    }, { buildPipelines: supervisor });
  });

  test("falls back to storage deletion when the build-pipeline supervisor is unavailable", async () => {
    await withCommands(async (invoke, storage) => {
      const task = await storage.addKanbanTask("proj-1", "Stored build task", "");
      await storage.updateKanbanTask(task.id, {
        buildPipelineId: "pipeline-stored",
      });
      await storage.saveBuildPipeline("pipeline-stored", "proj-1", "e1", 1, {
        taskId: task.id,
      });

      const operations: string[] = [];
      const deleteBuildPipeline = storage.deleteBuildPipeline.bind(storage);
      const deleteSpy = spyOn(storage, "deleteBuildPipeline").mockImplementation(
        async (pipelineId) => {
          operations.push(`delete:${pipelineId}`);
          await deleteBuildPipeline(pipelineId);
        },
      );
      const updateKanbanTask = storage.updateKanbanTask.bind(storage);
      spyOn(storage, "updateKanbanTask").mockImplementation(
        async (taskId, updates, expectedProjectId) => {
          operations.push(`update:${taskId}`);
          return updateKanbanTask(taskId, updates, expectedProjectId);
        },
      );

      const result = await invoke("clear_task_build_status", {
        taskId: task.id,
      }) as { removedPipelineIds: string[] };

      expect(result.removedPipelineIds).toEqual(["pipeline-stored"]);
      expect(deleteSpy).toHaveBeenCalledWith("pipeline-stored");
      expect(operations).toEqual([
        "delete:pipeline-stored",
        `update:${task.id}`,
      ]);
      expect(await storage.getBuildPipeline("pipeline-stored")).toBeNull();
    });
  });
});

describe("set_environment_unread", () => {
  async function seedEnvironment(storage: StorageService): Promise<void> {
    if (!await storage.getProject("proj-1")) {
      await storage.addProject({
        id: "proj-1", name: "Project", gitUrl: "https://example.com/repo.git",
        localPath: null, order: 0, addedAt: new Date().toISOString(),
      });
    }
    if (!await storage.getEnvironment("e1")) {
      await storage.addEnvironment({
        id: "e1", name: "Env", projectId: "proj-1", status: "running",
        environmentType: "local", branch: "main", order: 0,
        containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
        networkAccessMode: "restricted", createdAt: new Date().toISOString(),
      });
    }
  }

  test("sets and clears the badge on the environment record", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);

      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: true }))
        .resolves.toMatchObject({ id: "e1", hasUnreadWork: true });
      await expect(invoke("set_environment_unread", {
        environmentId: "e1", unread: false, expectedLastActivityAt: null,
      }))
        .resolves.toMatchObject({ id: "e1", hasUnreadWork: false });
    });
  });

  test("treats a non-boolean flag as read rather than marking unread", async () => {
    // asBoolean falls back to false, so a malformed request can only ever clear
    // the badge — never raise one the user has not been given a reason for.
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      await invoke("set_environment_unread", { environmentId: "e1", unread: true });

      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: "yes" }))
        .resolves.toMatchObject({ hasUnreadWork: false });
    });
  });

  test("rejects an unknown environment", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("set_environment_unread", { environmentId: "missing", unread: true }))
        .rejects.toThrow("not found");
    });
  });

  test("does not let a delayed clear erase a newer completion", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const first = "2026-01-01T00:00:00.000Z";
      const second = "2026-01-01T00:00:01.000Z";

      await expect(storage.recordEnvironmentCompletion("e1", first))
        .resolves.toMatchObject({ lastActivityAt: first, hasUnreadWork: true });

      await expect(storage.recordEnvironmentCompletion("e1", second))
        .resolves.toMatchObject({ lastActivityAt: second, hasUnreadWork: true });

      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: first,
      })).resolves.toMatchObject({ lastActivityAt: second, hasUnreadWork: true });
    });
  });

  test("guards an absent activity token with explicit null", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const completion = "2026-01-01T00:00:00.000Z";

      await storage.recordEnvironmentCompletion("e1", completion);
      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: null,
      })).resolves.toMatchObject({ lastActivityAt: completion, hasUnreadWork: true });
    });
  });

  test("rejects a malformed clear token instead of clearing without a guard", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      await invoke("set_environment_unread", { environmentId: "e1", unread: true });

      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: 42,
      })).rejects.toThrow("Expected expectedLastActivityAt to be a string");
      expect(await storage.getEnvironment("e1")).toMatchObject({ hasUnreadWork: true });
    });
  });

  test("ignores a stale completion without raising a new badge", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const newest = "2026-01-01T00:00:01.000Z";
      await storage.recordEnvironmentCompletion("e1", newest);
      await invoke("set_environment_unread", {
        environmentId: "e1", unread: false, expectedLastActivityAt: newest,
      });

      await expect(storage.recordEnvironmentCompletion(
        "e1",
        "2026-01-01T00:00:00.000Z",
      )).resolves.toMatchObject({ lastActivityAt: newest, hasUnreadWork: false });
    });
  });
});

describe("pr monitor commands", () => {
  // The module-level PR monitor service outlives each temporary storage
  // directory; dropping its entries keeps one test's watch requests (and any
  // scheduled polls) from leaking into the next.
  test("pr_monitor_watch validates its arguments", async () => {
    await withCommands(async (invoke) => {
      try {
        await expect(invoke("pr_monitor_watch", {
          environmentId: "e1", mode: "idle",
        })).rejects.toThrow("mode must be normal, create-pending, or merge-pending");
        await expect(invoke("pr_monitor_watch", {
          environmentId: 42, mode: "merge-pending",
        })).rejects.toThrow("Expected environmentId to be a string");
        await expect(invoke("pr_monitor_watch", {
          environmentId: "missing", mode: "merge-pending",
        })).rejects.toThrow("Environment not found: missing");
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("watch requests are durable in the authoritative snapshot", async () => {
    await withCommands(async (invoke) => {
      try {
        const empty = await invoke("get_pr_monitor_state", {});
        expect(isPrMonitorSnapshot(empty)).toBe(true);
        expect((empty as { entries: unknown[] }).entries).toEqual([]);

        await invoke("pr_monitor_watch", { environmentId: "e1", mode: "create-pending" });

        // A later snapshot — the rehydration path a freshly mounted client
        // uses — still carries the pending request; nothing about it lived in
        // the client that asked.
        const snapshot = await invoke("get_pr_monitor_state", {}) as {
          entries: Array<Record<string, unknown>>;
        };
        expect(isPrMonitorSnapshot(snapshot)).toBe(true);
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
          environmentId: "e1",
          mode: "create-pending",
          prUrl: null,
          consecutiveErrors: 0,
        });

        await expect(invoke("pr_monitor_refresh", { environmentId: "e1" })).resolves.toBeUndefined();
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("conflict-resolution refresh intent is durable and backend-only", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });

        const armedAt = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        }) as string;

        const armed = await storage.getEnvironment("e1");
        expect(armed?.prRecheckAfterAgentCompletionArmedAt).toEqual(expect.any(String));
        expect(armed?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);
        expect(toClientEnvironment(armed!)).not.toHaveProperty(
          "prRecheckAfterAgentCompletionArmedAt",
        );

        // A backend completion edge schedules the monitor but does not consume
        // the intent before GitHub confirms the conflict is actually gone.
        await invoke("pr_monitor_agent_turn_completed", { environmentId: "e1" });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(
            armed?.prRecheckAfterAgentCompletionArmedAt,
          );

        // GitHub's indeterminate result must not consume the durable request.
        await invoke("set_environment_pr", {
          environmentId: "e1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: null,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);

        await invoke("set_environment_pr", {
          environmentId: "e1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: false,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();

        const refusedArm = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        });
        expect(refusedArm).toBeNull();
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();

        await storage.updateEnvironment("e1", {
          prState: "open",
          hasMergeConflicts: true,
        });
        await invoke("arm_pr_refresh_after_agent_completion", { environmentId: "e1" });
        await invoke("set_environment_pr", {
          environmentId: "e1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "merged",
          hasMergeConflicts: null,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();

        await storage.updateEnvironment("e1", {
          prState: "open",
          hasMergeConflicts: true,
        });
        const disappearanceArm = await invoke(
          "arm_pr_refresh_after_agent_completion",
          { environmentId: "e1" },
        ) as string;
        const knownRequest = getPrMonitorDetectionRequest({
          environmentId: "e1",
          branch: "main",
          kind: "local",
          worktreePath: "/tmp/worktree",
          ready: true,
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        expect(() => parsePrMonitorDetectionResponse(knownRequest, "not-json"))
          .toThrow("Failed to parse gh pr view output");
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(disappearanceArm);

        // The monitor's upstream-disappearance effect uses the same clear.
        await invoke("clear_environment_pr", { environmentId: "e1" });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("set_environment_pr validates required metadata without clearing an arm", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        const armedAt = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        }) as string;

        for (const [args, message] of [
          [{ environmentId: "e1", prUrl: "https://github.com/acme/repo/pull/7", prState: "open" }, "Expected hasMergeConflicts to be a boolean or null"],
          [{ environmentId: "e1", prUrl: "https://github.com/acme/repo/pull/7", prState: "draft", hasMergeConflicts: false }, "Expected prState to be open, merged, or closed"],
          [{ environmentId: "e1", prUrl: "https://github.com/acme/repo/pull/7", prState: "open", hasMergeConflicts: "no" }, "Expected hasMergeConflicts to be a boolean or null"],
          [{ environmentId: "e1", prUrl: "https://github.com/acme/repo/pull/7", prState: "open", hasMergeConflicts: false, extra: true }, "Unexpected arguments field: extra"],
        ] as const) {
          await expect(invoke("set_environment_pr", args)).rejects.toThrow(message);
          expect((await storage.getEnvironment("e1"))
            ?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);
        }
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("returns the rollback token when monitor hydration fails after persistence", async () => {
    await withCommands(async (invoke, storage) => {
      const warning = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        const loadEnvironments = storage.loadEnvironments.bind(storage);
        let calls = 0;
        const loadSpy = spyOn(storage, "loadEnvironments").mockImplementation(async () => {
          calls += 1;
          if (calls === 2) throw new Error("temporary storage read failure");
          return loadEnvironments();
        });

        const armedAt = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        }) as string;
        expect(armedAt).toEqual(expect.any(String));
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(armedAt);
        expect(warning).toHaveBeenCalledWith(
          "[pr-monitor] Failed to track armed environment e1:",
          "temporary storage read failure",
        );
        loadSpy.mockRestore();
      } finally {
        warning.mockRestore();
        shutdownPrMonitorTracking();
      }
    });
  });

  test("token-safe disarm cannot clear a newer Resolve request", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        const first = await invoke("arm_pr_refresh_after_agent_completion", { environmentId: "e1" }) as string;
        const second = await invoke("arm_pr_refresh_after_agent_completion", { environmentId: "e1" }) as string;
        expect(second).not.toBe(first);

        await invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
          armedAt: first,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(second);

        await expect(invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        })).rejects.toThrow("Expected armedAt to be a string");
        await expect(invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
          armedAt: 123,
        })).rejects.toThrow("Expected armedAt to be a string");
        await expect(invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
          armedAt: second,
          extra: true,
        })).rejects.toThrow("Unexpected arguments field: extra");
        await expect(invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
          extra: true,
        })).rejects.toThrow("Unexpected arguments field: extra");
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(second);

        await invoke("disarm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
          armedAt: second,
        });
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("a refused arm never returns a token owned by an earlier Resolve request", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: true,
        });
        const first = await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        }) as string;
        await storage.updateEnvironment("e1", { hasMergeConflicts: null });

        expect(await invoke("arm_pr_refresh_after_agent_completion", {
          environmentId: "e1",
        })).toBeNull();
        expect((await storage.getEnvironment("e1"))
          ?.prRecheckAfterAgentCompletionArmedAt).toBe(first);
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("snapshot reconciliation tracks environments with a stored PR", async () => {
    await withCommands(async (invoke, storage) => {
      try {
        await storage.updateEnvironment("e1", {
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: false,
        });

        const snapshot = await invoke("get_pr_monitor_state", {}) as {
          entries: Array<Record<string, unknown>>;
        };
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
          environmentId: "e1",
          mode: "normal",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
        });
      } finally {
        shutdownPrMonitorTracking();
      }
    });
  });

  test("production detection uses branch discovery only until a PR URL is known", () => {
    const discovery = getPrMonitorDetectionRequest({
      environmentId: "e1",
      branch: "feature/pr-monitor",
      kind: "local",
      worktreePath: "/tmp/worktree",
      ready: true,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
    });
    expect(discovery.args).toEqual([
      "pr", "list", "--head", "feature/pr-monitor", "--state", "all",
      "--limit", "30", "--json", "url,state,mergeable,updatedAt",
    ]);
    expect(discovery.knownPrUrl).toBeNull();

    const known = getPrMonitorDetectionRequest({
      environmentId: "e1",
      branch: "feature/pr-monitor",
      kind: "container",
      containerId: "container-1",
      ready: true,
      prUrl: "https://github.com/acme/repo/pull/7",
      prState: "open",
      hasMergeConflicts: null,
    });
    expect(known.args).toEqual([
      "pr", "view", "https://github.com/acme/repo/pull/7",
      "--json", "url,state,mergeable",
    ]);
    expect(known.shellCommand).toBe(
      "gh pr view 'https://github.com/acme/repo/pull/7' --json url,state,mergeable",
    );
    expect(parsePrMonitorDetectionResponse(known, JSON.stringify({
      url: "https://github.com/acme/repo/pull/7",
      state: "MERGED",
      mergeable: "UNKNOWN",
    }))).toEqual({
      url: "https://github.com/acme/repo/pull/7",
      state: "merged",
      hasMergeConflicts: null,
    });
    expect(parsePrMonitorDetectionResponse(known, JSON.stringify({
      url: "https://github.com/acme/repo/pull/7",
      state: "OPEN",
    }))).toEqual({
      url: "https://github.com/acme/repo/pull/7",
      state: "open",
      hasMergeConflicts: null,
    });
    expect(() => parsePrMonitorDetectionResponse(known, JSON.stringify({
      url: "https://github.com/acme/repo/pull/8",
      state: "OPEN",
      mergeable: "MERGEABLE",
    }))).toThrow("unexpected pull request metadata");

    const terminal = getPrMonitorDetectionRequest({
      environmentId: "e1",
      branch: "feature/pr-monitor",
      kind: "container",
      containerId: "container-1",
      ready: true,
      prUrl: "https://github.com/acme/repo/pull/7",
      prState: "merged",
      hasMergeConflicts: false,
    });
    expect(terminal.knownPrUrl).toBeNull();
    expect(terminal.args.slice(0, 4)).toEqual([
      "pr", "list", "--head", "feature/pr-monitor",
    ]);
  });

  test("production task lookup resolves direct and build-pipeline environment links", async () => {
    await withCommands(async (_invoke, storage) => {
      const direct = await storage.addKanbanTask("proj-1", "Direct", "");
      await storage.updateKanbanTask(direct.id, {
        environmentId: "e1",
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
      });

      await expect(findKanbanTaskForEnvironment(storage, "e1")).resolves.toMatchObject({
        taskId: direct.id,
        status: "backlog",
        prUrl: "https://github.com/acme/repo/pull/7",
        prState: "open",
      });

      await storage.updateKanbanTask(direct.id, { environmentId: undefined });
      const pipelineTask = await storage.addKanbanTask("proj-1", "Pipeline", "");
      await storage.saveBuildPipeline("pipeline-1", "proj-1", "e1", 1, {
        taskId: pipelineTask.id,
        source: { type: "kanban" },
      });

      await expect(findKanbanTaskForEnvironment(storage, "e1")).resolves.toMatchObject({
        taskId: pipelineTask.id,
        status: "backlog",
      });
      await storage.deleteKanbanTask(pipelineTask.id);
      await expect(findKanbanTaskForEnvironment(storage, "e1")).resolves.toMatchObject({
        taskId: pipelineTask.id,
        status: null,
        prUrl: null,
      });
      await expect(findKanbanTaskForEnvironment(storage, "missing")).resolves.toBeNull();
    });
  });
});

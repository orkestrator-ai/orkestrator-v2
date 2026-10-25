import { describe, expect, mock, test } from "bun:test";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import { openCodeFake } from "./agent-provider-test-support.js";
import type { AppConfig } from "./models.js";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { openCodeCommandChangeJournalDirectory } from "./opencode-command-changes.js";
import { openCodeEnvironmentDependencies } from "./opencode-provider-environment.js";

function config(openCodeModelProviders: string[] | undefined): Pick<AppConfig, "global"> {
  return { global: { openCodeModelProviders } as AppConfig["global"] };
}

describe("openCodeEnvironmentDependencies", () => {
  test("derives nothing without an environment", () => {
    expect(openCodeEnvironmentDependencies(undefined)).toEqual({});
  });

  test("journals shell-change badges per environment under the data directory", () => {
    const dependencies = openCodeEnvironmentDependencies({
      environmentId: "env-1",
      dataDir: "/data",
    });

    expect(dependencies).toEqual({
      commandChanges: {
        journalDirectory: openCodeCommandChangeJournalDirectory("/data", "env-1"),
      },
    });
    // The on-disk location is persisted state; it must not move.
    expect(dependencies.commandChanges?.journalDirectory).toBe(
      openCodeCommandChangeJournalDirectory("/data", "env-1"),
    );
  });

  test("gives a storage double without a data directory no journals", () => {
    expect(openCodeEnvironmentDependencies({ environmentId: "env-1" })).toEqual({});
  });

  test("reads the persisted provider allowlist on every call", async () => {
    let stored: string[] | undefined = ["opencode"];
    const loadConfig = mock(async () => config(stored));
    const dependencies = openCodeEnvironmentDependencies({ environmentId: "env-1", loadConfig });

    expect(dependencies.commandChanges).toBeUndefined();
    expect(loadConfig).not.toHaveBeenCalled();
    await expect(dependencies.resolveOpenCodeModelProviders?.()).resolves.toEqual(["opencode"]);

    stored = ["hpc-ai", "opencode"];
    await expect(dependencies.resolveOpenCodeModelProviders?.()).resolves.toEqual([
      "hpc-ai",
      "opencode",
    ]);
    stored = undefined;
    await expect(dependencies.resolveOpenCodeModelProviders?.()).resolves.toBeUndefined();
    expect(loadConfig).toHaveBeenCalledTimes(3);
  });
});

describe("createNativeAgentProvider environment wiring", () => {
  function catalogFake() {
    const fake = openCodeFake();
    Object.assign(fake.client as object, {
      provider: {
        list: mock(async () => ({
          data: {
            all: [
              { id: "hpc-ai", name: "HPC-AI", models: { flash: { name: "Flash" } } },
              { id: "opencode", name: "OpenCode", models: { kimi: { name: "Kimi" } } },
            ],
            connected: ["hpc-ai", "opencode"],
          },
        })),
      },
    });
    return fake;
  }

  const connection = {
    agent: "opencode" as const,
    baseUrl: "http://opencode.test",
    authToken: "test-token",
    directory: "/workspace",
  };

  test("applies the environment's persisted model allowlist to an OpenCode provider", async () => {
    const fake = catalogFake();
    const provider = createNativeAgentProvider(connection, {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      environment: { environmentId: "env-1", loadConfig: async () => config(["hpc-ai"]) },
    });
    try {
      const models = await provider.modelCatalog?.();
      expect(models?.map((model) => model.id)).toEqual(["hpc-ai/flash"]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("lets an explicit dependency override the environment-derived one", async () => {
    const fake = catalogFake();
    const loadConfig = mock(async () => config(["hpc-ai"]));
    const provider = createNativeAgentProvider(connection, {
      openCodeClient: fake.client,
      openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
      resolveOpenCodeModelProviders: () => ["opencode"],
      environment: { environmentId: "env-1", loadConfig },
    });
    try {
      const models = await provider.modelCatalog?.();
      expect(models?.map((model) => model.id)).toEqual(["opencode/kimi"]);
      expect(loadConfig).not.toHaveBeenCalled();
    } finally {
      await provider.dispose?.();
    }
  });
});

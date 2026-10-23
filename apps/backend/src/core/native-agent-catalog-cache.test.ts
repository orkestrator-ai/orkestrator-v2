import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import type {
  NativeAgentRuntimeProvider,
  ProviderCommandCatalogue,
} from "./agent-provider-contract.js";
import { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import {
  NATIVE_MODEL_CATALOG_CACHE_LIMIT,
  NATIVE_MODEL_CATALOG_TTL_MS,
  type AgentModel,
  type CommandInvoker,
} from "./native-agent-service-shared.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function model(id: string): AgentModel {
  return { id, label: id, platform: "codex" } as AgentModel;
}

function row(name: string): NativeAgentSlashCommand {
  return {
    name,
    source: "project",
    id: `test:${name}`,
    executionKind: "provider-prompt",
    bindingRevision: `rev:${name}`,
  };
}

function commandProvider(commands: NativeAgentSlashCommand[]): NativeAgentRuntimeProvider {
  const catalogue: ProviderCommandCatalogue = {
    enhanced: true,
    status: "ready",
    commands,
    freshness: "ttl",
  };
  return { commandCatalogue: mock(async () => catalogue) } as unknown as NativeAgentRuntimeProvider;
}

function harness(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  let now = 1_000;
  const announce = mock((_environmentId: string) => undefined);
  const catalogs = new NativeAgentCatalogCache({
    invoke: invoke as CommandInvoker,
    now: () => now,
    announce,
  });
  return {
    catalogs,
    announce,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const scope = { environmentId: "env-1", agent: "codex" as const };

describe("NativeAgentCatalogCache models", () => {
  test("coalesces concurrent reads and caches the bounded answer with a TTL", async () => {
    const read = deferred<AgentModel[]>();
    const invoke = mock(async () => read.promise);
    const { catalogs, now } = harness(invoke);

    const first = catalogs.refreshModels("env-1");
    const second = catalogs.refreshModels("env-1");
    read.resolve(Array.from({ length: 600 }, (_, index) => model(`m-${index}`)));

    const [left, right] = await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("get_native_agent_model_catalog", {
      environmentId: "env-1",
    });
    expect(left).toHaveLength(512);
    expect(right).toBe(left);
    expect(catalogs.cachedModels("env-1")).toEqual({
      models: left,
      expiresAt: now() + NATIVE_MODEL_CATALOG_TTL_MS,
    });
  });

  test("an invalidated in-flight read never lands in the cache", async () => {
    const read = deferred<AgentModel[]>();
    const { catalogs } = harness(async () => read.promise);

    const pending = catalogs.refreshModels("env-1");
    catalogs.invalidateModels("env-1");
    read.resolve([model("late")]);

    await expect(pending).rejects.toThrow("Model catalog refresh was invalidated");
    expect(catalogs.cachedModels("env-1")).toBeUndefined();
  });

  test("evicts the oldest environment at the cache limit", async () => {
    const { catalogs } = harness(async () => [model("m")]);
    for (let index = 0; index <= NATIVE_MODEL_CATALOG_CACHE_LIMIT; index += 1) {
      await catalogs.refreshModels(`env-${index}`);
    }
    expect(catalogs.cachedModels("env-0")).toBeUndefined();
    expect(catalogs.cachedModels(`env-${NATIVE_MODEL_CATALOG_CACHE_LIMIT}`)).toBeDefined();
  });

  test("retryModelsAfter backs off only the entry it was given", async () => {
    const { catalogs, advance, now } = harness(async () => [model("m")]);
    await catalogs.refreshModels("env-1");
    const stale = catalogs.cachedModels("env-1")!;
    advance(1);
    await catalogs.refreshModels("env-1");
    const fresh = catalogs.cachedModels("env-1")!;
    const freshExpiry = fresh.expiresAt;

    catalogs.retryModelsAfter("env-1", stale, 5_000);
    expect(catalogs.cachedModels("env-1")?.expiresAt).toBe(freshExpiry);

    catalogs.retryModelsAfter("env-1", fresh, 5_000);
    expect(catalogs.cachedModels("env-1")?.expiresAt).toBe(now() + 5_000);
  });
});

describe("NativeAgentCatalogCache commands", () => {
  test("serves provider commands and merges runtime actions only for slash commands", async () => {
    const { catalogs } = harness(async () => []);
    const provider = commandProvider([row("/review")]);

    const snapshot = await catalogs.commandCatalogue(scope, provider, "session-1");
    expect(snapshot.commands.map((command) => command.name)).toEqual(["/review"]);
    const slash = await catalogs.slashCommands(scope, provider, "session-1");
    expect(slash.map((command) => command.name)).toContain("/review");
    expect(slash.length).toBeGreaterThan(1);
    expect(catalogs.peekCommands(scope, "session-1")?.commands).toEqual(snapshot.commands);
    expect(catalogs.commandExpiresAt(scope, "session-1")).toBeNumber();
  });

  test("an unsupported provider reports an unsupported catalogue without reading", async () => {
    const { catalogs } = harness(async () => []);
    const snapshot = await catalogs.commandCatalogue(
      scope,
      {} as NativeAgentRuntimeProvider,
      "session-1",
    );
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.state.status).toBe("unsupported");
    expect(catalogs.peekCommands(scope, "session-1")).toBeUndefined();
  });

  test("invalidation and environment deletion drop cached commands", async () => {
    const { catalogs } = harness(async () => []);
    const provider = commandProvider([row("/one")]);
    await catalogs.commandCatalogue(scope, provider, "session-1");
    await catalogs.commandCatalogue(scope, provider, "session-2");

    catalogs.invalidateCommands(scope, "session-1");
    expect(catalogs.peekCommands(scope, "session-1")).toBeUndefined();
    expect(catalogs.peekCommands(scope, "session-2")).toBeDefined();

    catalogs.forgetEnvironmentCommands("env-1");
    expect(catalogs.peekCommands(scope, "session-2")).toBeUndefined();
  });

  test("clear drops models and commands, and pendingWork settles", async () => {
    const { catalogs } = harness(async () => [model("m")]);
    await catalogs.refreshModels("env-1");
    await catalogs.commandCatalogue(scope, commandProvider([row("/one")]), "session-1");

    await Promise.allSettled(catalogs.pendingWork());
    catalogs.clear();
    expect(catalogs.cachedModels("env-1")).toBeUndefined();
    expect(catalogs.peekCommands(scope, "session-1")).toBeUndefined();
  });
});

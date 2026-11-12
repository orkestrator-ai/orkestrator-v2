import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInNodeScope,
  renderHookInAppCommandScope,
} from "@/test/render-in-node-scope";
import * as realBackend from "@/lib/backend";
import { configStore } from "@/stores/configStore";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";
import { appCommandStore } from "@/test/app-command-store";

import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { BackendId } from "@orkestrator/protocol/federation";

afterEach(cleanupNodeScopes);

const realBackendSnapshot = { ...realBackend };
const getCachedOpenCodeModelCatalogMock = mock(
  async (_projectId: string): Promise<unknown> => null,
);
const getOpencodeModelPreferencesMock = mock(async (): Promise<unknown> => undefined);
const getProjectSetupRequirementsMock = mock(
  async (_projectId: string): Promise<{ rootSteps: number | null }> => ({ rootSteps: 0 }),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getCachedOpenCodeModelCatalog: getCachedOpenCodeModelCatalogMock,
  getOpencodeModelPreferences: getOpencodeModelPreferencesMock,
  getProjectSetupRequirements: getProjectSetupRequirementsMock,
}));

const { useBuildLaunchOptions, useProjectRootSetupSteps } = await import("./useBuildLaunchOptions");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const baseConfig = appCommandStore(configStore).getState().config;

function flushPromises() {
  return act(async () => {});
}

describe("useBuildLaunchOptions", () => {
  beforeEach(() => {
    cleanup();
    getCachedOpenCodeModelCatalogMock.mockReset();
    getOpencodeModelPreferencesMock.mockReset();
    getCachedOpenCodeModelCatalogMock.mockImplementation(async () => null);
    getOpencodeModelPreferencesMock.mockImplementation(async () => undefined);
    getProjectSetupRequirementsMock.mockReset();
    getProjectSetupRequirementsMock.mockImplementation(async () => ({ rootSteps: 0 }));
    appCommandStore(configStore).setState({ config: baseConfig });
    appCommandStore(agentModelCatalogStore).setState({
      cursorModels: [],
      grokModels: [],
      piModels: [],
    });
  });

  test("resolves OpenCode favorite model refs to ids, deduplicated and in order", async () => {
    getOpencodeModelPreferencesMock.mockImplementation(async () => ({
      favorite: ["provider/model-b", "provider/model-b", "openrouter/multi"],
      recent: [],
      variant: {},
    }));
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.favoriteOpenCodeModelIds).toEqual([
      "provider/model-b",
      "openrouter/multi",
    ]);
  });

  test("normalizes object model refs and drops invalid references", async () => {
    getOpencodeModelPreferencesMock.mockImplementation(async () => ({
      favorite: [
        { providerID: "provider", modelID: "model-a" },
        "single-segment",
        { providerID: "" } as never,
        "",
        { providerID: "provider", modelID: "model-a" },
      ],
      recent: [],
      variant: {},
    }));
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.favoriteOpenCodeModelIds).toEqual(["provider/model-a"]);
  });

  test("does not fetch models or preferences while disabled", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", false));
    await flushPromises();

    expect(getCachedOpenCodeModelCatalogMock).not.toHaveBeenCalled();
    expect(getOpencodeModelPreferencesMock).not.toHaveBeenCalled();
    expect(result.current.favoriteOpenCodeModelIds).toEqual([]);
  });

  test("passes the project's root setup steps to the launcher", async () => {
    getProjectSetupRequirementsMock.mockImplementation(async () => ({ rootSteps: 2 }));
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    expect(result.current.defaults.rootSetupSteps).toBeNull();
    await flushPromises();

    expect(getProjectSetupRequirementsMock).toHaveBeenCalledWith("project-1");
    expect(result.current.defaults.rootSetupSteps).toBe(2);
  });

  test("a machine that cannot answer leaves the root setup steps unknown", async () => {
    getProjectSetupRequirementsMock.mockImplementation(async () => {
      throw new Error("Unknown backend command: get_project_setup_requirements");
    });
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.defaults.rootSetupSteps).toBeNull();
  });

  test("does not read setup requirements while disabled", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", false));
    await flushPromises();

    expect(getProjectSetupRequirementsMock).not.toHaveBeenCalled();
    expect(result.current.defaults.rootSetupSteps).toBeNull();
  });

  test("loads preferences without a project but skips the project catalog", async () => {
    getOpencodeModelPreferencesMock.mockImplementation(async () => ({
      favorite: ["provider/model-b"],
      recent: [],
      variant: {},
    }));
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("", true));
    await flushPromises();

    expect(getCachedOpenCodeModelCatalogMock).not.toHaveBeenCalled();
    expect(result.current.favoriteOpenCodeModelIds).toEqual(["provider/model-b"]);
  });

  test("builds the OpenCode catalog from the project's cached models", async () => {
    getCachedOpenCodeModelCatalogMock.mockImplementation(async (projectId: string) =>
      projectId === "project-1"
        ? {
            projectId: "project-1",
            models: [
              {
                id: "provider/model-a",
                name: "OpenCode A",
                provider: "Provider A",
              },
            ],
          }
        : null,
    );
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    const opencode = result.current.catalog.opencode ?? [];
    expect(opencode.map((model) => model.id)).toEqual(["provider/model-a"]);
    expect(opencode[0]?.providerLabel).toBe("Provider A");
    expect(opencode[0]?.description).toBe("Provider A");
  });

  test("reloads the project catalogue after a host refresh", async () => {
    let modelId = "provider/model-a";
    getCachedOpenCodeModelCatalogMock.mockImplementation(async () => ({
      projectId: "project-1",
      models: [{ id: modelId, name: modelId, provider: "provider" }],
    }));
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();
    expect(result.current.catalog.opencode?.map((model) => model.id)).toEqual(["provider/model-a"]);

    modelId = "provider/model-b";
    act(() => window.dispatchEvent(new Event("orkestrator:model-catalog-refreshed")));
    await flushPromises();

    expect(getCachedOpenCodeModelCatalogMock).toHaveBeenCalledTimes(2);
    expect(result.current.catalog.opencode?.map((model) => model.id)).toEqual(["provider/model-b"]);
  });

  test("synthesises configured pipeline OpenCode models before a cached catalogue exists", async () => {
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          agentSettings: {
            ...baseConfig.global.agentSettings,
            actionDefaults: {
              review: {
                platform: "opencode",
                model: "opencode-go/build-review",
              },
              verify: {
                platform: "opencode",
                model: "opencode-go/build-verify",
              },
            },
          },
        },
      },
    });
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.catalog.opencode?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["opencode-go/build-review", "opencode-go/build-verify"]),
    );
    expect(result.current.defaults.pipelineDefaults.steps.review).toEqual({
      agent: "opencode",
      model: "opencode-go/build-review",
    });
  });

  test("includes favourited OpenCode models before a cached catalogue exists", async () => {
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          favoriteModels: [{ platform: "opencode", modelId: "opencode-go/deepseek-v4-flash" }],
        },
      },
    });
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.catalog.opencode).toEqual([
      expect.objectContaining({
        id: "opencode-go/deepseek-v4-flash",
        name: "deepseek-v4-flash",
        description: "opencode-go",
      }),
    ]);
  });

  test("does not synthesize a favourite from an excluded OpenCode provider", async () => {
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          favoriteModels: [{ platform: "opencode", modelId: "openrouter/kimi-k2.5" }],
          openCodeModelProviders: ["opencode", "opencode-go"],
        },
      },
    });
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.catalog.opencode?.map((model) => model.id)).toEqual(["default"]);
  });

  test("reacts to shared backend-hydrated Cursor and Pi catalogues", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.catalog.cursor?.map((model) => model.id)).toEqual(["default"]);
    act(() => {
      appCommandStore(agentModelCatalogStore)
        .getState()
        .setAcpModels([
          {
            platform: "cursor",
            id: "composer-2.5",
            label: "Composer 2.5",
          },
          {
            platform: "pi",
            id: "anthropic/claude-pi",
            label: "Claude Pi",
          },
        ]);
    });

    expect(result.current.catalog.cursor?.map((model) => model.id)).toEqual(["composer-2.5"]);
    expect(result.current.catalog.pi?.map((model) => model.id)).toEqual([
      "default",
      "anthropic/claude-pi",
    ]);
  });

  test("ignores a cached catalog snapshot that belongs to another project", async () => {
    getCachedOpenCodeModelCatalogMock.mockImplementation(async () => ({
      projectId: "other-project",
      models: [{ id: "other/model", name: "Other", provider: "Other" }],
    }));
    const { result } = renderHookInAppCommandScope(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    const opencode = result.current.catalog.opencode ?? [];
    expect(opencode.map((model) => model.id)).not.toContain("other/model");
  });

  test("discards a stale catalog result after the project changes", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    getCachedOpenCodeModelCatalogMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    getOpencodeModelPreferencesMock.mockImplementation(async () => ({
      favorite: ["provider/model-b"],
      recent: [],
      variant: {},
    }));

    const { result, rerender } = renderHookInAppCommandScope(
      (props: { projectId: string }) => useBuildLaunchOptions(props.projectId, true),
      { initialProps: { projectId: "project-1" } },
    );

    // project-2's fetch resolves immediately; project-1's stays pending.
    getCachedOpenCodeModelCatalogMock.mockImplementation(async () => null);
    rerender({ projectId: "project-2" });
    await flushPromises();

    await act(async () => {
      resolveFirst?.({
        projectId: "project-1",
        models: [{ id: "stale/model", name: "Stale", provider: "Stale" }],
      });
      await Promise.resolve();
    });

    const opencode = result.current.catalog.opencode ?? [];
    expect(opencode.map((model) => model.id)).not.toContain("stale/model");
  });
});

for (const fails of [false, true]) {
  test(`hydrates the selected leaf node catalogue, including cache failure: ${fails}`, async () => {
    const command = new FakeNodeClient({ nodeId: "bk_command-catalog" as BackendId });
    const { windowScope, scope: commandScope } = renderInNodeScope(<div />, { client: command });
    commandScope.store(agentModelCatalogStore).setState({
      cursorModels: [{ platform: "cursor", id: "command-only", label: "Command only" }],
    });
    const leaf = new FakeNodeClient({
      nodeId: "bk_leaf-catalog" as BackendId,
      invoke: {
        get_agent_model_catalog_cache: () => {
          if (fails) throw new Error("cache unavailable");
          return {
            cursor: { models: [{ platform: "cursor", id: "leaf-only", label: "Leaf only" }] },
          };
        },
        get_cached_opencode_model_catalog: null,
        get_opencode_model_preferences: {
          favorite: ["provider/favorite"],
          recent: [],
          variant: {},
        },
      },
    });
    const scope = windowScope.open({ role: "leaf", client: leaf });
    scope.store(agentModelCatalogStore).setState({ cursorModels: [] });
    const { result, unmount } = renderHook(() => useBuildLaunchOptions("project-1", true), {
      wrapper: ({ children }) => (
        <WindowScopeProvider windowScope={windowScope}>
          <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
        </WindowScopeProvider>
      ),
    });
    await flushPromises();
    expect(leaf.calls("get_agent_model_catalog_cache")).toHaveLength(1);
    expect(command.calls("get_agent_model_catalog_cache")).toHaveLength(0);
    expect(result.current.catalog.cursor?.map((model) => model.id)).toEqual(
      fails ? ["default"] : ["leaf-only"],
    );
    expect(commandScope.store(agentModelCatalogStore).getState().cursorModels[0]?.id).toBe(
      "command-only",
    );
    // A failed hydration still leaves defaults, fallback models and saved preferences usable.
    expect(result.current.catalog.claude.length).toBeGreaterThan(0);
    expect(result.current.defaults.pipelineDefaults.steps.review?.agent).toBeTruthy();
    expect(result.current.favoriteOpenCodeModelIds).toEqual(["provider/favorite"]);
    unmount();
  });
}

type SetupAnswer = { rootSteps: number | null };

function deferred() {
  let resolve: (value: SetupAnswer) => void = () => undefined;
  const promise = new Promise<SetupAnswer>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("useProjectRootSetupSteps", () => {
  beforeEach(() => {
    cleanup();
    getProjectSetupRequirementsMock.mockReset();
  });

  test("a read for the previous project never overwrites the current one", async () => {
    const first = deferred();
    getProjectSetupRequirementsMock.mockImplementation((projectId) =>
      projectId === "project-1" ? first.promise : Promise.resolve({ rootSteps: 0 }),
    );
    const { result, rerender } = renderHookInAppCommandScope(
      (props: { projectId: string }) => useProjectRootSetupSteps(props.projectId, true),
      { initialProps: { projectId: "project-1" } },
    );
    await flushPromises();
    rerender({ projectId: "project-2" });
    await flushPromises();
    expect(result.current).toBe(0);

    await act(async () => {
      first.resolve({ rootSteps: 5 });
      await Promise.resolve();
    });
    expect(result.current).toBe(0);
  });

  test("another project shows nothing until its own read lands", async () => {
    const second = deferred();
    getProjectSetupRequirementsMock.mockImplementation((projectId) =>
      projectId === "project-1" ? Promise.resolve({ rootSteps: 3 }) : second.promise,
    );
    const { result, rerender } = renderHookInAppCommandScope(
      (props: { projectId: string }) => useProjectRootSetupSteps(props.projectId, true),
      { initialProps: { projectId: "project-1" } },
    );
    await flushPromises();
    expect(result.current).toBe(3);

    rerender({ projectId: "project-2" });
    await flushPromises();
    expect(result.current).toBeNull();
    await act(async () => {
      second.resolve({ rootSteps: 1 });
      await Promise.resolve();
    });
    expect(result.current).toBe(1);
  });

  test("a read from the previous machine never overwrites the current machine's", async () => {
    const slow = deferred();
    const command = new FakeNodeClient({ nodeId: "bk_command-setup" as BackendId });
    const { windowScope } = renderInNodeScope(<div />, { client: command });
    const studio = new FakeNodeClient({
      nodeId: "bk_studio-setup" as BackendId,
      invoke: { get_project_setup_requirements: () => slow.promise },
    });
    const build = new FakeNodeClient({
      nodeId: "bk_build-setup" as BackendId,
      invoke: { get_project_setup_requirements: { rootSteps: 0 } },
    });
    const studioScope = windowScope.open({ role: "leaf", client: studio });
    const buildScope = windowScope.open({ role: "leaf", client: build });
    let current: NodeScope = studioScope;
    const { result, rerender } = renderHook(() => useProjectRootSetupSteps("project-1", true), {
      wrapper: ({ children }) => (
        <WindowScopeProvider windowScope={windowScope}>
          <NodeScopeProvider scope={current}>{children}</NodeScopeProvider>
        </WindowScopeProvider>
      ),
    });
    await flushPromises();
    expect(studio.calls("get_project_setup_requirements")).toHaveLength(1);

    current = buildScope;
    rerender();
    await flushPromises();
    expect(build.calls("get_project_setup_requirements")).toHaveLength(1);
    expect(result.current).toBe(0);

    await act(async () => {
      slow.resolve({ rootSteps: 4 });
      await Promise.resolve();
    });
    expect(result.current).toBe(0);
  });

  test("another machine does not inherit this machine's answer while its read is pending", async () => {
    const slow = deferred();
    const command = new FakeNodeClient({ nodeId: "bk_command-setup-2" as BackendId });
    const { windowScope } = renderInNodeScope(<div />, { client: command });
    const studio = new FakeNodeClient({
      nodeId: "bk_studio-setup-2" as BackendId,
      invoke: { get_project_setup_requirements: { rootSteps: 2 } },
    });
    const build = new FakeNodeClient({
      nodeId: "bk_build-setup-2" as BackendId,
      invoke: { get_project_setup_requirements: () => slow.promise },
    });
    const studioScope = windowScope.open({ role: "leaf", client: studio });
    const buildScope = windowScope.open({ role: "leaf", client: build });
    let current: NodeScope = studioScope;
    const { result, rerender } = renderHook(() => useProjectRootSetupSteps("project-1", true), {
      wrapper: ({ children }) => (
        <WindowScopeProvider windowScope={windowScope}>
          <NodeScopeProvider scope={current}>{children}</NodeScopeProvider>
        </WindowScopeProvider>
      ),
    });
    await flushPromises();
    expect(result.current).toBe(2);

    current = buildScope;
    rerender();
    expect(result.current).toBeNull();
    await act(async () => {
      slow.resolve({ rootSteps: 0 });
      await Promise.resolve();
    });
    expect(result.current).toBe(0);
  });

  test("closing hides the count and reopening reads it again", async () => {
    getProjectSetupRequirementsMock.mockImplementation(async () => ({ rootSteps: 1 }));
    const { result, rerender } = renderHookInAppCommandScope(
      (props: { open: boolean }) => useProjectRootSetupSteps("project-1", props.open),
      { initialProps: { open: true } },
    );
    await flushPromises();
    expect(result.current).toBe(1);

    rerender({ open: false });
    expect(result.current).toBeNull();

    const reopened = deferred();
    getProjectSetupRequirementsMock.mockImplementation(() => reopened.promise);
    rerender({ open: true });
    await flushPromises();
    // The closed launcher's answer is not shown again while the fresh read runs.
    expect(result.current).toBeNull();
    await act(async () => {
      reopened.resolve({ rootSteps: 3 });
      await Promise.resolve();
    });
    expect(result.current).toBe(3);
    expect(getProjectSetupRequirementsMock).toHaveBeenCalledTimes(2);
  });

  test("a read that settles after closing is dropped", async () => {
    const pending = deferred();
    getProjectSetupRequirementsMock.mockImplementation(() => pending.promise);
    const { result, rerender } = renderHookInAppCommandScope(
      (props: { open: boolean }) => useProjectRootSetupSteps("project-1", props.open),
      { initialProps: { open: true } },
    );
    await flushPromises();
    rerender({ open: false });
    await act(async () => {
      pending.resolve({ rootSteps: 2 });
      await Promise.resolve();
    });
    expect(result.current).toBeNull();

    getProjectSetupRequirementsMock.mockImplementation(async () => ({ rootSteps: 0 }));
    rerender({ open: true });
    await flushPromises();
    expect(result.current).toBe(0);
  });
});

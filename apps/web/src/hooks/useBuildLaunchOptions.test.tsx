import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { useConfigStore } from "@/stores/configStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";

const realBackendSnapshot = { ...realBackend };
const getCachedOpenCodeModelCatalogMock = mock(
  async (_projectId: string): Promise<unknown> => null,
);
const getOpencodeModelPreferencesMock = mock(async (): Promise<unknown> => undefined);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getCachedOpenCodeModelCatalog: getCachedOpenCodeModelCatalogMock,
  getOpencodeModelPreferences: getOpencodeModelPreferencesMock,
}));

const { useBuildLaunchOptions } = await import("./useBuildLaunchOptions");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const baseConfig = useConfigStore.getState().config;

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
    useConfigStore.setState({ config: baseConfig });
    useAgentModelCatalogStore.setState({ cursorModels: [], grokModels: [] });
  });

  test("resolves OpenCode favorite model refs to ids, deduplicated and in order", async () => {
    getOpencodeModelPreferencesMock.mockImplementation(async () => ({
      favorite: ["provider/model-b", "provider/model-b", "openrouter/multi"],
      recent: [],
      variant: {},
    }));
    const { result } = renderHook(() => useBuildLaunchOptions("project-1", true));
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
    const { result } = renderHook(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.favoriteOpenCodeModelIds).toEqual(["provider/model-a"]);
  });

  test("does not fetch models or preferences while disabled", async () => {
    const { result } = renderHook(() => useBuildLaunchOptions("project-1", false));
    await flushPromises();

    expect(getCachedOpenCodeModelCatalogMock).not.toHaveBeenCalled();
    expect(getOpencodeModelPreferencesMock).not.toHaveBeenCalled();
    expect(result.current.favoriteOpenCodeModelIds).toEqual([]);
  });

  test("loads preferences without a project but skips the project catalog", async () => {
    getOpencodeModelPreferencesMock.mockImplementation(async () => ({
      favorite: ["provider/model-b"],
      recent: [],
      variant: {},
    }));
    const { result } = renderHook(() => useBuildLaunchOptions("", true));
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
              { id: "provider/model-a", name: "OpenCode A", provider: "Provider A" },
            ],
          }
        : null);
    const { result } = renderHook(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    const opencode = result.current.catalog.opencode ?? [];
    expect(opencode.map((model) => model.id)).toEqual(["provider/model-a"]);
    expect(opencode[0]?.description).toBe("Provider A");
  });

  test("reacts to the shared backend-hydrated Cursor catalogue", async () => {
    const { result } = renderHook(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    expect(result.current.catalog.cursor?.map((model) => model.id)).toEqual(["default"]);
    act(() => {
      useAgentModelCatalogStore.getState().setAcpModels([{
        platform: "cursor",
        id: "composer-2.5",
        label: "Composer 2.5",
      }]);
    });

    expect(result.current.catalog.cursor?.map((model) => model.id))
      .toEqual(["composer-2.5"]);
  });

  test("ignores a cached catalog snapshot that belongs to another project", async () => {
    getCachedOpenCodeModelCatalogMock.mockImplementation(async () => ({
      projectId: "other-project",
      models: [{ id: "other/model", name: "Other", provider: "Other" }],
    }));
    const { result } = renderHook(() => useBuildLaunchOptions("project-1", true));
    await flushPromises();

    const opencode = result.current.catalog.opencode ?? [];
    expect(opencode.map((model) => model.id)).not.toContain("other/model");
  });

  test("discards a stale catalog result after the project changes", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    getCachedOpenCodeModelCatalogMock.mockImplementation(() =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }));
    getOpencodeModelPreferencesMock.mockImplementation(async () => ({
      favorite: ["provider/model-b"],
      recent: [],
      variant: {},
    }));

    const { result, rerender } = renderHook(
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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { mockToastError } from "../../../../tests/mocks/sonner";
import { useConfigStore } from "@/stores/configStore";
import {
  favoriteModelKey,
  mergeReorderedFavoriteModels,
  reorderFavoriteModels,
  useAgentModelFavorites,
} from "./useAgentModelFavorites";

const invokeMock = invoke as ReturnType<typeof mock>;

const CLAUDE_OPUS: AgentModel = {
  platform: "claude",
  id: "claude-opus",
  label: "Claude Opus",
};
const CODEX_GPT: AgentModel = {
  platform: "codex",
  id: "gpt-codex",
  label: "GPT Codex",
};

type HookValue = ReturnType<typeof useAgentModelFavorites>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function renderHook(): { current: HookValue } {
  const ref = { current: null as unknown as HookValue };
  function Probe() {
    ref.current = useAgentModelFavorites();
    return null;
  }
  render(<Probe />);
  return ref;
}

function globalConfig() {
  return useConfigStore.getState().config.global;
}

describe("useAgentModelFavorites", () => {
  beforeEach(() => {
    cleanup();
    invokeMock.mockReset();
    mockToastError.mockClear();
    invokeMock.mockImplementation((_command: string, args: { global: unknown }) =>
      Promise.resolve({ ...useConfigStore.getState().config, global: args.global }),
    );
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          favoriteModels: [],
          enabledAgentPlatforms: ["claude", "codex", "opencode"],
        },
      },
    }));
  });

  afterEach(cleanup);

  test("exposes the persisted favorites and enabled platforms", () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          favoriteModels: [{ platform: "codex", modelId: "gpt-codex" }],
          enabledAgentPlatforms: ["codex", "grok"],
        },
      },
    }));

    const hook = renderHook();
    expect(hook.current.favorites).toEqual([{ platform: "codex", modelId: "gpt-codex" }]);
    expect(hook.current.enabledPlatforms).toEqual(["codex", "grok"]);
  });

  test("falls back to the legacy platform set when none is configured", () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          favoriteModels: undefined,
          enabledAgentPlatforms: undefined,
        },
      },
    }));

    const hook = renderHook();
    expect(hook.current.favorites).toEqual([]);
    expect(hook.current.enabledPlatforms).toEqual(["claude", "codex", "opencode"]);
  });

  test("adds a favorite optimistically and persists the whole global config", async () => {
    const hook = renderHook();

    await act(async () => {
      hook.current.toggleFavorite(CLAUDE_OPUS);
    });

    expect(globalConfig().favoriteModels).toEqual([{ platform: "claude", modelId: "claude-opus" }]);
    expect(invokeMock).toHaveBeenCalledWith("update_global_config", {
      global: expect.objectContaining({
        favoriteModels: [{ platform: "claude", modelId: "claude-opus" }],
      }),
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("removes only the matching platform/model pair when toggled off", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          favoriteModels: [
            { platform: "claude", modelId: "claude-opus" },
            { platform: "codex", modelId: "gpt-codex" },
            // Same model id on a different platform must survive.
            { platform: "opencode", modelId: "claude-opus" },
          ],
        },
      },
    }));
    const hook = renderHook();

    await act(async () => {
      hook.current.toggleFavorite(CLAUDE_OPUS);
    });

    expect(globalConfig().favoriteModels).toEqual([
      { platform: "codex", modelId: "gpt-codex" },
      { platform: "opencode", modelId: "claude-opus" },
    ]);
  });

  test("adopts the backend's normalized config rather than the optimistic list", async () => {
    // The backend drops blanks and duplicates on write, so the authoritative
    // response is what the picker must end up showing.
    invokeMock.mockImplementation(() =>
      Promise.resolve({
        ...useConfigStore.getState().config,
        global: {
          ...useConfigStore.getState().config.global,
          favoriteModels: [{ platform: "claude", modelId: "claude-opus-normalized" }],
        },
      }),
    );
    const hook = renderHook();

    await act(async () => {
      hook.current.toggleFavorite(CLAUDE_OPUS);
    });

    expect(globalConfig().favoriteModels).toEqual([
      { platform: "claude", modelId: "claude-opus-normalized" },
    ]);
  });

  test("rolls back to the previous list and reports a failed save", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          favoriteModels: [{ platform: "codex", modelId: "gpt-codex" }],
        },
      },
    }));
    invokeMock.mockRejectedValue(new Error("backend unavailable"));
    const hook = renderHook();

    await act(async () => {
      hook.current.toggleFavorite(CLAUDE_OPUS);
    });

    // A favourite the backend never stored must not linger in the picker, or
    // the next launch silently loses it with no explanation.
    expect(globalConfig().favoriteModels).toEqual([{ platform: "codex", modelId: "gpt-codex" }]);
    expect(mockToastError).toHaveBeenCalledWith("Could not save model favorites");
  });

  test("rolls back a failed removal too", async () => {
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          favoriteModels: [
            { platform: "claude", modelId: "claude-opus" },
            { platform: "codex", modelId: "gpt-codex" },
          ],
        },
      },
    }));
    invokeMock.mockRejectedValue(new Error("backend unavailable"));
    const hook = renderHook();

    await act(async () => {
      hook.current.toggleFavorite(CODEX_GPT);
    });

    expect(globalConfig().favoriteModels).toEqual([
      { platform: "claude", modelId: "claude-opus" },
      { platform: "codex", modelId: "gpt-codex" },
    ]);
    expect(mockToastError).toHaveBeenCalledWith("Could not save model favorites");
  });

  test("reorders favorites by key and persists the new order", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    const codex = { platform: "codex" as const, modelId: "gpt-codex" };
    const grok = { platform: "grok" as const, modelId: "grok-4" };
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          favoriteModels: [claude, codex, grok],
        },
      },
    }));
    const hook = renderHook();

    await act(async () => {
      hook.current.reorderFavorites([codex, claude, grok]);
    });

    expect(globalConfig().favoriteModels).toEqual([codex, claude, grok]);
    expect(invokeMock).toHaveBeenCalledWith("update_global_config", {
      global: expect.objectContaining({ favoriteModels: [codex, claude, grok] }),
    });
  });

  test("does not persist when the favourite order is unchanged", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, favoriteModels: [claude] },
      },
    }));
    const hook = renderHook();

    await act(async () => {
      hook.current.reorderFavorites([claude]);
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("rolls back a failed reorder", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    const codex = { platform: "codex" as const, modelId: "gpt-codex" };
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, favoriteModels: [claude, codex] },
      },
    }));
    invokeMock.mockRejectedValue(new Error("backend unavailable"));
    const hook = renderHook();

    await act(async () => {
      hook.current.reorderFavorites([codex, claude]);
    });

    expect(globalConfig().favoriteModels).toEqual([claude, codex]);
    expect(mockToastError).toHaveBeenCalledWith("Could not save model favorites");
  });

  test("serializes rapid reorders and ignores an older response", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    const codex = { platform: "codex" as const, modelId: "gpt-codex" };
    const firstWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    const secondWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, favoriteModels: [claude, codex] },
      },
    }));
    invokeMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const hook = renderHook();

    act(() => {
      hook.current.reorderFavorites([codex, claude]);
    });
    await Promise.resolve();
    act(() => {
      hook.current.reorderFavorites([claude, codex]);
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    firstWrite.resolve({
      ...useConfigStore.getState().config,
      global: { ...globalConfig(), favoriteModels: [codex, claude] },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    // The stale first response must not overwrite the second optimistic order.
    expect(globalConfig().favoriteModels).toEqual([claude, codex]);

    secondWrite.resolve({
      ...useConfigStore.getState().config,
      global: { ...globalConfig(), favoriteModels: [claude, codex] },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(globalConfig().favoriteModels).toEqual([claude, codex]);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("does not roll back a newer reorder when an older save fails", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    const codex = { platform: "codex" as const, modelId: "gpt-codex" };
    const firstWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    const secondWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, favoriteModels: [claude, codex] },
      },
    }));
    invokeMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const hook = renderHook();

    act(() => {
      hook.current.reorderFavorites([codex, claude]);
    });
    await Promise.resolve();
    act(() => {
      hook.current.reorderFavorites([claude, codex]);
    });

    firstWrite.reject(new Error("first save failed"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);

    secondWrite.resolve({
      ...useConfigStore.getState().config,
      global: { ...globalConfig(), favoriteModels: [claude, codex] },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(globalConfig().favoriteModels).toEqual([claude, codex]);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("rolls back to the last committed order when the latest save fails", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    const codex = { platform: "codex" as const, modelId: "gpt-codex" };
    const firstWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    const secondWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, favoriteModels: [claude, codex] },
      },
    }));
    invokeMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const hook = renderHook();

    act(() => {
      hook.current.reorderFavorites([codex, claude]);
    });
    await Promise.resolve();
    act(() => {
      hook.current.reorderFavorites([claude, codex]);
    });

    firstWrite.resolve({
      ...useConfigStore.getState().config,
      global: { ...globalConfig(), favoriteModels: [codex, claude] },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    secondWrite.reject(new Error("latest save failed"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(globalConfig().favoriteModels).toEqual([codex, claude]);
    expect(mockToastError).toHaveBeenCalledWith("Could not save model favorites");
  });

  test("rolls back to the pre-queue order when every queued save fails", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    const codex = { platform: "codex" as const, modelId: "gpt-codex" };
    const firstWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    const secondWrite = deferred<ReturnType<typeof useConfigStore.getState>["config"]>();
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, favoriteModels: [claude, codex] },
      },
    }));
    invokeMock
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const hook = renderHook();

    act(() => {
      hook.current.reorderFavorites([codex, claude]);
    });
    await Promise.resolve();
    act(() => {
      hook.current.reorderFavorites([claude, codex]);
    });

    firstWrite.reject(new Error("first save failed"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    secondWrite.reject(new Error("second save failed"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(globalConfig().favoriteModels).toEqual([claude, codex]);
    expect(mockToastError).toHaveBeenCalledWith("Could not save model favorites");
  });
});

describe("reorderFavoriteModels", () => {
  const claude = { platform: "claude" as const, modelId: "opus" };
  const codex = { platform: "codex" as const, modelId: "gpt" };
  const grok = { platform: "grok" as const, modelId: "grok" };

  test("moves a favourite before another and keeps the rest stable", () => {
    expect(
      reorderFavoriteModels(
        [claude, codex, grok],
        favoriteModelKey(grok),
        favoriteModelKey(claude),
      ),
    ).toEqual([grok, claude, codex]);
  });

  test("returns null when the drop target is the same item or unknown", () => {
    expect(
      reorderFavoriteModels([claude, codex], favoriteModelKey(claude), favoriteModelKey(claude)),
    ).toBeNull();
    expect(reorderFavoriteModels([claude, codex], favoriteModelKey(claude), "missing")).toBeNull();
  });

  test("merges a filtered reorder back into the original favorite slots", () => {
    const hidden = { platform: "opencode" as const, modelId: "hidden" };
    const visibleFirst = { platform: "claude" as const, modelId: "first" };
    const visibleSecond = { platform: "claude" as const, modelId: "second" };

    expect(
      mergeReorderedFavoriteModels(
        [visibleFirst, hidden, visibleSecond],
        [visibleFirst, visibleSecond],
        [visibleSecond, visibleFirst],
      ),
    ).toEqual([visibleSecond, hidden, visibleFirst]);
  });
});

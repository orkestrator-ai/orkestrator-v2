import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { invoke } from "@/lib/native/backend";
import type { AgentModel, AgentModelRef } from "@orkestrator/protocol/native-agent";
import { mockToastError } from "../../../../tests/mocks/sonner";
import type { BackendId } from "@orkestrator/protocol/federation";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { bindSettingsParent } from "@/lib/portal/command-node-config";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import type { GlobalConfig } from "@/types";
import { configStore, useConfigStore } from "@/stores/configStore";
import {
  favoriteModelKey,
  mergeReorderedFavoriteModels,
  reorderFavoriteModels,
  useAgentModelFavorites,
} from "./useAgentModelFavorites";
import { appCommandStore } from "@/test/app-command-store";

type FakeArgs = Readonly<Record<string, unknown>>;

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
    const value = useAgentModelFavorites();
    useLayoutEffect(() => {
      ref.current = value;
    });
    return null;
  }
  render(<Probe />);
  return ref;
}

function globalConfig() {
  return appCommandStore(configStore).getState().config.global;
}

describe("useAgentModelFavorites", () => {
  beforeEach(() => {
    cleanup();
    invokeMock.mockReset();
    mockToastError.mockClear();
    invokeMock.mockImplementation((_command: string, args: { patch: object }) =>
      Promise.resolve({
        ...appCommandStore(configStore).getState().config,
        global: { ...appCommandStore(configStore).getState().config.global, ...args.patch },
      }),
    );
    appCommandStore(configStore).setState((state) => ({
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
    appCommandStore(configStore).setState((state) => ({
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
    appCommandStore(configStore).setState((state) => ({
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

  test("adds a favorite optimistically and persists only the favourite list", async () => {
    const hook = renderHook();

    await act(async () => {
      hook.current.toggleFavorite(CLAUDE_OPUS);
    });

    expect(globalConfig().favoriteModels).toEqual([{ platform: "claude", modelId: "claude-opus" }]);
    expect(invokeMock).toHaveBeenCalledWith("patch_global_config", {
      patch: { favoriteModels: [{ platform: "claude", modelId: "claude-opus" }] },
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("removes only the matching platform/model pair when toggled off", async () => {
    appCommandStore(configStore).setState((state) => ({
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
        ...appCommandStore(configStore).getState().config,
        global: {
          ...appCommandStore(configStore).getState().config.global,
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
    appCommandStore(configStore).setState((state) => ({
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
    appCommandStore(configStore).setState((state) => ({
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
    appCommandStore(configStore).setState((state) => ({
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
    expect(invokeMock).toHaveBeenCalledWith("patch_global_config", {
      patch: { favoriteModels: [codex, claude, grok] },
    });
  });

  test("does not persist when the favourite order is unchanged", async () => {
    const claude = { platform: "claude" as const, modelId: "claude-opus" };
    appCommandStore(configStore).setState((state) => ({
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
    appCommandStore(configStore).setState((state) => ({
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
    appCommandStore(configStore).setState((state) => ({
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
      ...appCommandStore(configStore).getState().config,
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
      ...appCommandStore(configStore).getState().config,
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
    appCommandStore(configStore).setState((state) => ({
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
      ...appCommandStore(configStore).getState().config,
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
    appCommandStore(configStore).setState((state) => ({
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
      ...appCommandStore(configStore).getState().config,
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
    appCommandStore(configStore).setState((state) => ({
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

describe("useAgentModelFavorites under a leaf scope", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockToastError.mockClear();
  });
  afterEach(cleanupNodeScopes);

  function nodeClient(nodeId: string, options: { patch: boolean }): FakeNodeClient {
    let stored = structuredClone(appCommandStore(configStore).getInitialState().config);
    const save = (global: GlobalConfig) => {
      stored = { ...stored, global };
      return stored;
    };
    return new FakeNodeClient({
      nodeId: nodeId as BackendId,
      invoke: {
        get_config: () => stored,
        update_global_config: (args: FakeArgs) => save(args.global as GlobalConfig),
        patch_global_config: (args: FakeArgs) => {
          if (!options.patch) throw new Error(unknownBackendCommandMessage("patch_global_config"));
          return save({ ...stored.global, ...(args.patch as Partial<GlobalConfig>) });
        },
      },
    });
  }

  function renderInLeaf(command: FakeNodeClient, leaf: FakeNodeClient) {
    const windowScope = new WindowScope();
    const commandScope = windowScope.open({ role: "command", client: command });
    const leafScope = windowScope.open({ role: "leaf", client: leaf });
    bindSettingsParent(leafScope, commandScope);
    const ref = { current: null as unknown as HookValue };
    function Probe() {
      const value = useAgentModelFavorites();
      useLayoutEffect(() => {
        ref.current = value;
      });
      return null;
    }
    renderInNodeScope(<Probe />, { windowScope, client: leaf, role: "leaf" });
    return { ref, commandScope, leafScope };
  }

  test("a favourite is saved on the command scope's node and the leaf gets no write", async () => {
    const command = nodeClient("bk_fav-command", { patch: true });
    const leaf = nodeClient("bk_fav-leaf", { patch: true });
    const { ref, commandScope, leafScope } = renderInLeaf(command, leaf);

    await act(async () => {
      ref.current.toggleFavorite(CLAUDE_OPUS);
    });

    const favourite: AgentModelRef[] = [{ platform: "claude", modelId: "claude-opus" }];
    expect(command.calls("patch_global_config").map((call) => call.args)).toEqual([
      { patch: { favoriteModels: favourite } },
    ]);
    expect(leaf.calls("patch_global_config")).toHaveLength(0);
    expect(leaf.calls("update_global_config")).toHaveLength(0);
    expect(leafScope.store(configStore).getState().config.global.favoriteModels).toEqual(favourite);
    expect(ref.current.favorites).toEqual(favourite);
    expect(commandScope.store(configStore).getState().hasLoaded).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("a command node without the patch command gets the whole-object write it expects", async () => {
    const command = nodeClient("bk_fav-old-command", { patch: false });
    const leaf = nodeClient("bk_fav-old-leaf", { patch: false });
    const { ref } = renderInLeaf(command, leaf);

    await act(async () => {
      ref.current.toggleFavorite(CLAUDE_OPUS);
    });

    const [write] = command.calls("update_global_config");
    expect(write?.args.global).toMatchObject({
      favoriteModels: [{ platform: "claude", modelId: "claude-opus" }],
    });
    expect("preserveInheritedSettings" in (write?.args ?? {})).toBe(false);
    expect(leaf.calls("update_global_config")).toHaveLength(0);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

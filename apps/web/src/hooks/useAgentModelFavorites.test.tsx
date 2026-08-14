import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { mockToastError } from "../../../../tests/mocks/sonner";
import { useConfigStore } from "@/stores/configStore";
import { useAgentModelFavorites } from "./useAgentModelFavorites";

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
        global: { ...state.config.global, favoriteModels: undefined, enabledAgentPlatforms: undefined },
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

    expect(globalConfig().favoriteModels).toEqual([
      { platform: "claude", modelId: "claude-opus" },
    ]);
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
    expect(globalConfig().favoriteModels).toEqual([
      { platform: "codex", modelId: "gpt-codex" },
    ]);
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
});

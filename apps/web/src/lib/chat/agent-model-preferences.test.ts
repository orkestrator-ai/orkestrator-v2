import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { useConfigStore } from "@/stores/configStore";

const mockUpdateGlobalConfig = mock(async (global: unknown) => ({
  version: "1.0",
  global,
  repositories: {},
}));

/**
 * `@/lib/backend` is deliberately real in `tests/setup.ts`, so snapshot it
 * before stubbing and restore it afterwards — otherwise every later suite in
 * this worker inherits a backend with only one function on it.
 */
import * as realBackend from "@/lib/backend";
const realBackendSnapshot = { ...realBackend };
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  updateGlobalConfig: mockUpdateGlobalConfig,
}));
afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const { persistAgentModelDefault } = await import("./agent-model-preferences");

function seedConfig(global: Record<string, unknown>) {
  useConfigStore.getState().setConfig({
    version: "1.0",
    global,
    repositories: {},
  } as never);
}

beforeEach(() => {
  mockToastError.mockClear();
  mockUpdateGlobalConfig.mockReset();
  mockUpdateGlobalConfig.mockImplementation(async (global: unknown) => ({
    version: "1.0",
    global,
    repositories: {},
  }));
  seedConfig({ claudeModel: "opus", opencodeModel: "opencode/gpt-4" });
});

afterEach(() => {
  useConfigStore.getState().setConfig({
    version: "1.0",
    global: {},
    repositories: {},
  } as never);
});

describe("persistAgentModelDefault", () => {
  test("applies the choice optimistically and commits the server response", async () => {
    await persistAgentModelDefault("claudeModel", "sonnet", "Claude");

    expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ claudeModel: "sonnet" }),
    );
    expect(useConfigStore.getState().config.global.claudeModel).toBe("sonnet");
  });

  test("persists each agent under its own key", async () => {
    // Sharing a key across agents would make picking a model in one tab silently
    // change the default in another.
    await persistAgentModelDefault("opencodeModel", "gpt-5", "OpenCode");

    const { global } = useConfigStore.getState().config;
    expect(global.opencodeModel).toBe("gpt-5");
    expect(global.claudeModel).toBe("opus");
  });

  test("does nothing when the value is already the default", async () => {
    await persistAgentModelDefault("claudeModel", "opus", "Claude");
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test("skips persistence when the config has not loaded yet", async () => {
    // The user's click has already taken effect in the session store; a
    // not-yet-loaded config must not turn that into an error.
    useConfigStore.setState({ config: undefined as never });

    await persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("rolls back and reports when the write fails", async () => {
    mockUpdateGlobalConfig.mockImplementation(async () => {
      throw new Error("backend down");
    });

    await persistAgentModelDefault("claudeModel", "sonnet", "Claude");

    expect(useConfigStore.getState().config.global.claudeModel).toBe("opus");
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to save Claude model default",
    );
  });

  test("a failed write does not clobber a newer selection", async () => {
    /**
     * The rollback compares against the value it wrote. Without that guard a
     * slow failure would revert the model the user picked *after* it, silently
     * undoing their most recent choice.
     */
    let failSlowly!: () => void;
    mockUpdateGlobalConfig.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failSlowly = () => reject(new Error("backend down"));
        }),
    );

    const inFlight = persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    // A newer choice lands while the first write is still going.
    seedConfig({ claudeModel: "haiku" });
    failSlowly();
    await inFlight;

    expect(useConfigStore.getState().config.global.claudeModel).toBe("haiku");
  });

  test("a slow success does not clobber a newer selection", async () => {
    let resolveSlowly!: (value: { version: string; global: unknown; repositories: object }) => void;
    mockUpdateGlobalConfig.mockImplementationOnce(
      () =>
        new Promise<{ version: string; global: unknown; repositories: object }>(
          (resolve) => {
            resolveSlowly = resolve;
          },
        ),
    );

    const inFlight = persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    seedConfig({ claudeModel: "haiku" });
    resolveSlowly({
      version: "1.0",
      global: { claudeModel: "sonnet" },
      repositories: {},
    });
    await inFlight;

    expect(useConfigStore.getState().config.global.claudeModel).toBe("haiku");
  });
});

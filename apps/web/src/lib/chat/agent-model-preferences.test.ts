import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockToastError } from "../../../../../tests/mocks/sonner";
import { useConfigStore } from "@/stores/configStore";
import type { AppConfig } from "@/types";

const mockUpdateAgentModelDefault = mock(
  async (key: string, modelId: string): Promise<AppConfig> =>
    ({
      version: "1.0",
      global: { [key]: modelId },
      repositories: {},
    }) as unknown as AppConfig,
);

/**
 * `@/lib/backend` is deliberately real in `tests/setup.ts`, so snapshot it
 * before stubbing and restore it afterwards — otherwise every later suite in
 * this worker inherits a backend with only one function on it.
 */
import * as realBackend from "@/lib/backend";
const realBackendSnapshot = { ...realBackend };
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  updateAgentModelDefault: mockUpdateAgentModelDefault,
}));
afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const { persistAgentModelDefault } = await import("./agent-model-preferences");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function seedConfig(global: Record<string, unknown>) {
  useConfigStore.getState().setConfig({
    version: "1.0",
    global,
    repositories: {},
  } as never);
}

beforeEach(() => {
  mockToastError.mockClear();
  mockUpdateAgentModelDefault.mockReset();
  mockUpdateAgentModelDefault.mockImplementation(
    async (key: string, modelId: string): Promise<AppConfig> =>
      ({
        version: "1.0",
        global: { [key]: modelId },
        repositories: {},
      }) as unknown as AppConfig,
  );
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

    expect(mockUpdateAgentModelDefault).toHaveBeenCalledWith("claudeModel", "sonnet");
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
    expect(mockUpdateAgentModelDefault).not.toHaveBeenCalled();
  });

  test("skips persistence when the config has not loaded yet", async () => {
    // The user's click has already taken effect in the session store; a
    // not-yet-loaded config must not turn that into an error.
    useConfigStore.setState({ config: undefined as never });

    await persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    expect(mockUpdateAgentModelDefault).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("rolls back and reports when the write fails", async () => {
    mockUpdateAgentModelDefault.mockImplementation(async () => {
      throw new Error("backend down");
    });

    await persistAgentModelDefault("claudeModel", "sonnet", "Claude");

    expect(useConfigStore.getState().config.global.claudeModel).toBe("opus");
    expect(mockToastError).toHaveBeenCalledWith("Failed to save Claude model default");
  });

  test("a failed write rolls back only its model key", async () => {
    const write = deferred<never>();
    mockUpdateAgentModelDefault.mockImplementationOnce(() => write.promise);

    const inFlight = persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    useConfigStore.getState().updateGlobalConfig({
      allowedDomains: ["example.test"],
      opencodeModel: "opencode/gpt-5",
    } as never);
    write.reject(new Error("backend down"));
    await inFlight;

    expect(useConfigStore.getState().config.global).toMatchObject({
      claudeModel: "opus",
      opencodeModel: "opencode/gpt-5",
      allowedDomains: ["example.test"],
    });
  });

  test("a failed write does not clobber a newer selection", async () => {
    /**
     * The rollback compares against the value it wrote. Without that guard a
     * slow failure would revert the model the user picked *after* it, silently
     * undoing their most recent choice.
     */
    let failSlowly!: () => void;
    mockUpdateAgentModelDefault.mockImplementationOnce(
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
    let resolveSlowly!: (value: AppConfig) => void;
    mockUpdateAgentModelDefault.mockImplementationOnce(
      () =>
        new Promise<AppConfig>((resolve) => {
          resolveSlowly = resolve;
        }),
    );

    const inFlight = persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    seedConfig({ claudeModel: "haiku" });
    resolveSlowly({
      version: "1.0",
      global: { claudeModel: "sonnet" },
      repositories: {},
    } as AppConfig);
    await inFlight;

    expect(useConfigStore.getState().config.global.claudeModel).toBe("haiku");
  });

  test("a stale success response does not replace unrelated config changes", async () => {
    const write = deferred<AppConfig>();
    mockUpdateAgentModelDefault.mockImplementationOnce(() => write.promise);

    const inFlight = persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    useConfigStore.getState().updateGlobalConfig({
      allowedDomains: ["new.example"],
      webClientEnabled: false,
    } as never);
    useConfigStore.getState().setRepositoryConfig("repo-1", {
      defaultBranch: "develop",
      prBaseBranch: "main",
    });

    write.resolve({
      version: "1.0",
      global: {
        claudeModel: "sonnet",
        allowedDomains: ["stale.example"],
        webClientEnabled: true,
      },
      repositories: {},
    } as AppConfig);
    await inFlight;

    const config = useConfigStore.getState().config;
    expect(config.global).toMatchObject({
      claudeModel: "sonnet",
      allowedDomains: ["new.example"],
      webClientEnabled: false,
    });
    expect(config.repositories["repo-1"]).toEqual({
      defaultBranch: "develop",
      prBaseBranch: "main",
    });
  });

  test("concurrent cross-agent success and failure settle independently", async () => {
    const claudeWrite = deferred<AppConfig>();
    const opencodeWrite = deferred<never>();
    mockUpdateAgentModelDefault.mockImplementation((key: string) =>
      key === "claudeModel" ? claudeWrite.promise : opencodeWrite.promise,
    );

    const claudeInFlight = persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    const opencodeInFlight = persistAgentModelDefault(
      "opencodeModel",
      "opencode/gpt-5",
      "OpenCode",
    );
    useConfigStore.getState().updateGlobalConfig({ webClientEnabled: false });

    claudeWrite.resolve({
      version: "1.0",
      global: {
        claudeModel: "sonnet",
        opencodeModel: "stale/opencode",
        webClientEnabled: true,
      },
      repositories: {},
    } as AppConfig);
    await claudeInFlight;
    opencodeWrite.reject(new Error("OpenCode write failed"));
    await opencodeInFlight;

    expect(useConfigStore.getState().config.global).toMatchObject({
      claudeModel: "sonnet",
      opencodeModel: "opencode/gpt-4",
      webClientEnabled: false,
    });
    expect(mockToastError).toHaveBeenCalledWith("Failed to save OpenCode model default");
  });

  test("a cross-agent failure cannot roll back a later successful key", async () => {
    const claudeWrite = deferred<never>();
    const opencodeWrite = deferred<AppConfig>();
    mockUpdateAgentModelDefault.mockImplementation((key: string) =>
      key === "claudeModel" ? claudeWrite.promise : opencodeWrite.promise,
    );

    const claudeInFlight = persistAgentModelDefault("claudeModel", "sonnet", "Claude");
    const opencodeInFlight = persistAgentModelDefault(
      "opencodeModel",
      "opencode/gpt-5",
      "OpenCode",
    );

    opencodeWrite.resolve({
      version: "1.0",
      global: { claudeModel: "stale-claude", opencodeModel: "opencode/gpt-5" },
      repositories: {},
    } as AppConfig);
    await opencodeInFlight;
    claudeWrite.reject(new Error("Claude write failed"));
    await claudeInFlight;

    expect(useConfigStore.getState().config.global).toMatchObject({
      claudeModel: "opus",
      opencodeModel: "opencode/gpt-5",
    });
  });
});

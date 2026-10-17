import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { runtimeStorePaths } from "./config.js";
import { modelRuntime, refreshRuntimeCatalog, setModelRuntimeFactoryForTests } from "./runtime.js";

function fakeRuntime(overrides: Record<string, unknown> = {}): ModelRuntime {
  return {
    refresh: async () => undefined,
    ...overrides,
  } as unknown as ModelRuntime;
}

afterEach(() => {
  setModelRuntimeFactoryForTests();
});

describe("modelRuntime", () => {
  test("shares one in-flight construction and memoizes the result", async () => {
    let constructions = 0;
    let release: (runtime: ModelRuntime) => void = () => undefined;
    const pending = new Promise<ModelRuntime>((resolve) => {
      release = resolve;
    });
    setModelRuntimeFactoryForTests(async () => {
      constructions += 1;
      return pending;
    });

    const first = modelRuntime();
    const second = modelRuntime();
    expect(constructions).toBe(1);

    const created = fakeRuntime();
    release(created);
    expect(await first).toBe(created);
    expect(await second).toBe(created);
    expect(await modelRuntime()).toBe(created);
    expect(constructions).toBe(1);
  });

  test("retries construction after a transient failure", async () => {
    const created = fakeRuntime();
    let constructions = 0;
    setModelRuntimeFactoryForTests(async () => {
      constructions += 1;
      if (constructions === 1) throw new Error("temporary config read failure");
      return created;
    });

    await expect(modelRuntime()).rejects.toThrow("temporary config read failure");
    expect(await modelRuntime()).toBe(created);
    expect(constructions).toBe(2);
  });
});

describe("refreshRuntimeCatalog", () => {
  test("forces the shared runtime with a bounded signal and treats failures as best-effort", async () => {
    let refreshes = 0;
    const options: Array<{ force?: boolean; signal?: AbortSignal }> = [];
    const created = fakeRuntime({
      refresh: async (received: { force?: boolean; signal?: AbortSignal }) => {
        refreshes += 1;
        options.push(received);
        throw new Error("provider offline");
      },
    });
    setModelRuntimeFactoryForTests(async () => created);

    await expect(refreshRuntimeCatalog()).resolves.toBeUndefined();
    await expect(refreshRuntimeCatalog()).resolves.toBeUndefined();
    expect(refreshes).toBe(2);
    expect(options.map((entry) => entry.force)).toEqual([true, true]);
    expect(options.every((entry) => entry.signal instanceof AbortSignal)).toBe(true);
  });
});

describe("runtimeStorePaths", () => {
  const saved = {
    PI_AGENT_DIR: process.env.PI_AGENT_DIR,
    PI_BRIDGE_AUTH_FILE: process.env.PI_BRIDGE_AUTH_FILE,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("leaves both stores on the SDK default when nothing is configured", () => {
    delete process.env.PI_AGENT_DIR;
    delete process.env.PI_BRIDGE_AUTH_FILE;
    expect(runtimeStorePaths()).toEqual({});
  });

  test("keeps both stores in an explicit agent directory", () => {
    process.env.PI_AGENT_DIR = "/container/pi/agent";
    delete process.env.PI_BRIDGE_AUTH_FILE;
    expect(runtimeStorePaths()).toEqual({
      authPath: resolve("/container/pi/agent/auth.json"),
      modelsPath: resolve("/container/pi/agent/models.json"),
    });
  });

  test("moves only the credential file when an auth file is named", () => {
    // An agent-test profile: the host's login, the profile's own model config.
    delete process.env.PI_AGENT_DIR;
    process.env.PI_BRIDGE_AUTH_FILE = " /host/.pi/agent/auth.json ";
    expect(runtimeStorePaths()).toEqual({ authPath: resolve("/host/.pi/agent/auth.json") });

    process.env.PI_AGENT_DIR = "/profile/pi/agent";
    expect(runtimeStorePaths()).toEqual({
      authPath: resolve("/host/.pi/agent/auth.json"),
      modelsPath: resolve("/profile/pi/agent/models.json"),
    });
  });
});

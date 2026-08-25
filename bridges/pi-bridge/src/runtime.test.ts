import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  test("uses the shared runtime and treats provider refresh failure as best-effort", async () => {
    let refreshes = 0;
    const created = fakeRuntime({
      refresh: async () => {
        refreshes += 1;
        throw new Error("provider offline");
      },
    });
    setModelRuntimeFactoryForTests(async () => created);

    await expect(refreshRuntimeCatalog()).resolves.toBeUndefined();
    await expect(refreshRuntimeCatalog()).resolves.toBeUndefined();
    expect(refreshes).toBe(2);
  });
});

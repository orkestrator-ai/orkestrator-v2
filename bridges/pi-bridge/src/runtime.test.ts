import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  test("a real SDK runtime sharing only authPath keeps models under isolated HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runtime-auth-only-"));
    const home = join(root, "profile-home");
    const hostDir = join(root, "host-agent");
    const profileDir = join(home, ".pi", "agent");
    const models = (id: string) =>
      JSON.stringify({
        providers: {
          [id]: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "fixture",
            models: [
              { id: "fixture-model", name: "Fixture", contextWindow: 4096, maxTokens: 1024 },
            ],
          },
        },
      });
    await mkdir(profileDir, { recursive: true });
    await mkdir(hostDir);
    await writeFile(join(profileDir, "models.json"), models("profile-provider"));
    await writeFile(join(hostDir, "models.json"), models("host-provider"));
    await writeFile(join(hostDir, "auth.json"), "{}");
    const env = {
      ...process.env,
      HOME: home,
      PI_BRIDGE_AUTH_FILE: join(hostDir, "auth.json"),
      PI_OFFLINE: "1",
    };
    delete env.PI_CODING_AGENT_DIR;
    delete env.PI_AGENT_DIR;
    // Fresh process: HOME is isolated before the SDK can cache any paths.
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { ModelRuntime } from ${JSON.stringify(new URL("./pi-sdk.ts", import.meta.url).href)};
      import { runtimeStorePaths } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
      const runtime = await ModelRuntime.create({ ...runtimeStorePaths(), allowModelNetwork: false });
      console.log(JSON.stringify({
        profile: !!runtime.getModel("profile-provider", "fixture-model"),
        host: !!runtime.getModel("host-provider", "fixture-model"),
      }));
    `,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ profile: true, host: false });
    } finally {
      child.kill();
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
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

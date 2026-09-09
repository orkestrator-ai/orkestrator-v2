import { expect, test } from "bun:test";
import type { AgentOptions } from "@cursor/sdk";
import { createCursorSandboxBootstrap } from "./sandbox-bootstrap.js";

const hostOptions: AgentOptions = {
  apiKey: "test-key",
  local: {
    cwd: "/test-workspace",
    settingSources: ["user", "project"],
    sandboxOptions: { enabled: false },
    autoReview: true,
  },
  mcpServers: { example: { command: "must-not-start" } },
};

test("primes sandbox discovery before an unsandboxed preparation can cache an unsupported verdict", async () => {
  // SDK 1.0.31's checkBinaryAvailable/isSandboxHelperSupported memoize their
  // first result. Only sandbox-enabled executor creation registers the helper.
  let helperRegistered = false;
  let supported: boolean | undefined;
  const environmentMetadata = () => (supported ??= helperRegistered);
  const calls: AgentOptions[] = [];
  let released = 0;
  const platform = {
    async prewarmLocalWorkspace(options: AgentOptions) {
      calls.push(options);
      if (options.apiKey && options.local?.sandboxOptions?.enabled) {
        helperRegistered = true;
        if (!environmentMetadata()) throw new Error("Sandbox unsupported");
      }
      return async () => {
        released += 1;
      };
    },
  };
  const bootstrap = createCursorSandboxBootstrap();
  await bootstrap(platform, hostOptions, "none");
  expect(released).toBe(1);
  expect(calls).toEqual([
    {
      apiKey: "test-key",
      local: {
        cwd: "/test-workspace",
        settingSources: [],
        sandboxOptions: { enabled: true },
        autoReview: false,
      },
    },
  ]);

  const preparation = await platform.prewarmLocalWorkspace(hostOptions);
  expect(environmentMetadata()).toBe(true);
  await preparation();
  await bootstrap(platform, hostOptions, "none");
  const review = await platform.prewarmLocalWorkspace({
    ...hostOptions,
    local: { ...hostOptions.local, sandboxOptions: { enabled: true } },
  });
  await review();
  expect(calls).toHaveLength(3);
  expect(hostOptions.local?.sandboxOptions?.enabled).toBe(false);
});

test("concurrent host attaches share the barrier until the probe lease is released", async () => {
  let finish!: () => void;
  const releasing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  let released = 0;
  const platform = {
    async prewarmLocalWorkspace() {
      calls += 1;
      return async () => {
        released += 1;
        await releasing;
      };
    },
  };
  const bootstrap = createCursorSandboxBootstrap();
  const first = bootstrap(platform, hostOptions, "none");
  const second = bootstrap(platform, hostOptions, "none");
  expect(second).toBe(first);
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(released).toBe(1);
  expect(settled).toBe(false);
  finish();
  await Promise.all([first, second]);
  expect(settled).toBe(true);
});

test.each(["initialize", "release"])(
  "an unsupported sandbox or failed %s does not block ordinary sessions or change their policy",
  async (failure) => {
    let calls = 0;
    const platform = {
      async prewarmLocalWorkspace() {
        calls += 1;
        if (failure === "initialize") throw new Error("Sandbox unsupported");
        return async () => {
          throw new Error("Release failed");
        };
      },
    };
    const bootstrap = createCursorSandboxBootstrap();
    const readOnly: AgentOptions = {
      ...hostOptions,
      local: { ...hostOptions.local, sandboxOptions: { enabled: true } },
      tools: ["read"],
    };
    await bootstrap(platform, hostOptions, "none");
    await bootstrap(platform, readOnly, "provider");
    expect(calls).toBe(1);
    expect(readOnly.local?.sandboxOptions?.enabled).toBe(true);
    expect(readOnly.tools).toEqual(["read"]);
  },
);

test("an unauthenticated warm-up does not consume initialization", async () => {
  let calls = 0;
  const platform = {
    async prewarmLocalWorkspace() {
      calls += 1;
      return async () => {};
    },
  };
  const bootstrap = createCursorSandboxBootstrap();
  await bootstrap(platform, { local: hostOptions.local }, "none");
  expect(calls).toBe(0);
  await bootstrap(platform, hostOptions, "none");
  expect(calls).toBe(1);
});

test("container sessions skip the nested sandbox without consuming a later host initialization", async () => {
  let calls = 0;
  const platform = {
    async prewarmLocalWorkspace() {
      calls += 1;
      return async () => {};
    },
  };
  const bootstrap = createCursorSandboxBootstrap();
  await bootstrap(platform, hostOptions, "container");
  expect(calls).toBe(0);
  await bootstrap(platform, hostOptions, "none");
  expect(calls).toBe(1);
});

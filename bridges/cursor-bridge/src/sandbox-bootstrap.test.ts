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

const probeOptions = {
  apiKey: "test-key",
  local: {
    cwd: "/test-workspace",
    settingSources: [],
    sandboxOptions: { enabled: true },
    autoReview: false,
  },
};

/** The SDK's wording; the classifier keys on it, so the fake must use it too. */
const unsupported = () =>
  new Error(
    "Local SDK sandboxing was requested, but sandboxing is not supported in this environment.",
  );

/**
 * Models SDK 1.0.31: `checkBinaryAvailable`/`isSandboxHelperSupported` memoize
 * their first answer, only sandbox-enabled executor creation registers the
 * helper beforehand, and an unsandboxed executor still answers
 * environment-metadata queries — which is what cached `false`.
 */
function poisonablePlatform() {
  let helperRegistered = false;
  let verdict: boolean | undefined;
  const askSupported = () => (verdict ??= helperRegistered);
  const calls: AgentOptions[] = [];
  let released = 0;
  const platform = {
    async prewarmLocalWorkspace(options: AgentOptions) {
      calls.push(options);
      if (options.local?.sandboxOptions?.enabled) {
        helperRegistered = true;
        if (!askSupported()) throw unsupported();
      } else {
        askSupported();
      }
      return async () => {
        released += 1;
      };
    },
  };
  return { platform, calls, askSupported, releases: () => released };
}

/**
 * Guards the fake above. Without this the first test could pass against a
 * model that never reproduced the bug, and the ordering it asserts would carry
 * no weight.
 */
test("the fake reproduces the cached unsupported verdict when nothing primes discovery", async () => {
  const { platform, askSupported } = poisonablePlatform();

  const preparation = await platform.prewarmLocalWorkspace(hostOptions);
  await preparation();
  expect(askSupported()).toBe(false);

  await expect(
    platform.prewarmLocalWorkspace({
      ...hostOptions,
      local: { ...hostOptions.local, sandboxOptions: { enabled: true } },
    }),
  ).rejects.toThrow("sandboxing is not supported in this environment");
});

test("primes sandbox discovery before an unsandboxed preparation can cache an unsupported verdict", async () => {
  const { platform, calls, askSupported, releases } = poisonablePlatform();
  const bootstrap = createCursorSandboxBootstrap();

  await bootstrap(platform, hostOptions, "none");
  expect(releases()).toBe(1);
  expect(calls).toEqual([probeOptions]);
  expect(askSupported()).toBe(true);

  const preparation = await platform.prewarmLocalWorkspace(hostOptions);
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

test("an unsupported host is settled by one probe and keeps its sessions unchanged", async () => {
  let calls = 0;
  const reported: unknown[] = [];
  const platform = {
    async prewarmLocalWorkspace() {
      calls += 1;
      throw unsupported();
    },
  };
  const bootstrap = createCursorSandboxBootstrap((error) => reported.push(error));
  const readOnly: AgentOptions = {
    ...hostOptions,
    local: { ...hostOptions.local, sandboxOptions: { enabled: true } },
    tools: ["read"],
  };

  await bootstrap(platform, hostOptions, "none");
  await bootstrap(platform, readOnly, "provider");

  expect(calls).toBe(1);
  expect(reported).toHaveLength(1);
  expect(readOnly.local?.sandboxOptions?.enabled).toBe(true);
  expect(readOnly.tools).toEqual(["read"]);
});

test("a probe whose release fails is settled, because the helper is already registered", async () => {
  let calls = 0;
  const reported: unknown[] = [];
  const platform = {
    async prewarmLocalWorkspace() {
      calls += 1;
      return async () => {
        throw new Error("Release failed");
      };
    },
  };
  const bootstrap = createCursorSandboxBootstrap((error) => reported.push(error));

  await bootstrap(platform, hostOptions, "none");
  await bootstrap(platform, hostOptions, "none");

  expect(calls).toBe(1);
  expect(reported).toHaveLength(1);
  expect(hostOptions.local?.sandboxOptions?.enabled).toBe(false);
});

/**
 * A transient failure leaves the helper unregistered. Settling on it would
 * silently reinstate the dispatch failure for the rest of the process, so the
 * next attach has to try again.
 */
test("a transient probe failure is retried by the next host attach, then settles", async () => {
  let calls = 0;
  const reported: string[] = [];
  const platform = {
    async prewarmLocalWorkspace() {
      calls += 1;
      if (calls === 1) throw new Error("workspace scan unavailable");
      return async () => {};
    },
  };
  const bootstrap = createCursorSandboxBootstrap((error) =>
    reported.push(error instanceof Error ? error.message : String(error)),
  );

  await bootstrap(platform, hostOptions, "none");
  expect(calls).toBe(1);
  await bootstrap(platform, hostOptions, "none");
  expect(calls).toBe(2);
  await bootstrap(platform, hostOptions, "none");
  expect(calls).toBe(2);
  expect(reported).toEqual(["workspace scan unavailable"]);
});

test("a transient failure does not fail the attach that observed it", async () => {
  const platform = {
    async prewarmLocalWorkspace() {
      throw new Error("workspace scan unavailable");
    },
  };
  const bootstrap = createCursorSandboxBootstrap(() => {});
  await expect(bootstrap(platform, hostOptions, "none")).resolves.toBeUndefined();
});

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

test("a sandboxed host session skips the probe its own preparation would repeat", async () => {
  let calls = 0;
  const platform = {
    async prewarmLocalWorkspace() {
      calls += 1;
      return async () => {};
    },
  };
  const bootstrap = createCursorSandboxBootstrap();

  // The session's own preparation is sandbox-enabled, so it constructs the
  // sandbox-enabled executor that registers the helper. Probing first would
  // pay the workspace scan twice on the first attach, which is the dominant
  // cost on a large checkout. The barrier stays unset, so an unsandboxed run
  // later still primes before its own preparation can cache a verdict.
  await bootstrap(platform, hostOptions, "provider");
  expect(calls).toBe(0);
  await bootstrap(platform, hostOptions, "none");
  expect(calls).toBe(1);
});

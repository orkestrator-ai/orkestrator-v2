import { afterEach, expect, test } from "bun:test";
import type { AgentOptions, CursorAgentPlatform } from "@cursor/sdk";
import { prewarmCursorWorkspace, useCursorSdkRuntimeForTests } from "./sdk-runtime.js";

let restoreRuntime: (() => void) | undefined;

afterEach(() => {
  restoreRuntime?.();
  restoreRuntime = undefined;
});

test("concurrent sandbox-enabled warm-ups register the helper before support is cached", async () => {
  let helperRegistered = false;
  let cachedSupport: boolean | undefined;
  let entered = 0;
  let admitBoth!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    admitBoth = resolve;
  });
  const calls: AgentOptions[] = [];
  let releases = 0;
  const platform = {
    async prewarmLocalWorkspace(options: AgentOptions) {
      calls.push(options);
      if (options.local?.sandboxOptions?.enabled) helperRegistered = true;
      else cachedSupport ??= helperRegistered;

      entered += 1;
      if (entered === 2) admitBoth();
      await bothEntered;

      cachedSupport ??= helperRegistered;
      if (options.local?.sandboxOptions?.enabled && !cachedSupport) {
        throw new Error("sandboxing is not supported in this environment");
      }
      return async () => {
        releases += 1;
      };
    },
  };
  restoreRuntime = useCursorSdkRuntimeForTests({
    configureStore: () => {},
    createPlatform: async () => platform as unknown as CursorAgentPlatform,
  });
  const options: AgentOptions = {
    apiKey: "test-key",
    model: { id: "test-model" },
    local: {
      cwd: "/test-workspace",
      sandboxOptions: { enabled: true },
    },
  };

  const [firstRelease, secondRelease] = await Promise.all([
    prewarmCursorWorkspace(options, "provider"),
    prewarmCursorWorkspace(options, "provider"),
  ]);

  expect(cachedSupport).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.local?.sandboxOptions?.enabled === true)).toBe(true);
  expect(firstRelease).toBeFunction();
  expect(secondRelease).toBeFunction();
  await Promise.all([firstRelease?.(), secondRelease?.()]);
  expect(releases).toBe(2);
});

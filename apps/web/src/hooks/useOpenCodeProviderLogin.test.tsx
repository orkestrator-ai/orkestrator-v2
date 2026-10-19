import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as native from "@/lib/native/backend";
import type { OpenCodeProviderLoginProgress } from "@orkestrator/protocol/opencode-provider-auth";
import { useOpenCodeProviderLogin } from "./useOpenCodeProviderLogin";

const pending: OpenCodeProviderLoginProgress = {
  state: "pending",
  providerId: "openai",
  providerLabel: "OpenAI",
  operationId: "one",
};
let login: OpenCodeProviderLoginProgress;
let read: () => Promise<OpenCodeProviderLoginProgress>;
let cancelError: Error | undefined;
let timers: Map<number, () => void>;
let calls: Array<{ command: string; args?: Record<string, unknown> }>;
let restore: Array<() => void>;

async function flush() {
  await act(async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
  });
}
async function tick() {
  await act(async () => {
    for (const [id, callback] of Array.from(timers)) {
      timers.delete(id);
      callback();
    }
    for (let n = 0; n < 20; n++) await Promise.resolve();
  });
}

beforeEach(() => {
  login = { state: "idle" };
  cancelError = undefined;
  read = async () => login;
  calls = [];
  timers = new Map();
  let id = 100_000;
  const realTimeout = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay: number,
    ...args: unknown[]
  ) => {
    if (delay !== 1500) return realTimeout(callback, delay, ...args);
    timers.set(++id, callback);
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (!timers.delete(Number(handle))) realClear(handle as number);
  });
  const invoke = spyOn(native, "invoke").mockImplementation((async (
    command: string,
    args?: Record<string, unknown>,
  ) => {
    calls.push({ command, args });
    if (command === "get_opencode_provider_login") return read();
    if (command === "start_opencode_provider_login") return (login = pending);
    if (command === "submit_opencode_provider_login_code")
      return (login = { ...login, codeSubmitted: true });
    if (command === "cancel_opencode_provider_login") {
      if (cancelError) throw cancelError;
      return (login = { state: "idle" });
    }
    throw new Error(`Unexpected command ${command}`);
  }) as typeof native.invoke);
  restore = [() => invoke.mockRestore(), () => timeout.mockRestore(), () => clear.mockRestore()];
});
afterEach(() => {
  cleanup();
  for (const undo of restore) undo();
});

describe("useOpenCodeProviderLogin", () => {
  test("adopts a pending operation after remount and cancels its id", async () => {
    const first = renderHook(() => useOpenCodeProviderLogin("openai"));
    await flush();
    await act(async () => first.result.current.start({ method: 1 }));
    first.unmount();
    expect(calls.some((call) => call.command === "cancel_opencode_provider_login")).toBe(false);
    const second = renderHook(() => useOpenCodeProviderLogin("openai"));
    await flush();
    expect(second.result.current.progress).toEqual(pending);
    await act(async () => second.result.current.cancel());
    expect(calls).toContainEqual({
      command: "cancel_opencode_provider_login",
      args: { operationId: "one" },
    });
    expect(second.result.current.progress.state).toBe("idle");
  });

  test("exposes another provider's pending operation with a cancellation path", async () => {
    login = pending;
    const view = renderHook(() => useOpenCodeProviderLogin("anthropic"));
    await flush();
    expect(view.result.current.progress.state).toBe("idle");
    expect(view.result.current.otherPending).toEqual(pending);
    await act(async () => view.result.current.start({ method: 0 }));
    expect(calls.some((call) => call.command === "start_opencode_provider_login")).toBe(false);
    await act(async () => view.result.current.cancel());
    expect(view.result.current.otherPending).toBeUndefined();
  });

  test("a section observer discovers a new operation and refreshes on success", async () => {
    const succeeded = { count: 0 };
    const view = renderHook(() =>
      useOpenCodeProviderLogin(undefined, () => {
        succeeded.count += 1;
      }),
    );
    await flush();
    login = pending;
    await tick();
    expect(view.result.current.progress).toEqual(pending);
    login = { ...pending, state: "succeeded" };
    await tick();
    await tick();
    expect(succeeded.count).toBe(1);
  });

  test("adopts needsCode and codeSubmitted immediately and fences a stale poll", async () => {
    login = pending;
    const view = renderHook(() => useOpenCodeProviderLogin("openai"));
    await flush();
    login = { ...pending, needsCode: true, url: "https://auth.example.test" };
    await tick();
    expect(view.result.current.progress.needsCode).toBe(true);
    let resolve!: (value: OpenCodeProviderLoginProgress) => void;
    read = () =>
      new Promise((done) => {
        resolve = done;
      });
    await tick();
    const stale = login;
    await act(async () => view.result.current.submitCode("pasted"));
    expect(view.result.current.progress.codeSubmitted).toBe(true);
    resolve(stale);
    await flush();
    expect(view.result.current.progress.codeSubmitted).toBe(true);
    read = async () => login;
    login = { ...login, state: "succeeded" };
    await tick();
    expect(view.result.current.progress.state).toBe("succeeded");
  });

  test("keeps cancellation available after a read or cancellation failure", async () => {
    login = pending;
    const view = renderHook(() => useOpenCodeProviderLogin("openai"));
    await flush();
    read = async () => {
      throw new Error("temporary read failure");
    };
    await tick();
    expect(view.result.current.progress.state).toBe("pending");
    cancelError = new Error("Cancellation unavailable");
    await act(async () => view.result.current.cancel());
    expect(view.result.current.progress.state).toBe("pending");
    expect(view.result.current.error).toBe("Cancellation unavailable");
    cancelError = undefined;
    await act(async () => view.result.current.cancel());
    expect(view.result.current.progress.state).toBe("idle");
  });

  test("refreshes once when a whole sign-in finishes between section polls", async () => {
    let refreshes = 0;
    renderHook(() =>
      useOpenCodeProviderLogin(undefined, () => {
        refreshes += 1;
      }),
    );
    await flush();
    login = { ...pending, state: "succeeded" };
    await tick();
    await tick();
    expect(refreshes).toBe(1);
  });
});

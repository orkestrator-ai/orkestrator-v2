import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as native from "@/lib/native/backend";
import { useAgentAccountReauth } from "./useAgentAccountReauth";
import type { AgentAccountLoginProgress } from "@orkestrator/protocol/agent-accounts";

const pending: AgentAccountLoginProgress = {
  state: "pending",
  platform: "claude",
  mode: "reauthenticate",
  accountId: "default",
  operationId: "one",
};
let login: AgentAccountLoginProgress;
let read: () => Promise<AgentAccountLoginProgress>;
let calls: Array<{ command: string; args?: Record<string, unknown> }>;
let timers: Map<number, () => void>;
let restore: Array<() => void>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
    if (command === "get_agent_account_login") return read();
    if (command === "list_agent_accounts")
      return { active: { claude: "default", codex: "default" }, accounts: [] };
    if (command === "start_agent_account_login") {
      login = { ...pending, operationId: "two" };
      return login;
    }
    if (command === "cancel_agent_account_login") {
      if (args?.operationId === login.operationId) login = { state: "idle" };
      return login;
    }
    throw new Error(`Unexpected command ${command}`);
  }) as typeof native.invoke);
  restore = [() => invoke.mockRestore(), () => timeout.mockRestore(), () => clear.mockRestore()];
});
afterEach(() => {
  cleanup();
  for (const undo of restore) undo();
});

describe("useAgentAccountReauth", () => {
  test.each(["succeeded", "failed"] as const)(
    "resumes pending and rehydrates %s after unmount",
    async (state) => {
      login = pending;
      const first = renderHook(() => useAgentAccountReauth("claude"));
      await flush();
      expect(first.result.current.progress).toEqual(pending);
      first.unmount();
      expect(calls.some((c) => c.command === "cancel_agent_account_login")).toBe(false);
      login = { ...pending, state, ...(state === "failed" ? { error: "Rejected login" } : {}) };
      const second = renderHook(() => useAgentAccountReauth("claude"));
      await flush();
      expect(second.result.current.progress).toEqual(login);
      expect(second.result.current.error).toBe(state === "failed" ? "Rejected login" : null);
      expect(timers.size).toBe(0);
    },
  );

  test.each(["succeeded", "failed"] as const)(
    "polls to %s and retains result without cancellation",
    async (state) => {
      login = pending;
      const view = renderHook(() => useAgentAccountReauth("claude"));
      await flush();
      login = { ...pending, state, ...(state === "failed" ? { error: "Rejected" } : {}) };
      await tick();
      expect(view.result.current.progress.state).toBe(state);
      expect(timers.size).toBe(0);
      expect(calls.some((c) => c.command === "cancel_agent_account_login")).toBe(false);
      login = { state: "idle" };
      await tick();
      expect(view.result.current.progress.state).toBe(state);
    },
  );

  test("serializes reads while a poll is unresolved", async () => {
    login = pending;
    const view = renderHook(() => useAgentAccountReauth("claude"));
    await flush();
    const response = deferred<AgentAccountLoginProgress>();
    read = () => response.promise;
    await tick();
    await tick();
    expect(calls.filter((c) => c.command === "get_agent_account_login")).toHaveLength(2);
    expect(timers.size).toBe(0);
    response.resolve({ ...pending, state: "succeeded" });
    await flush();
    expect(view.result.current.progress.state).toBe("succeeded");
    expect(timers.size).toBe(0);
  });

  test("late success cannot cancel another card's newer login", async () => {
    login = pending;
    const view = renderHook(() => useAgentAccountReauth("claude"));
    await flush();
    const response = deferred<AgentAccountLoginProgress>();
    read = () => response.promise;
    await tick();
    login = { ...pending, operationId: "two" };
    response.resolve({ ...pending, state: "succeeded" });
    await flush();
    expect(view.result.current.progress.state).toBe("succeeded");
    expect(login).toMatchObject({ state: "pending", operationId: "two" });
    expect(calls.some((c) => c.command === "cancel_agent_account_login")).toBe(false);
  });

  test("cancel identifies its operation and fences an in-flight result", async () => {
    login = pending;
    const view = renderHook(() => useAgentAccountReauth("claude"));
    await flush();
    const response = deferred<AgentAccountLoginProgress>();
    read = () => response.promise;
    await tick();
    await act(async () => {
      await view.result.current.cancel();
    });
    expect(calls.find((c) => c.command === "cancel_agent_account_login")?.args).toEqual({
      operationId: "one",
    });
    response.resolve({ ...pending, state: "succeeded" });
    await flush();
    expect(view.result.current.progress.state).toBe("idle");
  });

  test("a start fences an older mount response", async () => {
    const response = deferred<AgentAccountLoginProgress>();
    read = () => response.promise;
    const view = renderHook(() => useAgentAccountReauth("claude"));
    await act(async () => {
      await view.result.current.start();
    });
    response.resolve({ state: "idle" });
    await flush();
    expect(view.result.current.progress.operationId).toBe("two");
    expect(timers.size).toBe(1);
  });

  test("does not show add-mode or another account's completed reauthentication", async () => {
    login = { ...pending, mode: "add" };
    const first = renderHook(() => useAgentAccountReauth("claude"));
    await flush();
    expect(first.result.current.progress.state).toBe("idle");
    first.unmount();
    login = { ...pending, accountId: "previous-account", state: "succeeded" };
    const second = renderHook(() => useAgentAccountReauth("claude"));
    await flush();
    expect(second.result.current.progress.state).toBe("idle");
  });

  test("does not show a completed operation from before the current authentication failure", async () => {
    login = { ...pending, state: "succeeded", completedAt: "2026-10-01T10:00:00Z" };
    const view = renderHook(() => useAgentAccountReauth("claude", true, "2026-10-01T11:00:00Z"));
    await flush();
    expect(view.result.current.progress.state).toBe("idle");
    view.rerender();
    expect(view.result.current.progress.state).toBe("idle");
  });

  test("disabled recovery never reads or starts global sign-in", async () => {
    login = pending;
    const view = renderHook(() => useAgentAccountReauth("claude", false));
    await flush();
    await act(async () => {
      await view.result.current.start();
    });
    expect(calls).toEqual([]);
    expect(view.result.current.progress.state).toBe("idle");
  });
});

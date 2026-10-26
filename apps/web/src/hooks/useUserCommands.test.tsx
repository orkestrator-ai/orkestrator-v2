import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as events from "@/lib/native/events";
import * as native from "@/lib/native/backend";
import * as sync from "@/lib/resource-sync";
import { useHumanPrompts, useUserCommands } from "./useUserCommands";
import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";

let commands: UserCommandRecord[];
let prompts: HumanPromptEntry[];
let readCommands: () => Promise<{ commands: UserCommandRecord[] }>;
let readPrompts: () => Promise<{ prompts: HumanPromptEntry[] }>;
let calls: string[];
let restore: Array<() => void>;
let connected: () => unknown;
let resync: (request: sync.ResourceResyncRequest) => unknown;
const changes = new Map<string, (change: { id: string }) => unknown>();
async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  calls = [];
  changes.clear();
  commands = [{ id: "old", status: "exited" } as UserCommandRecord];
  prompts = [{ id: "old", environmentId: "env", tabId: "tab" } as HumanPromptEntry];
  readCommands = async () => ({ commands });
  readPrompts = async () => ({ prompts });
  const invoke = spyOn(native, "invoke").mockImplementation((async (command: string) => {
    calls.push(command);
    if (command === "list_user_commands") return readCommands();
    if (command === "list_human_prompts") return readPrompts();
    throw new Error(command);
  }) as typeof native.invoke);
  const eventSpy = spyOn(events, "listen").mockImplementation(async (_event, callback) => {
    connected = () => callback({ payload: undefined } as never);
    return () => {};
  });
  const resyncSpy = spyOn(sync, "onResourceResync").mockImplementation((handler) => {
    resync = handler;
    return () => {};
  });
  const changeSpy = spyOn(sync, "onResourceChanged").mockImplementation((resource, handler) => {
    changes.set(resource, handler as (change: { id: string }) => unknown);
    return () => {
      changes.delete(resource);
    };
  });
  restore = [
    () => invoke.mockRestore(),
    () => resyncSpy.mockRestore(),
    () => changeSpy.mockRestore(),
    () => eventSpy.mockRestore(),
  ];
});
afterEach(() => {
  cleanup();
  for (const undo of restore) undo();
  sync.resetResourceSync();
});

for (const kind of ["commands", "prompts"] as const) {
  test(`${kind} converges after manifest recovery and safety checks while already settled`, async () => {
    const view = renderHook(() =>
      kind === "commands" ? useUserCommands("env", "tab").commands : useHumanPrompts(["env"]),
    );
    await flush();
    expect(view.result.current).toHaveLength(1);
    commands = [];
    prompts = [];
    act(() => {
      resync({ resources: new Set(["environment"]), reason: "manifest" });
    });
    await flush();
    expect(view.result.current).toEqual([]);
    commands = [{ id: "new", status: "exited" } as UserCommandRecord];
    prompts = [{ id: "new" } as HumanPromptEntry];
    act(() => sync.requestViewSafetyChecks("interval"));
    await flush();
    expect(view.result.current[0]?.id).toBe("new");
    commands = [];
    prompts = [];
    act(() => {
      connected();
    });
    await flush();
    expect(view.result.current).toEqual([]);
    view.unmount();
    const count = calls.length;
    act(() => sync.requestViewSafetyChecks("resource-gap"));
    await flush();
    expect(calls).toHaveLength(count);
  });

  test(`${kind} filters hints and rejects out-of-order authoritative reads`, async () => {
    const view = renderHook(() =>
      kind === "commands" ? useUserCommands("env", "tab").commands : useHumanPrompts(["env"]),
    );
    await flush();
    const resource = kind === "commands" ? "user-command" : "human-prompt";
    const id = kind === "commands" ? "env-env:tab" : "env";
    const count = calls.length;
    act(() => {
      changes.get(resource)!({ id: "unrelated" });
    });
    await flush();
    expect(calls).toHaveLength(count);
    let resolveOld!: (value: never) => void;
    const old = new Promise<never>((resolve) => {
      resolveOld = resolve;
    });
    if (kind === "commands") readCommands = () => old;
    else readPrompts = () => old;
    act(() => {
      changes.get(resource)!({ id });
    });
    if (kind === "commands") readCommands = async () => ({ commands: [] });
    else readPrompts = async () => ({ prompts: [] });
    act(() => {
      changes.get(resource)!({ id });
    });
    await flush();
    expect(view.result.current).toEqual([]);
    act(() => resolveOld({ commands, prompts } as never));
    await flush();
    expect(view.result.current).toEqual([]);
  });
}

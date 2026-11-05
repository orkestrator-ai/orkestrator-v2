import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import * as nodeEvents from "@/lib/federation/node-events";
import { portalStore } from "@/lib/portal/portal-store";
import { requestViewSafetyChecks } from "@/lib/resource-sync";
import {
  MAX_REMOTE_PROMPTS_PER_NODE,
  useRemoteHumanPrompts,
  type RemoteWorkerRef,
} from "./useRemoteHumanPrompts";

const WORKERS: RemoteWorkerRef[] = [{ nodeId: "bk_leaf", environmentId: "leaf-env" }];
const SIGN_IN = "https://github.com/login/device";

function prompt(extra: Partial<HumanPromptEntry> = {}): HumanPromptEntry {
  return {
    id: "tool-1",
    environmentId: "leaf-env",
    tabId: "tab-1",
    source: "agent-tool",
    since: "2026-11-05T10:00:00.000Z",
    prompt: {
      kind: "device-code",
      url: SIGN_IN,
      code: "1A2B-3C4D",
      wantsEnter: false,
      text: "Enter the code",
      key: "device",
    },
    ...extra,
  };
}

function setNode(available = true, loadedAt = 1) {
  portalStore.store.setState({
    nodes: [{ nodeId: "bk_leaf", available, loadedAt, environments: [] }] as never,
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

let answer: () => Promise<unknown>;
let invoke: ReturnType<typeof spyOn>;
let subscribe: ReturnType<typeof spyOn>;
let onEvent: (event: string, payload: unknown) => void;
const initial = portalStore.store.getState();

beforeEach(() => {
  answer = async () => ({ prompts: [prompt()] });
  invoke = spyOn(portalStore, "invokeOnNode").mockImplementation((async () => answer()) as never);
  subscribe = spyOn(nodeEvents, "subscribeNodeEvents").mockImplementation((_nodeId, subscriber) => {
    onEvent = subscriber.onEvent as typeof onEvent;
    return mock(() => undefined);
  });
  setNode();
});

afterEach(() => {
  cleanup();
  invoke.mockRestore();
  subscribe.mockRestore();
  portalStore.store.setState(initial, true);
});

test("reads each worker's node with one bounded list call, and names the node on each entry", async () => {
  const { result } = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  expect(invoke).toHaveBeenCalledWith("bk_leaf", "list_human_prompts", {
    environmentIds: ["leaf-env"],
  });
  expect(result.current).toEqual([{ ...prompt(), nodeId: "bk_leaf" }]);
});

test("nothing to read reads nothing", async () => {
  const { result } = renderHook(() => useRemoteHumanPrompts([]));
  await flush();
  expect(invoke).not.toHaveBeenCalled();
  expect(result.current).toEqual([]);
});

test("re-reads on the node's human-prompt hint for one of its workers, and on no other", async () => {
  const { result } = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  invoke.mockClear();
  onEvent("resource-changed", { resource: "human-prompt", id: "other-env" });
  onEvent("resource-changed", { resource: "environment", id: "leaf-env" });
  expect(invoke).not.toHaveBeenCalled();
  answer = async () => ({ prompts: [] });
  onEvent("resource-changed", { resource: "human-prompt", id: "leaf-env" });
  await flush();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual([]);
});

test("re-reads when the node's summaries refresh and on the safety check", async () => {
  renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  invoke.mockClear();
  act(() => setNode(true, 2));
  await flush();
  expect(invoke).toHaveBeenCalledTimes(1);
  act(() => requestViewSafetyChecks("interval"));
  await flush();
  expect(invoke).toHaveBeenCalledTimes(2);
});

test("a node's answer is checked: other environments, bad links and overflow do not get through", async () => {
  answer = async () => ({
    prompts: [
      prompt({ environmentId: "not-asked-for" }),
      { nonsense: true },
      prompt({ prompt: { ...prompt().prompt, url: "https://attacker.example/login" } }),
      ...Array.from({ length: MAX_REMOTE_PROMPTS_PER_NODE + 5 }, (_, index) =>
        prompt({ id: `many-${index}` }),
      ),
    ],
  });
  const { result } = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  expect(result.current).toHaveLength(MAX_REMOTE_PROMPTS_PER_NODE);
  expect(result.current.every((entry) => entry.environmentId === "leaf-env")).toBe(true);
  expect(result.current[0]?.prompt.url).toBeUndefined();
});

test("an older node without the command shows nothing, and a failed read keeps the last reading", async () => {
  answer = async () => {
    throw new Error("Unknown backend command: list_human_prompts");
  };
  const first = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  expect(first.result.current).toEqual([]);
  first.unmount();

  answer = async () => ({ prompts: [prompt()] });
  const { result } = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  expect(result.current).toHaveLength(1);
  answer = async () => {
    throw new Error("link dropped");
  };
  act(() => requestViewSafetyChecks("interval"));
  await flush();
  expect(result.current).toHaveLength(1);
});

test("a node reported unavailable drops its prompts: nobody can confirm they still wait", async () => {
  const { result } = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  expect(result.current).toHaveLength(1);
  act(() => setNode(false, 2));
  await flush();
  expect(result.current).toEqual([]);
});

test("reconnect requires a fresh answer and cannot resurrect cached credentials", async () => {
  const { result } = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  expect(result.current).toHaveLength(1);
  act(() => setNode(false, 2));
  await flush();
  answer = async () => {
    throw new Error("offline");
  };
  act(() => setNode(true, 3));
  await flush();
  expect(result.current).toEqual([]);
  answer = async () => ({ prompts: [prompt()] });
  act(() => requestViewSafetyChecks("interval"));
  await flush();
  expect(result.current).toHaveLength(1);
});

test("a read begun before disconnect cannot repopulate the invalidated cache", async () => {
  let resolve!: (value: unknown) => void;
  answer = () =>
    new Promise((done) => {
      resolve = done;
    });
  const { result } = renderHook(() => useRemoteHumanPrompts(WORKERS));
  await flush();
  act(() => setNode(false, 2));
  await flush();
  resolve({ prompts: [prompt()] });
  await flush();
  answer = async () => {
    throw new Error("offline");
  };
  act(() => setNode(true, 3));
  await flush();
  expect(result.current).toEqual([]);
});

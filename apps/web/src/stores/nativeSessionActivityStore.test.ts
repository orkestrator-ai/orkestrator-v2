import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import { listNativeAgentSessionActivityCommand } from "@orkestrator/protocol/contract/domains/native-sessions";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { dispatchResourceChange, requestViewSafetyChecks } from "@/lib/resource-sync";
import { setTransportDisconnected } from "@/lib/transport-connectivity";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  NATIVE_SESSION_ACTIVITY_BUSY_POLL_MS,
  NATIVE_SESSION_ACTIVITY_COALESCE_MS,
  nativeSessionActivityStore,
} from "./nativeSessionActivityStore";
import { appCommandStore } from "@/test/app-command-store";

const COMMAND = listNativeAgentSessionActivityCommand.name;
const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;

/** The observation transport attaches once per file, so its callback is kept for every test. */
const nativeCallbacks = new Map<string, (event: { payload: unknown }) => void>();
const emitNative = (event: string, payload: unknown) => nativeCallbacks.get(event)?.({ payload });

const store = () => appCommandStore(nativeSessionActivityStore);

/**
 * Lets more than the coalescing window pass on Bun's fake clock, in 10 ms
 * steps with a real immediate between steps so each read settles.
 */
const settled = async (windowMs = NATIVE_SESSION_ACTIVITY_COALESCE_MS + 150) => {
  for (let elapsed = 0; elapsed < windowMs; elapsed += 10) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    jest.advanceTimersByTime(10);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
};

let answers: Map<string, Record<string, string>>;
let reads: string[];
let failWith: Error | null;

beforeAll(() => {
  listenMock.mockImplementation(async (event: string, callback) => {
    nativeCallbacks.set(event, callback);
    return () => nativeCallbacks.delete(event);
  });
});

afterAll(() => {
  listenMock.mockImplementation(async () => () => undefined);
});

beforeEach(() => {
  jest.useFakeTimers();
  store().getState().reset();
  answers = new Map();
  reads = [];
  failWith = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: { environmentId?: string }) => {
    if (command !== COMMAND) return undefined;
    const environmentId = args?.environmentId ?? "";
    reads.push(environmentId);
    if (failWith) throw failWith;
    return { sessions: { ...answers.get(environmentId) } };
  });
});

afterEach(() => {
  store().getState().reset();
  setTransportDisconnected("gateway-event-stream", false);
  invokeMock.mockReset();
  jest.useRealTimers();
});

describe("native session activity store", () => {
  test("reads an environment once when its first consumer mounts", async () => {
    answers.set("env-1", { "env-env-1:tab-a": "working" });
    const release = store().getState().retain("env-1");
    const second = store().getState().retain("env-1");
    await settled();
    expect(reads).toEqual(["env-1"]);
    expect(store().getState().environments.get("env-1")?.get("env-env-1:tab-a")).toBe("working");
    second();
    release();
    expect(store().getState().environments.has("env-1")).toBe(false);
  });

  test("re-reads only the environment an activity announcement names", async () => {
    const releaseOne = store().getState().retain("env-1");
    const releaseTwo = store().getState().retain("env-2");
    await settled();
    reads = [];

    answers.set("env-1", { "env-env-1:tab-a": "working" });
    emitNative(NATIVE_AGENT_ACTIVITY_EVENT, {
      environment_id: "env-1",
      previous_state: "idle",
      state: "working",
    });
    await settled();
    expect(reads).toEqual(["env-1"]);
    expect(store().getState().environments.get("env-1")?.get("env-env-1:tab-a")).toBe("working");

    answers.set("env-1", {});
    dispatchResourceChange({ resource: "native-agent-session", id: "env-1", revision: 1 });
    await settled();
    expect(store().getState().environments.has("env-1")).toBe(false);
    releaseOne();
    releaseTwo();
  });

  test("ignores hints for an environment no consumer holds", async () => {
    const release = store().getState().retain("env-1");
    await settled();
    reads = [];
    dispatchResourceChange({ resource: "native-agent-session", id: "env-9", revision: 1 });
    await settled();
    expect(reads).toEqual([]);
    release();
  });

  test("coalesces a burst of hints into one read", async () => {
    const release = store().getState().retain("env-1");
    await settled();
    reads = [];
    for (let index = 0; index < 5; index += 1) {
      dispatchResourceChange({ resource: "native-agent-session", id: "env-1", revision: index });
    }
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toEqual(["env-1"]);
    release();
  });

  test("keeps the last answer when a read fails", async () => {
    answers.set("env-1", { "env-env-1:tab-a": "waiting" });
    const release = store().getState().retain("env-1");
    await settled();
    failWith = new Error("offline");
    requestViewSafetyChecks("interval");
    await settled();
    expect(store().getState().environments.get("env-1")?.get("env-env-1:tab-a")).toBe("waiting");
    release();
  });

  test("polls while a session works, and stops once none does", async () => {
    answers.set("env-1", { "env-env-1:tab-a": "working" });
    const release = store().getState().retain("env-1");
    await settled();
    reads = [];
    // A turn that ends behind background work announces no transition.
    answers.set("env-1", {});
    await settled(NATIVE_SESSION_ACTIVITY_BUSY_POLL_MS + NATIVE_SESSION_ACTIVITY_COALESCE_MS + 50);
    expect(reads).toEqual(["env-1"]);
    expect(store().getState().environments.has("env-1")).toBe(false);

    reads = [];
    await settled(NATIVE_SESSION_ACTIVITY_BUSY_POLL_MS * 2);
    expect(reads).toEqual([]);
    release();
  });

  test("stops listening once the last consumer unmounts", async () => {
    const release = store().getState().retain("env-1");
    await settled();
    release();
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toEqual(["env-1"]);
  });

  test("discards a pending answer after the last consumer releases it", async () => {
    const pending = Promise.withResolvers<unknown>();
    invokeMock.mockImplementationOnce(() => pending.promise);
    const release = store().getState().retain("env-1");
    release();
    pending.resolve({ sessions: { "env-env-1:tab-a": "working" } });
    await settled();
    expect(store().getState().environments.has("env-1")).toBe(false);
    await settled(NATIVE_SESSION_ACTIVITY_BUSY_POLL_MS + NATIVE_SESSION_ACTIVITY_COALESCE_MS);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("takes a fresh snapshot when retained again during a pending read", async () => {
    const pending = Promise.withResolvers<unknown>();
    invokeMock.mockImplementationOnce(() => pending.promise);
    store().getState().retain("env-1")();
    const release = store().getState().retain("env-1");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    pending.resolve({ sessions: { "env-env-1:old": "working" } });
    await settled(10);
    expect(store().getState().environments.has("env-1")).toBe(false);
    answers.set("env-1", { "env-env-1:new": "working" });
    await settled();
    expect(reads).toEqual(["env-1"]);
    expect(store().getState().environments.get("env-1")).toEqual(
      new Map([["env-env-1:new", "working"]]),
    );
    release();
  });

  test.each(["resolve", "reject"] as const)(
    "does not publish or restart reads after disposal when a pending read settles (%s)",
    async (settle) => {
      const windowScope = new WindowScope();
      const client = new FakeNodeClient({
        invoke: { [COMMAND]: { sessions: { "env-env-1:tab-a": "working" } } },
      });
      const scope = windowScope.open({ role: "leaf", client });
      const activity = scope.store(nativeSessionActivityStore);
      try {
        const release = activity.getState().retain("env-1");
        await settled();
        expect(activity.getState().environments.has("env-1")).toBe(true);
        const pending = Promise.withResolvers<unknown>();
        client.respond(COMMAND, () => pending.promise);
        const read = activity.getState().refresh("env-1");
        // Queue another read behind the pending request.
        void activity.getState().refresh("env-1");
        expect(client.calls(COMMAND)).toHaveLength(2);

        scope.dispose();
        const disposedState = activity.getState();
        if (settle === "resolve") pending.resolve({ sessions: { "env-env-1:tab-b": "working" } });
        else pending.reject(new Error("disconnected"));
        await read;
        await settled(NATIVE_SESSION_ACTIVITY_BUSY_POLL_MS + NATIVE_SESSION_ACTIVITY_COALESCE_MS);
        expect(activity.getState()).toBe(disposedState);
        expect(activity.getState().environments.size).toBe(0);
        expect(client.calls(COMMAND)).toHaveLength(2);
        release();
      } finally {
        windowScope.dispose();
      }
    },
  );

  test("recovers a failed first read on reconnect without a resource change", async () => {
    failWith = new Error("offline");
    setTransportDisconnected("gateway-event-stream", true);
    const release = store().getState().retain("env-1");
    await settled();
    expect(reads).toEqual(["env-1"]);
    expect(store().getState().environments.has("env-1")).toBe(false);

    failWith = null;
    answers.set("env-1", { "env-env-1:tab-a": "working" });
    setTransportDisconnected("gateway-event-stream", false);
    await settled();
    expect(reads).toEqual(["env-1", "env-1"]);
    expect(store().getState().environments.get("env-1")?.get("env-env-1:tab-a")).toBe("working");
    release();
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import { COORDINATOR_ACTIVITY_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { dispatchResourceChange, requestViewSafetyChecks } from "@/lib/resource-sync";
import {
  COORDINATOR_ACTIVITY_COALESCE_MS,
  useCoordinatorActivityStore as store,
} from "./coordinatorActivityStore";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;

/** The observation transport attaches once per file, so its callback is kept for every test. */
const nativeCallbacks = new Map<string, (event: { payload: unknown }) => void>();
const emitNative = (event: string, payload: unknown) => nativeCallbacks.get(event)?.({ payload });

/** Longer than the resource-change coalescing window plus this store's own. */
const settled = () =>
  new Promise((resolve) => setTimeout(resolve, COORDINATOR_ACTIVITY_COALESCE_MS + 150));

let answer: Record<string, string>;
let reads: number;
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
  store.getState().reset();
  answer = {};
  reads = 0;
  failWith = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command !== COORDINATOR_ACTIVITY_COMMAND) return undefined;
    reads += 1;
    if (failWith) throw failWith;
    return { projects: { ...answer } };
  });
});

afterEach(() => {
  store.getState().reset();
  invokeMock.mockReset();
});

describe("coordinator activity store", () => {
  test("reads once when the first consumer mounts", async () => {
    answer = { "project-1": "working" };
    const release = store.getState().retain();
    const second = store.getState().retain();
    await settled();
    expect(reads).toBe(1);
    expect(store.getState().projects.get("project-1")).toBe("working");
    second();
    release();
  });

  test("re-reads when a coordinator session record changes, not for an environment's", async () => {
    const release = store.getState().retain();
    await settled();
    expect(store.getState().projects.size).toBe(0);

    answer = { "project-1": "working" };
    dispatchResourceChange({ resource: "native-agent-session", id: "env-1", revision: 1 });
    await settled();
    expect(reads).toBe(1);

    dispatchResourceChange({
      resource: "native-agent-session",
      id: "coordinator:c1:conversation-1",
      revision: 2,
    });
    await settled();
    expect(reads).toBe(2);
    expect(store.getState().projects.get("project-1")).toBe("working");
    release();
  });

  test("re-reads on a coordinator activity transition and clears when it ends", async () => {
    answer = { "project-1": "working" };
    const release = store.getState().retain();
    await settled();
    expect(store.getState().projects.get("project-1")).toBe("working");

    answer = {};
    emitNative(NATIVE_AGENT_ACTIVITY_EVENT, {
      environment_id: "coordinator:c1:conversation-1",
      previous_state: "working",
      state: "idle",
    });
    await settled();
    expect(store.getState().projects.has("project-1")).toBe(false);
    release();
  });

  test("coalesces a burst of hints into one read", async () => {
    const release = store.getState().retain();
    await settled();
    const before = reads;
    for (let index = 0; index < 5; index += 1) {
      dispatchResourceChange({
        resource: "coordinator",
        id: `project-${index}`,
        revision: index + 1,
      });
    }
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads - before).toBe(1);
    release();
  });

  test("keeps the last answer when a read fails", async () => {
    answer = { "project-1": "waiting" };
    const release = store.getState().retain();
    await settled();
    failWith = new Error("offline");
    requestViewSafetyChecks("interval");
    await settled();
    expect(store.getState().projects.get("project-1")).toBe("waiting");
    release();
  });

  test("stops asking a backend that predates the command", async () => {
    failWith = new Error(`Unknown backend command: ${COORDINATOR_ACTIVITY_COMMAND}`);
    const release = store.getState().retain();
    await settled();
    expect(reads).toBe(1);
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toBe(1);
    expect(store.getState().projects.size).toBe(0);
    release();
  });

  test("stops listening once the last consumer unmounts", async () => {
    const release = store.getState().retain();
    await settled();
    release();
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toBe(1);
  });
});

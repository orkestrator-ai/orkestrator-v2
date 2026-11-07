import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { NATIVE_AGENT_ACTIVITY_EVENT } from "@orkestrator/protocol/native-agent-observation";
import { COORDINATOR_ACTIVITY_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { dispatchResourceChange, requestViewSafetyChecks } from "@/lib/resource-sync";
import {
  COORDINATOR_ACTIVITY_COALESCE_MS,
  coordinatorActivityStore,
} from "./coordinatorActivityStore";
import { appCommandStore } from "@/test/app-command-store";

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
  appCommandStore(coordinatorActivityStore).getState().reset();
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
  appCommandStore(coordinatorActivityStore).getState().reset();
  invokeMock.mockReset();
});

describe("coordinator activity store", () => {
  test("reads once when the first consumer mounts", async () => {
    answer = { "project-1": "working" };
    const release = appCommandStore(coordinatorActivityStore).getState().retain();
    const second = appCommandStore(coordinatorActivityStore).getState().retain();
    await settled();
    expect(reads).toBe(1);
    expect(appCommandStore(coordinatorActivityStore).getState().projects.get("project-1")).toBe(
      "working",
    );
    second();
    release();
  });

  test("re-reads when a coordinator session record changes, not for an environment's", async () => {
    const release = appCommandStore(coordinatorActivityStore).getState().retain();
    await settled();
    expect(appCommandStore(coordinatorActivityStore).getState().projects.size).toBe(0);

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
    expect(appCommandStore(coordinatorActivityStore).getState().projects.get("project-1")).toBe(
      "working",
    );
    release();
  });

  test("re-reads on a coordinator activity transition and clears when it ends", async () => {
    answer = { "project-1": "working" };
    const release = appCommandStore(coordinatorActivityStore).getState().retain();
    await settled();
    expect(appCommandStore(coordinatorActivityStore).getState().projects.get("project-1")).toBe(
      "working",
    );

    answer = {};
    emitNative(NATIVE_AGENT_ACTIVITY_EVENT, {
      environment_id: "coordinator:c1:conversation-1",
      previous_state: "working",
      state: "idle",
    });
    await settled();
    expect(appCommandStore(coordinatorActivityStore).getState().projects.has("project-1")).toBe(
      false,
    );
    release();
  });

  test("coalesces a burst of hints into one read", async () => {
    const release = appCommandStore(coordinatorActivityStore).getState().retain();
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

  for (const outcome of ["resolve", "reject"] as const) {
    test(`serializes one follow-up after invalidations while the first read ${outcome}s`, async () => {
      const first = Promise.withResolvers<{ projects: Record<string, string> }>();
      const followUp = Promise.withResolvers<{ projects: Record<string, string> }>();
      invokeMock.mockImplementation((command: string) => {
        if (command !== COORDINATOR_ACTIVITY_COMMAND) return Promise.resolve(undefined);
        reads += 1;
        return reads === 1 ? first.promise : followUp.promise;
      });
      const release = appCommandStore(coordinatorActivityStore).getState().retain();
      try {
        // Let subscriptions attach, but keep the initial snapshot pending.
        await settled();
        for (let index = 0; index < 3; index += 1) {
          emitNative(NATIVE_AGENT_ACTIVITY_EVENT, {
            environment_id: "coordinator:c1:conversation-1",
            previous_state: "idle",
            state: "working",
          });
          requestViewSafetyChecks("interval");
          // Allow the coalescing timer to fire against the pending read each time.
          await settled();
          expect(reads).toBe(1);
        }

        if (outcome === "resolve") first.resolve({ projects: { "project-1": "waiting" } });
        else first.reject(new Error("offline"));
        await settled();
        expect(reads).toBe(2);
        expect(appCommandStore(coordinatorActivityStore).getState().projects.get("project-1")).toBe(
          outcome === "resolve" ? "waiting" : undefined,
        );

        followUp.resolve({ projects: { "project-1": "working" } });
        await settled();
        expect(appCommandStore(coordinatorActivityStore).getState().projects.get("project-1")).toBe(
          "working",
        );
        // No extra reads should have been queued by the invalidation burst.
        await settled();
        expect(reads).toBe(2);
      } finally {
        release();
        first.resolve({ projects: {} });
        followUp.resolve({ projects: {} });
        await appCommandStore(coordinatorActivityStore).getState().refresh();
      }
    });
  }

  test("keeps the last answer when a read fails", async () => {
    answer = { "project-1": "waiting" };
    const release = appCommandStore(coordinatorActivityStore).getState().retain();
    await settled();
    failWith = new Error("offline");
    requestViewSafetyChecks("interval");
    await settled();
    expect(appCommandStore(coordinatorActivityStore).getState().projects.get("project-1")).toBe(
      "waiting",
    );
    release();
  });

  test("stops asking a backend that predates the command", async () => {
    failWith = new Error(`Unknown backend command: ${COORDINATOR_ACTIVITY_COMMAND}`);
    const release = appCommandStore(coordinatorActivityStore).getState().retain();
    await settled();
    expect(reads).toBe(1);
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toBe(1);
    expect(appCommandStore(coordinatorActivityStore).getState().projects.size).toBe(0);
    release();
  });

  test("stops listening once the last consumer unmounts", async () => {
    const release = appCommandStore(coordinatorActivityStore).getState().retain();
    await settled();
    release();
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toBe(1);
  });
});

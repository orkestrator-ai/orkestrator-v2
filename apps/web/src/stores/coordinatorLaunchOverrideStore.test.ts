import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { COORDINATOR_LAUNCH_OVERRIDES_COMMAND } from "@orkestrator/protocol/coordinator-launch-overrides";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  dispatchResourceChange,
  requestResourceResync,
  requestViewSafetyChecks,
} from "@/lib/resource-sync";
import {
  COORDINATOR_LAUNCH_OVERRIDES_COALESCE_MS,
  useCoordinatorLaunchOverrideStore as store,
} from "./coordinatorLaunchOverrideStore";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

/** Longer than the resource-change coalescing window plus this store's own. */
const settled = () =>
  new Promise((resolve) => setTimeout(resolve, COORDINATOR_LAUNCH_OVERRIDES_COALESCE_MS + 150));
const key = (environmentId: string, tabId: string) => `${environmentId}\u0000${tabId}`;

let answer: Array<Record<string, string>>;
let reads: number;
let failWith: Error | null;

beforeEach(() => {
  store.getState().reset();
  answer = [];
  reads = 0;
  failWith = null;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command !== COORDINATOR_LAUNCH_OVERRIDES_COMMAND) return undefined;
    reads += 1;
    if (failWith) throw failWith;
    return { overrides: [...answer] };
  });
});

afterEach(() => {
  store.getState().reset();
  invokeMock.mockReset();
});

describe("coordinator launch override store", () => {
  test("every consumer shares the one read the first one starts", async () => {
    answer = [{ environmentId: "worker", tabId: "tab", model: "opus" }];
    const releases = Array.from({ length: 25 }, () => store.getState().retain());
    await settled();
    expect(reads).toBe(1);
    expect(store.getState().overrides.get(key("worker", "tab"))?.model).toBe("opus");
    for (const release of releases) release();
  });

  test("a burst of coordinator writes shares one re-read, which finds a new launch", async () => {
    const release = store.getState().retain();
    await settled();
    expect(store.getState().overrides.size).toBe(0);

    answer = [{ environmentId: "worker", tabId: "tab" }];
    for (let revision = 1; revision <= 5; revision += 1) {
      dispatchResourceChange({ resource: "coordinator", id: "project", revision });
    }
    await settled();
    expect(reads).toBe(2);
    expect(store.getState().overrides.has(key("worker", "tab"))).toBe(true);
    release();
  });

  test("a safety check recovers a missed hint", async () => {
    const release = store.getState().retain();
    await settled();
    answer = [{ environmentId: "worker", tabId: "tab" }];
    requestViewSafetyChecks("interval");
    await settled();
    expect(store.getState().overrides.size).toBe(1);
    release();
  });

  test("an unchanged answer does not replace the map tabs subscribe to", async () => {
    answer = [{ environmentId: "worker", tabId: "tab", model: "opus" }];
    const release = store.getState().retain();
    await settled();
    const held = store.getState().overrides;
    await store.getState().refresh();
    expect(reads).toBe(2);
    expect(store.getState().overrides).toBe(held);
    release();
  });

  test("a changed selection on a known tab does replace it", async () => {
    answer = [{ environmentId: "worker", tabId: "tab", model: "opus" }];
    const release = store.getState().retain();
    await settled();
    answer = [{ environmentId: "worker", tabId: "tab", model: "sonnet" }];
    await store.getState().refresh();
    expect(store.getState().overrides.get(key("worker", "tab"))?.model).toBe("sonnet");
    release();
  });

  test("a failed read keeps the last answer", async () => {
    answer = [{ environmentId: "worker", tabId: "tab" }];
    const release = store.getState().retain();
    await settled();
    failWith = new Error("transport closed");
    await store.getState().refresh();
    expect(store.getState().overrides.size).toBe(1);
    release();
  });

  test("an older backend shows nothing and is not asked again until a resync", async () => {
    failWith = new Error(`Unknown backend command: ${COORDINATOR_LAUNCH_OVERRIDES_COMMAND}`);
    const release = store.getState().retain();
    await settled();
    expect(reads).toBe(1);

    dispatchResourceChange({ resource: "coordinator", id: "project", revision: 1 });
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toBe(1);
    expect(store.getState().overrides.size).toBe(0);

    // The backend was upgraded behind this window.
    failWith = null;
    answer = [{ environmentId: "worker", tabId: "tab" }];
    requestResourceResync();
    await settled();
    expect(reads).toBe(2);
    expect(store.getState().overrides.size).toBe(1);
    release();
  });

  test("nothing reads once the last consumer has gone", async () => {
    const release = store.getState().retain();
    await settled();
    release();
    dispatchResourceChange({ resource: "coordinator", id: "project", revision: 1 });
    await settled();
    expect(reads).toBe(1);
  });
});

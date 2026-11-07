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
  coordinatorLaunchOverrideStore,
} from "./coordinatorLaunchOverrideStore";
import { appCommandStore } from "@/test/app-command-store";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

/** Longer than the resource-change coalescing window plus this store's own. */
const settled = () =>
  new Promise((resolve) => setTimeout(resolve, COORDINATOR_LAUNCH_OVERRIDES_COALESCE_MS + 150));
const key = (environmentId: string, tabId: string) => `${environmentId}\u0000${tabId}`;

let answer: Array<Record<string, string>>;
let reads: number;
let failWith: Error | null;

beforeEach(() => {
  appCommandStore(coordinatorLaunchOverrideStore).getState().reset();
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
  appCommandStore(coordinatorLaunchOverrideStore).getState().reset();
  invokeMock.mockReset();
});

describe("coordinator launch override store", () => {
  test("every consumer shares the one read the first one starts", async () => {
    answer = [{ environmentId: "worker", tabId: "tab", model: "opus" }];
    const releases = Array.from({ length: 25 }, () =>
      appCommandStore(coordinatorLaunchOverrideStore).getState().retain(),
    );
    await settled();
    expect(reads).toBe(1);
    expect(
      appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.get(key("worker", "tab"))
        ?.model,
    ).toBe("opus");
    for (const release of releases) release();
  });

  test("a burst of coordinator writes shares one re-read, which finds a new launch", async () => {
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    expect(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.size).toBe(0);

    answer = [{ environmentId: "worker", tabId: "tab" }];
    for (let revision = 1; revision <= 5; revision += 1) {
      dispatchResourceChange({ resource: "coordinator", id: "project", revision });
    }
    await settled();
    expect(reads).toBe(2);
    expect(
      appCommandStore(coordinatorLaunchOverrideStore)
        .getState()
        .overrides.has(key("worker", "tab")),
    ).toBe(true);
    release();
  });

  test("a safety check recovers a missed hint", async () => {
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    answer = [{ environmentId: "worker", tabId: "tab" }];
    requestViewSafetyChecks("interval");
    await settled();
    expect(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.size).toBe(1);
    release();
  });

  test("an unchanged answer does not replace the map tabs subscribe to", async () => {
    answer = [{ environmentId: "worker", tabId: "tab", model: "opus" }];
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    const held = appCommandStore(coordinatorLaunchOverrideStore).getState().overrides;
    await appCommandStore(coordinatorLaunchOverrideStore).getState().refresh();
    expect(reads).toBe(2);
    expect(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides).toBe(held);
    release();
  });

  test("a changed selection on a known tab does replace it", async () => {
    answer = [{ environmentId: "worker", tabId: "tab", model: "opus" }];
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    answer = [{ environmentId: "worker", tabId: "tab", model: "sonnet" }];
    await appCommandStore(coordinatorLaunchOverrideStore).getState().refresh();
    expect(
      appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.get(key("worker", "tab"))
        ?.model,
    ).toBe("sonnet");
    release();
  });

  test("a same-size snapshot replaces a selection-free override on another tab", async () => {
    answer = [{ environmentId: "worker-a", tabId: "old-tab" }];
    await appCommandStore(coordinatorLaunchOverrideStore).getState().refresh();
    answer = [{ environmentId: "worker-b", tabId: "new-tab", model: "opus" }];
    await appCommandStore(coordinatorLaunchOverrideStore).getState().refresh();
    expect(
      Array.from(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.keys()),
    ).toEqual([key("worker-b", "new-tab")]);
    expect(
      appCommandStore(coordinatorLaunchOverrideStore)
        .getState()
        .overrides.get(key("worker-b", "new-tab"))?.model,
    ).toBe("opus");
  });

  test("a hint during an unresolved read queues a second read with the newest snapshot", async () => {
    const first = Promise.withResolvers<{ overrides: Array<Record<string, string>> }>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== COORDINATOR_LAUNCH_OVERRIDES_COMMAND) return undefined;
      reads += 1;
      if (reads === 1) return first.promise;
      return { overrides: [{ environmentId: "new-worker", tabId: "new-tab", model: "opus" }] };
    });
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    dispatchResourceChange({ resource: "coordinator", id: "project", revision: 1 });
    await settled();
    expect(reads).toBe(1);
    first.resolve({ overrides: [{ environmentId: "old-worker", tabId: "old-tab" }] });
    await settled();
    expect(reads).toBe(2);
    expect(
      Array.from(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.keys()),
    ).toEqual([key("new-worker", "new-tab")]);
    release();
  });

  test("releasing the last consumer during a read cancels its queued rerun", async () => {
    const first = Promise.withResolvers<{ overrides: [] }>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== COORDINATOR_LAUNCH_OVERRIDES_COMMAND) return undefined;
      reads += 1;
      return first.promise;
    });
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    dispatchResourceChange({ resource: "coordinator", id: "project", revision: 1 });
    await settled();
    release();
    first.resolve({ overrides: [] });
    await settled();
    expect(reads).toBe(1);
  });

  test("releasing the last consumer cancels a hint still waiting to read", async () => {
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    dispatchResourceChange({ resource: "coordinator", id: "project", revision: 1 });
    release();
    await settled();
    expect(reads).toBe(1);
  });

  test("a failed read keeps the last answer", async () => {
    answer = [{ environmentId: "worker", tabId: "tab" }];
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    failWith = new Error("transport closed");
    await appCommandStore(coordinatorLaunchOverrideStore).getState().refresh();
    expect(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.size).toBe(1);
    release();
  });

  test("an older backend shows nothing and is not asked again until a resync", async () => {
    failWith = new Error(`Unknown backend command: ${COORDINATOR_LAUNCH_OVERRIDES_COMMAND}`);
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    expect(reads).toBe(1);

    dispatchResourceChange({ resource: "coordinator", id: "project", revision: 1 });
    requestViewSafetyChecks("interval");
    await settled();
    expect(reads).toBe(1);
    expect(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.size).toBe(0);

    // The backend was upgraded behind this window.
    failWith = null;
    answer = [{ environmentId: "worker", tabId: "tab" }];
    requestResourceResync();
    await settled();
    expect(reads).toBe(2);
    expect(appCommandStore(coordinatorLaunchOverrideStore).getState().overrides.size).toBe(1);
    release();
  });

  test("nothing reads once the last consumer has gone", async () => {
    const release = appCommandStore(coordinatorLaunchOverrideStore).getState().retain();
    await settled();
    release();
    dispatchResourceChange({ resource: "coordinator", id: "project", revision: 1 });
    await settled();
    expect(reads).toBe(1);
  });
});

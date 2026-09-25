import { describe, expect, mock, test } from "bun:test";
import {
  CONTAINER_LOG_SNAPSHOT_FRESHNESS_MS,
  createSharedContainerLogReader,
} from "./container-log-snapshots.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("shared container log snapshots", () => {
  test("clients polling the same tail share one docker read per freshness window", async () => {
    let clock = 0;
    let reads = 0;
    const read = mock(async (containerId: string, tail: string) => {
      reads += 1;
      return `${containerId}:${tail}:${reads}`;
    });
    const logs = createSharedContainerLogReader({ read, now: () => clock });

    // Three clients at one-second cadence for ten seconds, slightly offset.
    const answers: string[] = [];
    for (let second = 0; second < 10; second += 1) {
      for (const offset of [0, 120, 340]) {
        clock = second * 1_000 + offset;
        answers.push(await logs("c1", "500"));
      }
    }
    expect(read).toHaveBeenCalledTimes(10);
    expect(new Set(answers).size).toBe(10);
  });

  test("equivalent concurrent reads join; other containers and tails never share", async () => {
    const gate = deferred<string>();
    const read = mock((containerId: string, tail: string) =>
      containerId === "c1" && tail === "500"
        ? gate.promise
        : Promise.resolve(`${containerId}:${tail}`),
    );
    const logs = createSharedContainerLogReader({ read, now: () => 0 });
    const first = logs("c1", "500");
    const second = logs("c1", "500");
    expect(first).toBe(second);
    expect(await logs("c2", "500")).toBe("c2:500");
    expect(await logs("c1", "200")).toBe("c1:200");
    gate.resolve("tail");
    expect(await first).toBe("tail");
    expect(read).toHaveBeenCalledTimes(3);
  });

  test("a failure is shared by joined reads but never cached", async () => {
    let clock = 0;
    const gate = deferred<string>();
    let calls = 0;
    const read = mock(() => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve("recovered");
    });
    const logs = createSharedContainerLogReader({ read, now: () => clock });
    const first = logs("c1", "500");
    const joined = logs("c1", "500");
    gate.reject(new Error("daemon busy"));
    await expect(first).rejects.toThrow("daemon busy");
    await expect(joined).rejects.toThrow("daemon busy");
    clock += 1;
    expect(await logs("c1", "500")).toBe("recovered");
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("a completed snapshot expires after the freshness window and entries are bounded", async () => {
    let clock = 0;
    const read = mock(async (containerId: string) => `${containerId}@${clock}`);
    const logs = createSharedContainerLogReader({ read, now: () => clock, maxEntries: 2 });
    expect(await logs("c1", "500")).toBe("c1@0");
    clock = CONTAINER_LOG_SNAPSHOT_FRESHNESS_MS - 1;
    expect(await logs("c1", "500")).toBe("c1@0");
    clock = CONTAINER_LOG_SNAPSHOT_FRESHNESS_MS;
    expect(await logs("c1", "500")).toBe(`c1@${CONTAINER_LOG_SNAPSHOT_FRESHNESS_MS}`);
    await logs("c2", "500");
    await logs("c3", "500");
    // c1 was evicted: a new read even inside the window.
    expect(await logs("c1", "500")).toBe(`c1@${CONTAINER_LOG_SNAPSHOT_FRESHNESS_MS}`);
    expect(read).toHaveBeenCalledTimes(5);
  });
});

import { describe, expect, test } from "bun:test";
import type { DockerAvailability } from "@orkestrator/protocol/docker-availability";
import { DockerAvailabilityCache } from "./docker-availability-cache.js";

const UP: DockerAvailability = { available: true, reason: null };
const DOWN: DockerAvailability = { available: false, reason: "daemon-unavailable" };

describe("DockerAvailabilityCache", () => {
  test("without a probe it knows only what check_docker recorded", async () => {
    const cache = new DockerAvailabilityCache();
    expect(await cache.forSummary()).toBeUndefined();
    cache.record(DOWN);
    expect(await cache.forSummary()).toBe(false);
  });

  test("concurrent summary reads share one probe, and a fresh answer is reused", async () => {
    let clock = 0;
    let probes = 0;
    const cache = new DockerAvailabilityCache({
      now: () => clock,
      ttlMs: 1_000,
      probe: async () => {
        probes += 1;
        return UP;
      },
    });
    expect(await Promise.all([cache.forSummary(), cache.forSummary(), cache.forSummary()])).toEqual(
      [true, true, true],
    );
    expect(probes).toBe(1);
    clock = 999;
    expect(await cache.forSummary()).toBe(true);
    expect(probes).toBe(1);
    clock = 1_000;
    expect(await cache.forSummary()).toBe(true);
    expect(probes).toBe(2);
  });

  test("a recorded check_docker answer replaces the cached one", async () => {
    const cache = new DockerAvailabilityCache({ now: () => 0, probe: async () => UP });
    expect(await cache.forSummary()).toBe(true);
    cache.record(DOWN);
    expect(await cache.forSummary()).toBe(false);
  });

  test("a hung probe answers the last known value after the bounded wait", async () => {
    let clock = 0;
    let release: (value: DockerAvailability) => void = () => undefined;
    const cache = new DockerAvailabilityCache({
      now: () => clock,
      ttlMs: 10,
      waitMs: 5,
      probe: () =>
        new Promise<DockerAvailability>((resolve) => {
          release = resolve;
        }),
    });
    // Nothing known yet: unknown, never a guess.
    expect(await cache.forSummary()).toBeUndefined();
    cache.record(UP);
    clock = 100;
    expect(await cache.forSummary()).toBe(true);
    // The probe that finally answers becomes the value.
    release(DOWN);
    await Promise.resolve();
    await Promise.resolve();
    expect(await cache.forSummary()).toBe(false);
  });

  test("a failed probe keeps the last answer and is retried by the next read", async () => {
    let clock = 0;
    let fail = false;
    let probes = 0;
    const cache = new DockerAvailabilityCache({
      now: () => clock,
      ttlMs: 10,
      probe: async () => {
        probes += 1;
        if (fail) throw new Error("probe failed");
        return DOWN;
      },
    });
    expect(await cache.forSummary()).toBe(false);
    fail = true;
    clock = 100;
    expect(await cache.forSummary()).toBe(false);
    expect(await cache.forSummary()).toBe(false);
    expect(probes).toBe(3);
  });
});

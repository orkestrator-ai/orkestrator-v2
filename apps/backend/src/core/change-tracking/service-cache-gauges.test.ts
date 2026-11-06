import { afterEach, expect, test } from "bun:test";
import { recurringWorkDiagnostics } from "../recurring-diagnostics.js";
import { createHarness, type Harness } from "./service-test-support.js";

const HOUR = 60 * 60 * 1000;
const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

const changeTrackingSources = () =>
  recurringWorkDiagnostics().caches.find((entry) => entry.name === "change-tracking")?.sources ?? 0;

test("a deleted environment's fence shows in the gauges until its purge finishes", async () => {
  const before = changeTrackingSources();
  const h = createHarness();
  harnesses.push(h);
  expect(changeTrackingSources()).toBe(before + 1);
  expect(h.service.cacheGauges()).toEqual({
    worktreeOwners: 0,
    evidenceSources: 0,
    unsupportedSources: 0,
    pendingPulls: 0,
    turnFinalizations: 0,
    deletedEnvironments: 0,
  });

  h.service.environmentDeleted("env-1");
  expect(h.service.cacheGauges().deletedEnvironments).toBe(1);
  for (let pass = 0; pass < 3 && h.service.retention.purges.pendingPurges().length > 0; pass += 1)
    await h.service.retention.run(Date.now() + 2 * HOUR);
  expect(h.service.retention.purges.pendingPurges()).toEqual([]);
  expect(h.service.cacheGauges().deletedEnvironments).toBe(0);

  harnesses.splice(harnesses.indexOf(h), 1);
  h.cleanup();
  expect(changeTrackingSources()).toBe(before);
});

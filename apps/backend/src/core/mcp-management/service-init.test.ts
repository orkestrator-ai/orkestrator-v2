import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { McpOperationStore } from "./operations-store.js";
import { createFixture, type Fixture } from "./test-support.js";

let fixture: Fixture | undefined;
let load: ReturnType<typeof spyOn<McpOperationStore, "load">> | undefined;
afterEach(async () => {
  load?.mockRestore();
  load = undefined;
  await fixture?.cleanup();
  fixture = undefined;
});

describe("McpManagementService.init", () => {
  test("a failed init is retried by the next call instead of poisoning the service", async () => {
    fixture = createFixture();
    load = spyOn(McpOperationStore.prototype, "load");
    load.mockImplementationOnce(async () => {
      throw new Error("operations unavailable");
    });
    const first = fixture.service.init();
    // Concurrent callers share the one failing attempt.
    expect(fixture.service.init()).toBe(first);
    await expect(first).rejects.toThrow("operations unavailable");
    expect(load).toHaveBeenCalledTimes(1);

    await fixture.service.init();
    expect(load).toHaveBeenCalledTimes(2);
    await expect(fixture.service.listTargets({})).resolves.toBeDefined();
    // A successful init is kept.
    await fixture.service.init();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("concurrent callers share one successful attempt", async () => {
    fixture = createFixture();
    load = spyOn(McpOperationStore.prototype, "load");
    const calls = [fixture.service.init(), fixture.service.init(), fixture.service.init()];
    expect(new Set(calls).size).toBe(1);
    await Promise.all(calls);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

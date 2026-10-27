import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFixture, type Fixture } from "./test-support.js";

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("McpManagementService.settled", () => {
  test("returns with no pass running, including after disposal", async () => {
    fixture = createFixture();
    await fixture.service.settled();
    fixture.service.dispose();
    await fixture.service.settled();
  });

  test("waits for the active pass and a caller's queued follow-up pass", async () => {
    fixture = createFixture();
    const service = fixture.service;
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    // Hold the apply-pass boundary; tick() and settled() retain real coordination.
    const advance = spyOn(service as unknown as { advanceTick(): Promise<void> }, "advanceTick")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => {
        secondStarted.resolve();
        return second.promise;
      });
    const active = service.tick();
    const queued = service.tick();
    let settled = false;
    const settlement = service.settled().then(() => {
      settled = true;
    });
    try {
      expect(settled).toBe(false);
      first.resolve();
      await secondStarted.promise;
      await active;
      expect(settled).toBe(false);
      service.dispose();
      second.resolve();
      await Promise.all([queued, settlement]);
      expect(settled).toBe(true);
      expect(advance).toHaveBeenCalledTimes(2);
      await service.settled();
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([active, queued, settlement]);
      advance.mockRestore();
    }
  });

  test("disposal stops a follow-up queued after settlement begins", async () => {
    fixture = createFixture();
    const { service, root } = fixture;
    const first = Promise.withResolvers<void>();
    const advance = spyOn(service as unknown as { advanceTick(): Promise<void> }, "advanceTick")
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => {
        mkdirSync(root, { recursive: true });
        writeFileSync(path.join(root, "late-apply"), "unexpected");
      });
    const active = service.tick();
    const settlement = service.settled();
    const queued = service.tick();
    service.dispose();
    try {
      first.resolve();
      await Promise.all([active, settlement, queued]);
      await service.tick();
      expect(advance).toHaveBeenCalledTimes(1);
      await fixture.cleanup();
      await service.tick();
      expect(existsSync(root)).toBe(false);
    } finally {
      first.resolve();
      await Promise.all([active, settlement, queued]);
      advance.mockRestore();
    }
  });
});

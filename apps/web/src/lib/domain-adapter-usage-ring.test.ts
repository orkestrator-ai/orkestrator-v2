import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  DomainAdapterUsageRing,
  type DomainAdapterUsageEntry,
} from "@orkestrator/protocol/contract/client-usage";
import {
  domainAdapterUsageRing,
  recordDomainAdapterUsage,
  startDomainAdapterUsageUpload,
} from "./domain-adapter-usage-ring";

function fakeTimer() {
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  let next = 1;
  return {
    pending,
    set: (callback: () => void, delayMs: number) => {
      pending.set(next, { callback, delayMs });
      return next++;
    },
    clear: (handle: unknown) => {
      pending.delete(handle as number);
    },
    /** Runs the one scheduled callback and lets its send settle. */
    async fire() {
      const [handle, scheduled] = [...pending.entries()][0]!;
      pending.delete(handle);
      scheduled.callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  domainAdapterUsageRing.takeUnsent(Number.MAX_SAFE_INTEGER);
});

describe("the renderer's adapter usage ring", () => {
  test("records through the domain client recorder, names and numbers only", () => {
    recordDomainAdapterUsage("node-mail", 0);
    recordDomainAdapterUsage("node-mail", 0);
    expect(domainAdapterUsageRing.takeUnsent()).toEqual([
      { domain: "node-mail", version: 0, count: 2 },
    ]);
  });
});

describe("startDomainAdapterUsageUpload", () => {
  test("stays idle with nothing to send, then sends one batch per interval", async () => {
    const ring = new DomainAdapterUsageRing();
    const timer = fakeTimer();
    const sent: DomainAdapterUsageEntry[][] = [];
    stops.push(
      startDomainAdapterUsageUpload({
        ring,
        timer,
        intervalMs: 1_000,
        send: async (entries) => {
          sent.push(entries);
        },
      }),
    );
    expect(timer.pending.size).toBe(0);
    ring.record("ticket-sync", 1);
    ring.record("ticket-sync", 1);
    expect(timer.pending.size).toBe(1);
    expect([...timer.pending.values()][0]!.delayMs).toBe(1_000);
    await timer.fire();
    expect(sent).toEqual([[{ domain: "ticket-sync", version: 1, count: 2 }]]);
    // Nothing new: no timer left running.
    expect(timer.pending.size).toBe(0);
  });

  test("puts counts back and backs off on failure, and stops for an older backend", async () => {
    const ring = new DomainAdapterUsageRing();
    const timer = fakeTimer();
    const failures = [
      new Error("socket hang up"),
      new Error("Unknown backend command: record_domain_adapter_usage"),
    ];
    const send = mock(async () => {
      throw failures.shift();
    });
    stops.push(
      startDomainAdapterUsageUpload({ ring, timer, intervalMs: 1_000, maxIntervalMs: 1_500, send }),
    );
    ring.record("node-mail", 0);
    await timer.fire();
    expect(ring.hasUnsent()).toBe(true);
    expect([...timer.pending.values()][0]!.delayMs).toBe(1_500);
    await timer.fire();
    expect(send).toHaveBeenCalledTimes(2);
    ring.record("node-mail", 0);
    expect(timer.pending.size).toBe(0);
    expect(ring.takeUnsent()).toEqual([{ domain: "node-mail", version: 0, count: 2 }]);
  });

  test("stopping clears the timer", () => {
    const ring = new DomainAdapterUsageRing();
    const timer = fakeTimer();
    const stop = startDomainAdapterUsageUpload({ ring, timer, send: async () => {} });
    ring.record("node-mail", 0);
    expect(timer.pending.size).toBe(1);
    stop();
    expect(timer.pending.size).toBe(0);
    ring.record("node-mail", 0);
    expect(timer.pending.size).toBe(0);
  });
});

import { expect, spyOn, test } from "bun:test";
import { BridgeSessionStore } from "./sessions/persistence.js";
import { deferredSignal, harness } from "./app-server-runtime-test-harness.js";

test("a restoration failure releases waiters as unavailable and a later start retries", async () => {
  const h = await harness({}, { deferStart: true });
  const gate = deferredSignal();
  const realLoad = BridgeSessionStore.prototype.load;
  const load = spyOn(BridgeSessionStore.prototype, "load").mockImplementationOnce(async () => {
    await gate.promise;
    throw new Error("restoration failed");
  });
  const started = h.runtime.start();
  const failure = started.then(
    () => null,
    (error: unknown) => error,
  );
  const waiting = h.runtime.whenSessionsRestored(5_000);
  try {
    gate.resolve();
    expect(await failure).toMatchObject({ message: "restoration failed" });
    expect(await waiting).toBe(false);
    expect(await h.runtime.whenSessionsRestored(0)).toBe(false);
    expect(h.children).toHaveLength(0);
    // Retry uses a fresh barrier, so a waiter cannot inherit the failed result.
    const retryGate = deferredSignal();
    load.mockImplementation(async function (this: BridgeSessionStore) {
      await retryGate.promise;
      return realLoad.call(this);
    });
    const retry = h.runtime.start();
    const restored = h.runtime.whenSessionsRestored(5_000);
    retryGate.resolve();
    expect(await restored).toBe(true);
    await retry;
    expect(h.engine.getHealth().state).toBe("ready");
  } finally {
    gate.resolve();
    await started.catch(() => undefined);
    load.mockRestore();
  }
});

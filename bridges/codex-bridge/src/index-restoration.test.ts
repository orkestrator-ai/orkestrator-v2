import { afterAll, expect, spyOn, test } from "bun:test";
import { BridgeSessionStore } from "./sessions/persistence.js";
import { codexHome, deferredSignal, harness } from "./app-server-runtime-test-harness.js";

process.env.CODEX_BRIDGE_NO_ENGINE = "1";
process.env.CODEX_BRIDGE_NO_SERVER = "1";
process.env.CODEX_BRIDGE_AUTH_DISABLED_FOR_TESTING = "1";
const { app, __testing } = await import("./index.js");
const routeRuntime = __testing.runtimeForTesting();
afterAll(async () => {
  await routeRuntime.stop();
});

test("listening starts behind restoration and held HTTP reads finish before engine startup", async () => {
  const store = new BridgeSessionStore({ codexHome, cwd: "/tmp/ws" });
  await store.upsert(
    store.toRecord({
      bridgeSessionId: "session-on-disk",
      threadId: "thread-on-disk",
      cwd: "/tmp/ws",
      config: { mode: "build", sandbox: "danger-full-access" },
    }),
  );
  const h = await harness({}, { deferStart: true });
  const storeGate = deferredSignal();
  const storeEntered = deferredSignal();
  const engineGate = deferredSignal();
  const engineEntered = deferredSignal();
  const requestEntered = deferredSignal();
  const realLoad = BridgeSessionStore.prototype.load;
  const load = spyOn(BridgeSessionStore.prototype, "load").mockImplementation(async function (
    this: BridgeSessionStore,
  ) {
    storeEntered.resolve();
    await storeGate.promise;
    return realLoad.call(this);
  });
  const realStart = h.engine.start.bind(h.engine);
  h.engine.start = async () => {
    engineEntered.resolve();
    await engineGate.promise;
    return realStart();
  };
  const originalBarrier = routeRuntime.whenSessionsRestored;
  const originalStatus = routeRuntime.getStatus;
  routeRuntime.whenSessionsRestored = (timeout) => {
    requestEntered.resolve();
    return h.runtime.whenSessionsRestored(timeout);
  };
  routeRuntime.getStatus = (id) => h.runtime.getStatus(id);
  let startup: Promise<void> | undefined;
  let pending: Promise<Response> | undefined;
  let settled = false;
  let restoredAtListen: Promise<boolean> | undefined;
  try {
    __testing.startBridgeForTesting(
      {},
      () => {
        // The listener is invoked synchronously: a server-first regression would
        // let this check return true from the untouched, empty registry.
        restoredAtListen = h.runtime.whenSessionsRestored(0);
        expect(h.runtime.getActivity("session-on-disk")).toBe("missing");
        pending = app.request("/session/session-on-disk/status").then((response) => {
          settled = true;
          return response;
        });
        return undefined;
      },
      {
        start: () => {
          startup = h.runtime.start();
          return startup;
        },
        getHealth: () => h.runtime.getHealth(),
      },
    );
    await storeEntered.promise;
    expect(await restoredAtListen).toBe(false);
    await requestEntered.promise;
    expect(await h.runtime.whenSessionsRestored(0)).toBe(false);
    expect(settled).toBe(false);
    expect((await app.request("/global/health")).status).toBe(200);
    storeGate.resolve();
    await engineEntered.promise;
    const response = await pending!;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ threadId: "thread-on-disk", status: "idle" });
    expect(h.children).toHaveLength(0);
    expect((await app.request("/global/health")).status).toBe(200);
  } finally {
    storeGate.resolve();
    engineGate.resolve();
    await startup;
    await pending;
    load.mockRestore();
    routeRuntime.whenSessionsRestored = originalBarrier;
    routeRuntime.getStatus = originalStatus;
  }
});

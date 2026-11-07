import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  defineScopedService,
  type ScopedServiceDef,
  type ScopedServiceInstance,
} from "./scoped-service";
import { WindowScope } from "./window-scope";

const NODE_A = "bk_node-a" as BackendId;
const NODE_B = "bk_node-b" as BackendId;

/** Timers a test service starts, so `afterEach` can prove each one was stopped. */
const liveTimers = new Set<ReturnType<typeof setInterval>>();

const polling = defineScopedService("test-polling", (scope) => {
  const timer = setInterval(() => {}, 60_000);
  liveTimers.add(timer);
  const unlisten = scope.client.listenRaw("resource-changed", () => {});
  return {
    stop() {
      clearInterval(timer);
      liveTimers.delete(timer);
      unlisten();
    },
  };
});

let windowScope: WindowScope;
let clientA: FakeNodeClient;
let clientB: FakeNodeClient;
let logs: LogCapture;

beforeEach(() => {
  logs = captureLogs();
  windowScope = new WindowScope();
  clientA = new FakeNodeClient({ nodeId: NODE_A });
  clientB = new FakeNodeClient({ nodeId: NODE_B });
});

afterEach(() => {
  windowScope.dispose();
  logs.restore();
  // Invariant 15: whatever a scope started is stopped once its window is disposed.
  expect(liveTimers.size).toBe(0);
  expect(clientA.listenerCount()).toBe(0);
  expect(clientB.listenerCount()).toBe(0);
});

describe("scoped service lifecycle", () => {
  test("start is idempotent while running", () => {
    const scope = windowScope.open({ role: "command", client: clientA });
    const first = scope.service(polling);
    const second = scope.service(polling);
    expect(second).toBe(first);
    expect(liveTimers.size).toBe(1);
    expect(clientA.listenerCount("resource-changed")).toBe(1);
    expect(first.status).toBe("running");
  });

  test("stop is idempotent, aborts the signal, and a later start runs it afresh", () => {
    const scope = windowScope.open({ role: "command", client: clientA });
    const handle = scope.service(polling);
    handle.stop();
    handle.stop();
    expect(handle.status).toBe("stopped");
    expect(handle.signal.aborted).toBe(true);
    expect(liveTimers.size).toBe(0);
    expect(clientA.listenerCount()).toBe(0);

    const restarted = scope.service(polling);
    expect(restarted).not.toBe(handle);
    expect(restarted.status).toBe("running");
    expect(restarted.signal.aborted).toBe(false);
    expect(liveTimers.size).toBe(1);
  });

  test("the service's stop runs before its signal aborts", () => {
    const order: string[] = [];
    const ordered = defineScopedService("test-ordered", (_scope, signal) => {
      signal.addEventListener("abort", () => order.push("aborted"));
      return { stop: () => order.push(`stopped, aborted=${signal.aborted}`) };
    });
    windowScope.open({ role: "command", client: clientA }).service(ordered).stop();
    expect(order).toEqual(["stopped, aborted=false", "aborted"]);
  });

  test("a service that stops itself during start is still stopped once", () => {
    let stops = 0;
    const scope = windowScope.open({ role: "command", client: clientA });
    const selfStopping: ScopedServiceDef = defineScopedService("test-self-stopping", (owner) => {
      owner.service(selfStopping).stop();
      return {
        stop() {
          stops += 1;
        },
      };
    });
    const handle = scope.service(selfStopping);
    handle.stop();
    expect(handle.status).toBe("stopped");
    expect(stops).toBe(1);
  });

  test("a rejection after stop is ignored", async () => {
    const scope = windowScope.open({ role: "command", client: clientA });
    const cancellable = defineScopedService("test-cancellable", (_scope, signal) => ({
      stop() {},
      done: new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    }));
    scope.service(cancellable).stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(scope.health.get()).toEqual({ state: "ok" });
    expect(logs.records().filter((record) => record.event === "service.failed")).toEqual([]);
  });
});

describe("scoped service failure isolation", () => {
  const throwing = defineScopedService("test-throwing", (): ScopedServiceInstance => {
    throw new Error("secret file contents in a message");
  });

  test("a service that throws on start marks only its own scope failed", () => {
    const a = windowScope.open({ role: "command", client: clientA });
    const b = windowScope.open({ role: "leaf", client: clientB });
    const pollingA = a.service(polling);
    const pollingB = b.service(polling);

    const failed = a.service(throwing);

    expect(failed.status).toBe("failed");
    expect(failed.instance).toBeNull();
    expect(failed.signal.aborted).toBe(true);
    expect(a.health.get()).toEqual({ state: "failed", failedServices: ["test-throwing"] });
    expect(b.health.get()).toEqual({ state: "ok" });
    // Its siblings in the same scope and the other scope keep running.
    expect(pollingA.status).toBe("running");
    expect(pollingB.status).toBe("running");
    expect(liveTimers.size).toBe(2);
  });

  test("a rejected `done` stops only that service and is logged without content", async () => {
    const a = windowScope.open({ role: "command", client: clientA });
    const b = windowScope.open({ role: "leaf", client: clientB });
    const rejectDone = new Map<BackendId, (error: Error) => void>();
    let stops = 0;
    const flaky = defineScopedService("test-flaky", (scope) => ({
      stop() {
        stops += 1;
      },
      done: new Promise((_, reject) => {
        rejectDone.set(scope.nodeId, reject);
      }),
    }));
    const handle = a.service(flaky);
    const pollingA = a.service(polling);
    b.service(flaky);

    const aborted = new Promise((resolve) => {
      handle.signal.addEventListener("abort", resolve, { once: true });
    });
    const error = new Error("/Users/someone/private/path");
    error.name = "ProbeError";
    rejectDone.get(NODE_A)?.(error);
    await aborted;

    expect(handle.status).toBe("failed");
    expect(stops).toBe(1);
    expect(pollingA.status).toBe("running");
    expect(a.health.get()).toEqual({ state: "failed", failedServices: ["test-flaky"] });
    expect(b.health.get()).toEqual({ state: "ok" });

    const failures = logs.records().filter((record) => record.event === "service.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      area: "web.node-scope",
      level: "warn",
      fields: { service: "test-flaky", role: "command", error: "ProbeError" },
    });
    expect(logs.lines.join("\n")).not.toContain("private");
  });

  test("starting a failed service again clears the scope's failure", () => {
    let attempts = 0;
    const recovering = defineScopedService("test-recovering", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first start fails");
      return { stop() {} };
    });
    const scope = windowScope.open({ role: "command", client: clientA });
    expect(scope.service(recovering).status).toBe("failed");
    expect(scope.health.get().state).toBe("failed");

    expect(scope.service(recovering).status).toBe("running");
    expect(scope.health.get()).toEqual({ state: "ok" });
  });

  test("a disposed scope refuses to start services", () => {
    const scope = windowScope.open({ role: "command", client: clientA });
    scope.dispose();
    expect(() => scope.service(polling)).toThrow(/disposed/);
  });
});

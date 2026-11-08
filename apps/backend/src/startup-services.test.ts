import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import type { GatewayStartInfo } from "./gateway.js";
import {
  createBackendLifetime,
  gatewayServicesStage,
  startGatewayServices,
  type GatewayStartupDependencies,
} from "./startup-services.js";

const info: GatewayStartInfo = {
  bindAddress: "127.0.0.1",
  port: 1234,
  url: "http://127.0.0.1:1234",
  browserUrl: "http://127.0.0.1:1235",
  loopbackClientUrl: "http://127.0.0.1:1236",
  token: "fixture",
  authFile: "/fixture/auth",
};

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});
const warnedSteps = () =>
  logs
    .records()
    .filter((record) => record.event === "shutdown.step-failed")
    .map((record) => record.fields?.step);
const startupFailures = () => logs.records().filter((record) => record.event === "startup.failed");

function fixture() {
  const gateway = {
    start: mock(async (): Promise<GatewayStartInfo | null> => info),
    stop: mock(async () => {}),
  };
  const serve = { start: mock(async () => "https://fixture.invalid"), stop: mock(async () => {}) };
  const managed = {
    setBrowserListenerUrl: mock(() => {}),
    setEnabled: mock(async () => ({ enabled: true, running: false, url: null, error: null })),
    shutdown: mock(async () => {}),
  };
  const deps: GatewayStartupDependencies = {
    createGateway: () => gateway,
    reservePorts: mock(() => {}),
    loadWebClientEnabled: mock(async () => true),
    managedWebClient: null,
    tailscaleServe: false,
    tailscaleServePort: 443,
    createTailscaleServe: () => serve,
  };
  const backend = { init: mock(async () => {}), shutdown: mock(async () => {}) };
  const exit = mock((_code: number) => {});
  const lifetime = createBackendLifetime({ exit });
  const ready = mock(() => {});
  // The stages main.ts runs, in its order.
  const startup = Effect.gen(function* () {
    yield* lifetime.stage(
      () => backend.init(),
      [{ step: "local-servers", run: () => backend.shutdown(), fatal: true }],
    );
    const services = yield* gatewayServicesStage(lifetime, deps);
    ready();
    return services;
  }).pipe(Effect.asVoid);
  return { gateway, serve, managed, deps, backend, exit, lifetime, ready, startup };
}

describe("backend lifetime", () => {
  test("releases stages in reverse order, each step in order, then exits 0", async () => {
    const order: string[] = [];
    const exit = mock((code: number) => {
      order.push(`exit:${code}`);
    });
    const lifetime = createBackendLifetime({ exit });
    const started = await lifetime.start(
      Effect.gen(function* () {
        yield* lifetime.stage(
          () => order.push("backend:init"),
          [{ step: "local-servers", run: () => order.push("backend:shutdown"), fatal: true }],
        );
        yield* lifetime.stage(
          () => order.push("gateway:start"),
          [
            { step: "tailscale-serve", run: () => order.push("tailscale") },
            { step: "gateway", run: () => order.push("gateway:stop"), fatal: true },
          ],
        );
      }),
    );
    expect(started).toBe(true);
    await lifetime.stop("SIGTERM");
    expect(order).toEqual([
      "backend:init",
      "gateway:start",
      "tailscale",
      "gateway:stop",
      "backend:shutdown",
      "exit:0",
    ]);
    expect(
      logs.records().map(({ level, area, event, fields }) => [level, area, event, fields]),
    ).toEqual([
      ["info", "backend", "shutdown.signal-received", { signal: "SIGTERM" }],
      ["info", "backend", "shutdown.finished", { code: 0 }],
    ]);
  });

  test("is idempotent and keeps the first signal's SIGINT exit code", async () => {
    const { lifetime, startup, backend, exit } = fixture();
    await lifetime.start(startup);
    const first = lifetime.stop("SIGINT");
    expect(lifetime.stop("SIGTERM")).toBe(first);
    await first;
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  test("a signal during init waits for it, starts nothing more and shuts down once", async () => {
    const { lifetime, startup, backend, gateway, exit, ready } = fixture();
    const init = Promise.withResolvers<void>();
    const initStarted = Promise.withResolvers<void>();
    backend.init.mockImplementation(() => {
      initStarted.resolve();
      return init.promise;
    });
    const started = lifetime.start(startup);
    await initStarted.promise;

    const stopped = lifetime.stop("SIGTERM");
    await Bun.sleep(0);
    // Shutting down beside a running init would race what init still starts.
    expect(backend.shutdown).not.toHaveBeenCalled();
    init.resolve();
    await stopped;

    expect(await started).toBe(false);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(gateway.start).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(startupFailures()).toEqual([]);
  });

  test("a failed init still shuts down the backend and exits 1", async () => {
    const { lifetime, startup, backend, gateway, exit, ready } = fixture();
    backend.init.mockRejectedValue(new Error("bind failed"));
    expect(await lifetime.start(startup)).toBe(false);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(gateway.start).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(startupFailures()).toHaveLength(1);
    expect(logs.lines.join("\n")).toContain("bind failed");
    // A late signal joins the stop that already ran.
    await lifetime.stop("SIGTERM");
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test("a signal before startup runs no stage", async () => {
    const { lifetime, startup, backend, exit } = fixture();
    await lifetime.stop("SIGTERM");
    expect(await lifetime.start(startup)).toBe(false);
    expect(backend.init).not.toHaveBeenCalled();
    expect(backend.shutdown).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("optional step failures are logged; a fatal one exits 1 after every step ran", async () => {
    const { lifetime, startup, deps, backend, gateway, serve, exit } = fixture();
    deps.tailscaleServe = true;
    serve.stop.mockRejectedValue(new Error("serve cleanup failed"));
    gateway.stop.mockRejectedValue(new Error("gateway cleanup failed"));
    await lifetime.start(startup);
    await lifetime.stop("SIGTERM");
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(warnedSteps()).toEqual(["tailscale-serve", "gateway"]);
    expect(logs.lines.join("\n")).toContain("serve cleanup failed");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("only optional step failures still exit 0", async () => {
    const { lifetime, startup, deps, managed, exit } = fixture();
    deps.managedWebClient = managed;
    managed.shutdown.mockRejectedValue("managed cleanup failed");
    await lifetime.start(startup);
    await lifetime.stop("SIGTERM");
    expect(warnedSteps()).toEqual(["managed-web-client"]);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("gateway startup cleanup", () => {
  test("no Tailscale address stops the gateway and awaits backend shutdown", async () => {
    const { lifetime, startup, gateway, backend, exit } = fixture();
    gateway.start.mockResolvedValue(null);
    const stopped = Promise.withResolvers<void>();
    const shutdownStarted = Promise.withResolvers<void>();
    backend.shutdown.mockImplementation(() => {
      shutdownStarted.resolve();
      return stopped.promise;
    });
    let finished = false;
    const started = lifetime.start(startup).finally(() => {
      finished = true;
    });
    await shutdownStarted.promise;
    expect(finished).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    stopped.resolve();
    expect(await started).toBe(false);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.lines.join("\n")).toContain("No Tailscale address");
  });

  test("a constructor failure still shuts down the initialized backend", async () => {
    const { lifetime, startup, deps, backend, gateway, exit } = fixture();
    deps.createGateway = () => {
      throw new Error("construction failed");
    };
    expect(await lifetime.start(startup)).toBe(false);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(gateway.stop).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.lines.join("\n")).toContain("construction failed");
  });

  test("a rejected gateway start is reported even when cleanup also fails", async () => {
    const { lifetime, startup, backend, gateway, exit } = fixture();
    gateway.start.mockRejectedValue(new Error("listen failed"));
    gateway.stop.mockRejectedValue(new Error("close failed"));
    backend.shutdown.mockRejectedValue(new Error("shutdown failed"));
    expect(await lifetime.start(startup)).toBe(false);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
    expect(startupFailures()).toHaveLength(1);
    expect(logs.lines.join("\n")).toContain("listen failed");
    expect(warnedSteps()).toEqual(["gateway", "local-servers"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a rejected managed-client config read shuts down every owner", async () => {
    const { lifetime, startup, deps, managed, gateway, backend } = fixture();
    deps.managedWebClient = managed;
    deps.loadWebClientEnabled = async () => {
      throw new Error("get_config failed");
    };
    managed.shutdown.mockRejectedValue(new Error("managed stop failed"));
    expect(await lifetime.start(startup)).toBe(false);
    expect(managed.setEnabled).not.toHaveBeenCalled();
    expect(managed.shutdown).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
  });

  test("missing browser listener shuts down the backend even when gateway stop rejects", async () => {
    const { lifetime, startup, deps, gateway, serve, backend } = fixture();
    deps.tailscaleServe = true;
    gateway.start.mockResolvedValue({ ...info, browserUrl: undefined });
    gateway.stop.mockRejectedValue(new Error("close failed"));
    expect(await lifetime.start(startup)).toBe(false);
    expect(logs.lines.join("\n")).toContain("requires an available browser listener");
    expect(serve.start).not.toHaveBeenCalled();
    expect(serve.stop).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
  });

  test("a failed Serve start attempts all stops", async () => {
    const { lifetime, startup, deps, gateway, serve, backend } = fixture();
    deps.tailscaleServe = true;
    serve.start.mockRejectedValue(new Error("Serve failed"));
    serve.stop.mockRejectedValue(new Error("Serve stop failed"));
    gateway.stop.mockRejectedValue(new Error("gateway stop failed"));
    expect(await lifetime.start(startup)).toBe(false);
    expect(logs.lines.join("\n")).toContain("Serve failed");
    expect(serve.stop).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
  });

  test("successful Serve startup hands off ownership and reserves gateway listeners", async () => {
    const { deps, gateway, serve } = fixture();
    deps.tailscaleServe = true;
    const result = await startGatewayServices(deps);
    expect(result).toEqual({
      gatewayInfo: info,
      info: { ...info, browserUrl: "https://fixture.invalid" },
      tailscaleServe: serve,
    });
    expect(serve.start).toHaveBeenCalledWith(1235, 443, { adoptExisting: true });
    expect(deps.reservePorts).toHaveBeenCalledWith([1234, 1235, 1236]);
    expect(gateway.stop).not.toHaveBeenCalled();
  });

  test("managed startup uses configuration and leaves its public URL to the managed client", async () => {
    const { deps, managed } = fixture();
    deps.managedWebClient = managed;
    deps.loadWebClientEnabled = async () => false;
    const result = await startGatewayServices(deps);
    expect(result.info.browserUrl).toBeUndefined();
    expect(managed.setBrowserListenerUrl).toHaveBeenCalledWith(info.browserUrl);
    expect(managed.setEnabled).toHaveBeenCalledWith(false);
    expect(managed.shutdown).not.toHaveBeenCalled();
  });

  test("a started stage keeps its services until the backend stops", async () => {
    const { lifetime, startup, deps, gateway, serve, backend, ready } = fixture();
    deps.tailscaleServe = true;
    expect(await lifetime.start(startup)).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(gateway.stop).not.toHaveBeenCalled();
    expect(serve.stop).not.toHaveBeenCalled();
    expect(backend.shutdown).not.toHaveBeenCalled();
    await lifetime.stop("SIGTERM");
    expect(serve.stop).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(backend.shutdown).toHaveBeenCalledTimes(1);
  });
});

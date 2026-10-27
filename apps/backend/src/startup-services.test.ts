import { describe, expect, mock, test } from "bun:test";
import type { GatewayStartInfo } from "./gateway.js";
import { startGatewayServices, type GatewayStartupDependencies } from "./startup-services.js";

const info: GatewayStartInfo = {
  bindAddress: "127.0.0.1",
  port: 1234,
  url: "http://127.0.0.1:1234",
  browserUrl: "http://127.0.0.1:1235",
  loopbackClientUrl: "http://127.0.0.1:1236",
  token: "fixture",
  authFile: "/fixture/auth",
};

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
    shutdownBackend: mock(async () => {}),
    managedWebClient: null,
    tailscaleServe: false,
    tailscaleServePort: 443,
    createTailscaleServe: () => serve,
    logger: { info: mock(() => {}), error: mock(() => {}) },
  };
  return { gateway, serve, managed, deps };
}

describe("gateway startup cleanup", () => {
  test("no Tailscale address stops the gateway and awaits backend shutdown", async () => {
    const { deps, gateway } = fixture();
    gateway.start.mockResolvedValue(null);
    const stopped = Promise.withResolvers<void>();
    const shutdownStarted = Promise.withResolvers<void>();
    deps.shutdownBackend = () => {
      shutdownStarted.resolve();
      return stopped.promise;
    };
    let finished = false;
    const startup = startGatewayServices(deps).catch((error: unknown) => {
      finished = true;
      return error;
    });
    await shutdownStarted.promise;
    expect(finished).toBe(false);
    stopped.resolve();
    expect(await startup).toMatchObject({
      message: expect.stringContaining("No Tailscale address"),
    });
    expect(gateway.stop).toHaveBeenCalledTimes(1);
  });

  test("a constructor failure still shuts down the initialized backend", async () => {
    const { deps } = fixture();
    const error = new Error("construction failed");
    deps.createGateway = () => {
      throw error;
    };
    await expect(startGatewayServices(deps)).rejects.toBe(error);
    expect(deps.shutdownBackend).toHaveBeenCalledTimes(1);
  });

  test("a rejected gateway start preserves its error even when cleanup also fails", async () => {
    const { deps, gateway } = fixture();
    const error = new Error("listen failed");
    gateway.start.mockRejectedValue(error);
    gateway.stop.mockRejectedValue(new Error("close failed"));
    deps.shutdownBackend = mock(async () => {
      throw new Error("shutdown failed");
    });
    await expect(startGatewayServices(deps)).rejects.toBe(error);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(deps.shutdownBackend).toHaveBeenCalledTimes(1);
  });

  test("a rejected managed-client config read shuts down every owner", async () => {
    const { deps, managed, gateway } = fixture();
    deps.managedWebClient = managed;
    const error = new Error("get_config failed");
    deps.loadWebClientEnabled = async () => {
      throw error;
    };
    managed.shutdown.mockRejectedValue(new Error("managed stop failed"));
    await expect(startGatewayServices(deps)).rejects.toBe(error);
    expect(managed.setEnabled).not.toHaveBeenCalled();
    expect(managed.shutdown).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(deps.shutdownBackend).toHaveBeenCalledTimes(1);
  });

  test("missing browser listener shuts down the backend even when gateway stop rejects", async () => {
    const { deps, gateway, serve } = fixture();
    deps.tailscaleServe = true;
    gateway.start.mockResolvedValue({ ...info, browserUrl: undefined });
    gateway.stop.mockRejectedValue(new Error("close failed"));
    await expect(startGatewayServices(deps)).rejects.toThrow(
      "requires an available browser listener",
    );
    expect(serve.start).not.toHaveBeenCalled();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(deps.shutdownBackend).toHaveBeenCalledTimes(1);
  });

  test("a failed Serve start attempts all stops and preserves its original error", async () => {
    const { deps, gateway, serve } = fixture();
    deps.tailscaleServe = true;
    const error = new Error("Serve failed");
    serve.start.mockRejectedValue(error);
    serve.stop.mockRejectedValue(new Error("Serve stop failed"));
    gateway.stop.mockRejectedValue(new Error("gateway stop failed"));
    await expect(startGatewayServices(deps)).rejects.toBe(error);
    expect(serve.stop).toHaveBeenCalledTimes(1);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(deps.shutdownBackend).toHaveBeenCalledTimes(1);
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
    expect(deps.shutdownBackend).not.toHaveBeenCalled();
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
    expect(deps.shutdownBackend).not.toHaveBeenCalled();
  });
});

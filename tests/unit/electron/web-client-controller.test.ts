import { describe, expect, mock, test } from "bun:test";
import { WebClientController } from "../../../electron/web-client-controller";
import type { GatewayStartInfo } from "../../../electron/gateway";

const TOKEN_SETTINGS = { token: "test-token-123456", editable: true, source: "file" as const };

const START_INFO: GatewayStartInfo = {
  bindAddress: "100.88.12.3",
  port: 34121,
  url: "http://100.88.12.3:34121/",
  token: "test-token",
  authFile: "/tmp/gateway-auth.json",
};

function createHarness(options: {
  start?: () => Promise<GatewayStartInfo | null>;
  stop?: () => Promise<void>;
  getTokenSettings?: () => Promise<typeof TOKEN_SETTINGS>;
  setToken?: (token: string) => Promise<typeof TOKEN_SETTINGS>;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const start = mock(options.start ?? (async () => START_INFO));
  const stop = mock(options.stop ?? (async () => undefined));
  const getTokenSettings = mock(options.getTokenSettings ?? (async () => TOKEN_SETTINGS));
  const setToken = mock(options.setToken ?? (async (token: string) => ({ ...TOKEN_SETTINGS, token })));
  const logger = { error: mock(() => undefined) };
  const controller = new WebClientController({ start, stop, getTokenSettings, setToken }, options.env ?? {}, logger);
  return { controller, start, stop, getTokenSettings, setToken, logger };
}

describe("WebClientController", () => {
  test("starts with the backward-compatible enabled but not-running snapshot", () => {
    expect(createHarness().controller.getStatus()).toEqual({
      enabled: true,
      running: false,
      url: null,
      error: null,
    });
  });

  test("starts the gateway and treats repeated enable calls as idempotent", async () => {
    const { controller, start } = createHarness();

    await expect(controller.setEnabled(true)).resolves.toEqual({
      enabled: true,
      running: true,
      url: START_INFO.url,
      error: null,
    });
    await controller.setEnabled(true);

    expect(start).toHaveBeenCalledTimes(1);
    expect(controller.getStatus().running).toBe(true);
  });

  test("reports missing Tailscale and environment-disabled startup states", async () => {
    const unavailable = createHarness({ start: async () => null });
    expect((await unavailable.controller.setEnabled(true)).error).toContain("No Tailscale connection");

    const envDisabled = createHarness({
      start: async () => null,
      env: { ORKESTRATOR_GATEWAY_DISABLED: "1" },
    });
    expect((await envDisabled.controller.setEnabled(true)).error).toContain("ORKESTRATOR_GATEWAY_DISABLED");
  });

  test("surfaces start errors without marking the gateway as running", async () => {
    const { controller, logger } = createHarness({
      start: async () => { throw new Error("address in use"); },
    });

    await expect(controller.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
      error: "address in use",
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test("stops a running gateway and clears its live URL", async () => {
    const { controller, stop } = createHarness();
    await controller.setEnabled(true);

    await expect(controller.setEnabled(false)).resolves.toEqual({
      enabled: false,
      running: false,
      url: null,
      error: null,
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("retains running state when shutdown fails", async () => {
    const { controller, logger } = createHarness({
      stop: async () => { throw new Error("close failed"); },
    });
    await controller.setEnabled(true);

    await expect(controller.setEnabled(false)).resolves.toEqual({
      enabled: false,
      running: true,
      url: START_INFO.url,
      error: "close failed",
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test("serializes rapid transitions in request order", async () => {
    let releaseStop: (() => void) | undefined;
    const stopPending = new Promise<void>((resolve) => { releaseStop = resolve; });
    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve; });
    const calls: string[] = [];
    const { controller } = createHarness({
      start: async () => { calls.push("start"); return START_INFO; },
      stop: async () => { calls.push("stop"); markStopStarted?.(); await stopPending; },
    });

    const disable = controller.setEnabled(false);
    const enable = controller.setEnabled(true);
    await stopStarted;
    expect(calls).toEqual(["stop"]);

    releaseStop?.();
    await Promise.all([disable, enable]);
    expect(calls).toEqual(["stop", "start"]);
    expect(controller.getStatus()).toMatchObject({ enabled: true, running: true });
  });

  test("reads and updates gateway token settings through the serialized gateway boundary", async () => {
    const { controller, getTokenSettings, setToken } = createHarness();

    await expect(controller.getTokenSettings()).resolves.toEqual(TOKEN_SETTINGS);
    await expect(controller.setToken("replacement-token-123456")).resolves.toEqual({
      ...TOKEN_SETTINGS,
      token: "replacement-token-123456",
    });
    expect(getTokenSettings).toHaveBeenCalledTimes(1);
    expect(setToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("recovers the operation queue after a token read fails", async () => {
    const { controller, setToken } = createHarness({
      getTokenSettings: async () => { throw new Error("read failed"); },
    });

    await expect(controller.getTokenSettings()).rejects.toThrow("read failed");
    await expect(controller.setToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(setToken).toHaveBeenCalledTimes(1);
  });

  test("serializes token operations with enable and disable transitions", async () => {
    let releaseToken: (() => void) | undefined;
    let markTokenStarted: (() => void) | undefined;
    const tokenPending = new Promise<void>((resolve) => { releaseToken = resolve; });
    const tokenStarted = new Promise<void>((resolve) => { markTokenStarted = resolve; });
    const calls: string[] = [];
    const { controller } = createHarness({
      setToken: async (token: string) => {
        calls.push(`token:${token}`);
        markTokenStarted?.();
        await tokenPending;
        return { ...TOKEN_SETTINGS, token };
      },
      stop: async () => { calls.push("stop"); },
    });

    const rotation = controller.setToken("replacement-token-123456");
    const disable = controller.setEnabled(false);
    await tokenStarted;
    expect(calls).toEqual(["token:replacement-token-123456"]);

    releaseToken?.();
    await Promise.all([rotation, disable]);
    expect(calls).toEqual(["token:replacement-token-123456", "stop"]);
  });
});

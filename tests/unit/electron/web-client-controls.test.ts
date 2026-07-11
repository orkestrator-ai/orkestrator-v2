import { describe, expect, mock, test } from "bun:test";
import {
  createWebClientControls,
  type WebClientControlTarget,
} from "../../../electron/web-client-controls";

const STATUS = {
  enabled: true,
  running: true,
  url: "http://100.88.12.3:34121/",
  error: null,
};
const TOKEN_SETTINGS = {
  token: "test-token-123456",
  editable: true,
  source: "file" as const,
};

describe("main-process web client controls", () => {
  test("forwards every operation to the current controller", async () => {
    const target = {
      getStatus: mock(() => STATUS),
      setEnabled: mock(async (enabled: boolean) => ({ ...STATUS, enabled })),
      getTokenSettings: mock(async () => TOKEN_SETTINGS),
      setToken: mock(async (token: string) => ({ ...TOKEN_SETTINGS, token })),
    };
    const controls = createWebClientControls(() => target);

    expect(controls.getWebClientStatus()).toEqual(STATUS);
    await expect(controls.setWebClientEnabled(false)).resolves.toMatchObject({ enabled: false });
    await expect(controls.getGatewayTokenSettings()).resolves.toEqual(TOKEN_SETTINGS);
    await expect(controls.setGatewayToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(target.setEnabled).toHaveBeenCalledWith(false);
    expect(target.setToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("returns the legacy status fallback and rejects credential operations before initialization", async () => {
    const controls = createWebClientControls(() => null);

    expect(controls.getWebClientStatus()).toEqual({
      enabled: true,
      running: false,
      url: null,
      error: "The web client gateway is not initialized.",
    });
    await expect(controls.setWebClientEnabled(false)).resolves.toMatchObject({ running: false });
    await expect(controls.getGatewayTokenSettings()).rejects.toThrow("not initialized");
    await expect(controls.setGatewayToken("replacement-token-123456")).rejects.toThrow("not initialized");
  });

  test("reads the target lazily so initialization after registration is observed", () => {
    let target: WebClientControlTarget | null = null;
    const controls = createWebClientControls(() => target);
    expect(controls.getWebClientStatus().running).toBe(false);

    target = {
      getStatus: () => STATUS,
      setEnabled: async () => STATUS,
      getTokenSettings: async () => TOKEN_SETTINGS,
      setToken: async () => TOKEN_SETTINGS,
    };
    expect(controls.getWebClientStatus()).toEqual(STATUS);
  });
});

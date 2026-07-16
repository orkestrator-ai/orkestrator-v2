import { describe, expect, test } from "bun:test";
import type { GatewayTokenSettings as BarrelGatewayTokenSettings } from "../../../apps/web/src/types";
import type { GatewayTokenSettings, WebClientStatus } from "../../../apps/web/src/types/webClient";

type WindowWebClientApi = NonNullable<NonNullable<Window["orkestrator"]>["webClient"]>;

const tokenSettings: GatewayTokenSettings = {
  token: "test-token-123456",
  editable: true,
  source: "file",
};
const barrelTokenSettings: BarrelGatewayTokenSettings = tokenSettings;
const status: WebClientStatus = {
  enabled: true,
  running: true,
  url: "http://100.88.12.3:34121/",
  error: null,
  resetAvailable: true,
};

function acceptsWindowApi(api: WindowWebClientApi): WindowWebClientApi {
  return api;
}

describe("web client type contracts", () => {
  test("barrel and direct credential types agree", () => {
    expect(barrelTokenSettings).toEqual(tokenSettings);
    expect(status.running).toBe(true);
  });

  test("window declarations expose all web client operations", async () => {
    const api = acceptsWindowApi({
      getStatus: async () => status,
      setEnabled: async (enabled) => ({ ...status, enabled }),
      resetServe: async () => status,
      getTokenSettings: async () => tokenSettings,
      setToken: async (token) => ({ ...tokenSettings, token }),
    });

    await expect(api.getStatus()).resolves.toEqual(status);
    await expect(api.setEnabled(false)).resolves.toMatchObject({ enabled: false });
    await expect(api.resetServe()).resolves.toEqual(status);
    await expect(api.getTokenSettings()).resolves.toEqual(tokenSettings);
    await expect(api.setToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
  });
});

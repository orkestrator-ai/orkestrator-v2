import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";

export type WebClientControlTarget = {
  getStatus(): WebClientStatus;
  setEnabled(enabled: boolean): Promise<WebClientStatus>;
  getTokenSettings(): Promise<GatewayTokenSettings>;
  setToken(token: string): Promise<GatewayTokenSettings>;
};

export function createWebClientControls(getTarget: () => WebClientControlTarget | null) {
  const unavailableStatus = (): WebClientStatus => ({
    enabled: true,
    running: false,
    url: null,
    error: "The web client gateway is not initialized.",
  });

  return {
    getWebClientStatus(): WebClientStatus {
      return getTarget()?.getStatus() ?? unavailableStatus();
    },

    setWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
      const target = getTarget();
      return target ? target.setEnabled(enabled) : Promise.resolve(unavailableStatus());
    },

    getGatewayTokenSettings(): Promise<GatewayTokenSettings> {
      const target = getTarget();
      if (!target) return Promise.reject(new Error("The web client gateway is not initialized."));
      return target.getTokenSettings();
    },

    setGatewayToken(token: string): Promise<GatewayTokenSettings> {
      const target = getTarget();
      if (!target) return Promise.reject(new Error("The web client gateway is not initialized."));
      return target.setToken(token);
    },
  };
}

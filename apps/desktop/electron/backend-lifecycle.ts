import type { BackendHttpClient, BackendProcess } from "./backend-process.js";

type WebClientBackend = Pick<
  BackendHttpClient,
  "getWebClientStatus" | "setWebClientEnabled" | "resetWebClientServe" | "getTokenSettings" | "setToken"
>;

export function createBackendWebClientControls(getBackend: () => WebClientBackend | null) {
  const requireBackend = (): WebClientBackend => {
    const backend = getBackend();
    if (!backend) throw new Error("Backend is not initialized");
    return backend;
  };

  return {
    getWebClientStatus: () => requireBackend().getWebClientStatus(),
    setWebClientEnabled: (enabled: boolean) => requireBackend().setWebClientEnabled(enabled),
    resetWebClientServe: () => requireBackend().resetWebClientServe(),
    getGatewayTokenSettings: () => requireBackend().getTokenSettings(),
    setGatewayToken: (token: string) => requireBackend().setToken(token),
  };
}

export function registerBackendShutdown(
  app: Pick<Electron.App, "on">,
  backendProcess: Pick<BackendProcess, "stop">,
): void {
  app.on("before-quit", () => {
    backendProcess.stop();
  });
}

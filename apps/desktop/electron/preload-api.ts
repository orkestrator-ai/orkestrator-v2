import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";

type EventCallback<T> = (payload: T) => void;

export type IpcRendererLike = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, listener: (event: unknown, name: string, payload: unknown) => void): void;
};

export function createOrkestratorElectronApi(ipcRenderer: IpcRendererLike) {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();

  ipcRenderer.on("orkestrator:event", (_event, name: string, payload: unknown) => {
    const callbacks = listeners.get(name);
    if (!callbacks) return;
    for (const callback of callbacks) callback(payload);
  });

  return {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      return ipcRenderer.invoke("orkestrator:invoke", command, args ?? {});
    },

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      return () => {
        callbackSet.delete(callback as EventCallback<unknown>);
        if (callbackSet.size === 0) listeners.delete(event);
      };
    },

    clipboard: {
      readText(): Promise<string> {
        return ipcRenderer.invoke("orkestrator:clipboard:read-text");
      },
      writeText(text: string): Promise<void> {
        return ipcRenderer.invoke("orkestrator:clipboard:write-text", text);
      },
      readImage(): Promise<{ width: number; height: number; dataUrl: string } | null> {
        return ipcRenderer.invoke("orkestrator:clipboard:read-image");
      },
      writeImage(dataUrl: string): Promise<void> {
        return ipcRenderer.invoke("orkestrator:clipboard:write-image", dataUrl);
      },
    },

    dialog: {
      open(options?: { directory?: boolean; multiple?: boolean; title?: string; defaultPath?: string }): Promise<string | string[] | null> {
        return ipcRenderer.invoke("orkestrator:dialog:open", options ?? {});
      },
    },

    webClient: {
      getStatus(): Promise<WebClientStatus> {
        return ipcRenderer.invoke("orkestrator:web-client:get-status");
      },
      setEnabled(enabled: boolean): Promise<WebClientStatus> {
        return ipcRenderer.invoke("orkestrator:web-client:set-enabled", enabled);
      },
      getTokenSettings(): Promise<GatewayTokenSettings> {
        return ipcRenderer.invoke("orkestrator:web-client:get-token-settings");
      },
      setToken(token: string): Promise<GatewayTokenSettings> {
        return ipcRenderer.invoke("orkestrator:web-client:set-token", token);
      },
    },

    process: {
      exit(code?: number): Promise<void> {
        return ipcRenderer.invoke("orkestrator:process:exit", code);
      },
    },

    window: {
      startDragging(): Promise<void> {
        return ipcRenderer.invoke("orkestrator:window:start-dragging");
      },
    },
  };
}

export type OrkestratorElectronApi = ReturnType<typeof createOrkestratorElectronApi>;

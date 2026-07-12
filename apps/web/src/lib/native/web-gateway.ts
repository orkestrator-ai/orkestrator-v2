import type { GatewayTokenSettings, WebClientStatus } from "@/types";

const GATEWAY_PREFIX = "/__orkestrator";

type EventCallback<T> = (payload: T) => void;
type GatewayWindow = Pick<Window, "location" | "orkestrator" | "orkestratorGateway">;

export function createBrowserGatewayApi() {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  let eventSource: EventSource | null = null;

  const ensureEventSource = () => {
    if (eventSource) return;
    eventSource = new EventSource(`${GATEWAY_PREFIX}/events`, { withCredentials: true });
    eventSource.onmessage = (message) => {
      const parsed = JSON.parse(message.data) as { event?: unknown; payload?: unknown };
      if (typeof parsed.event !== "string") return;
      const callbacks = listeners.get(parsed.event);
      if (!callbacks) return;
      for (const callback of callbacks) callback(parsed.payload);
    };
    eventSource.onerror = () => {
      console.warn("[RemoteGateway] Event stream disconnected");
    };
  };

  const closeEventSourceIfIdle = () => {
    if (listeners.size > 0) return;
    eventSource?.close();
    eventSource = null;
  };

  return {
    async invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      const response = await fetch(`${GATEWAY_PREFIX}/invoke`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args: args ?? {} }),
      });
      const payload = await response.json().catch(() => ({})) as { result?: T; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Gateway command failed with HTTP ${response.status}`);
      }
      return payload.result as T;
    },

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      ensureEventSource();
      return () => {
        callbackSet.delete(callback as EventCallback<unknown>);
        if (callbackSet.size === 0) listeners.delete(event);
        closeEventSourceIfIdle();
      };
    },

    clipboard: {
      readText(): Promise<string> {
        return navigator.clipboard?.readText() ?? Promise.resolve("");
      },
      writeText(text: string): Promise<void> {
        return navigator.clipboard?.writeText(text) ?? Promise.resolve();
      },
      readImage(): Promise<{ width: number; height: number; dataUrl: string } | null> {
        return Promise.resolve(null);
      },
      writeImage(_dataUrl: string): Promise<void> {
        return Promise.resolve();
      },
    },

    dialog: {
      open(): Promise<string | string[] | null> {
        return Promise.resolve(null);
      },
    },

    webClient: {
      getStatus(): Promise<WebClientStatus> {
        return Promise.resolve({
          enabled: true,
          running: true,
          url: `${window.location.origin}/`,
          error: null,
        });
      },
      setEnabled(): Promise<WebClientStatus> {
        return Promise.reject(new Error("Web client controls are only available in the desktop app"));
      },
      async getTokenSettings(): Promise<GatewayTokenSettings> {
        const response = await fetch(`${GATEWAY_PREFIX}/gateway-settings`, {
          credentials: "same-origin",
        });
        const payload = await response.json().catch(() => ({})) as GatewayTokenSettings & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? `Gateway settings request failed with HTTP ${response.status}`);
        }
        return payload;
      },
      async setToken(token: string): Promise<GatewayTokenSettings> {
        const response = await fetch(`${GATEWAY_PREFIX}/gateway-settings`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const payload = await response.json().catch(() => ({})) as GatewayTokenSettings & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? `Gateway settings request failed with HTTP ${response.status}`);
        }
        return payload;
      },
    },

    process: {
      exit(): Promise<void> {
        window.close();
        return Promise.resolve();
      },
    },

    window: {
      startDragging(): Promise<void> {
        return Promise.resolve();
      },
    },
  };
}

export function installBrowserGatewayApi(targetWindow: GatewayWindow = window): void {
  if (!targetWindow.orkestrator && targetWindow.location.protocol.startsWith("http")) {
    targetWindow.orkestratorGateway = { enabled: true };
    targetWindow.orkestrator = createBrowserGatewayApi();
  }
}

if (typeof window !== "undefined") {
  installBrowserGatewayApi();
}

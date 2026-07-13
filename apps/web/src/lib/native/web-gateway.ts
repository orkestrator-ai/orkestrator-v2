import type { GatewayTokenSettings, WebClientStatus } from "@/types";
import { getGatewayBaseUrl, resolveGatewayApiUrl } from "@/lib/gateway-url";
import {
  configureDirectGatewayTransport,
  updateDirectGatewayToken,
} from "@/lib/native/gateway-auth-transport";

const GATEWAY_PREFIX = "/__orkestrator";
const EVENT_RECONNECT_DELAY_MS = 2_000;

type EventCallback<T> = (payload: T) => void;
type GatewayWindow = Pick<Window, "location" | "orkestrator" | "orkestratorGateway">;

export interface BrowserGatewayOptions {
  baseUrl?: string;
  token?: string;
  replaceExisting?: boolean;
  onTokenChanged?: (token: string) => void;
  eventReconnectDelayMs?: number;
}

function normalizedBaseUrl(value: string | undefined): string | undefined {
  return value?.trim().replace(/\/+$/, "") || undefined;
}

function parseEventBlock(block: string): string | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data || null;
}

export function createBrowserGatewayApi(options: BrowserGatewayOptions = {}) {
  const listeners = new Map<string, Set<EventCallback<unknown>>>();
  let eventSource: EventSource | null = null;
  let streamAbortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let bearerToken = options.token?.trim() || undefined;

  const requestHeaders = (headers?: Record<string, string>): Record<string, string> | undefined => {
    const result = { ...headers };
    if (bearerToken) result.authorization = `Bearer ${bearerToken}`;
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const credentials = bearerToken || options.baseUrl ? "omit" as const : "same-origin" as const;

  const dispatchMessage = (data: string) => {
    let parsed: { event?: unknown; payload?: unknown };
    try {
      parsed = JSON.parse(data) as { event?: unknown; payload?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.event !== "string") return;
    const callbacks = listeners.get(parsed.event);
    if (!callbacks) return;
    for (const callback of callbacks) callback(parsed.payload);
  };

  const scheduleReconnect = () => {
    if (listeners.size === 0 || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureEventStream();
    }, options.eventReconnectDelayMs ?? EVENT_RECONNECT_DELAY_MS);
  };

  const connectFetchEventStream = () => {
    if (streamAbortController || listeners.size === 0) return;
    const controller = new AbortController();
    streamAbortController = controller;

    void (async () => {
      try {
        const response = await fetch(resolveGatewayApiUrl(`${GATEWAY_PREFIX}/events`), {
          credentials,
          headers: requestHeaders(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`Gateway event stream failed with HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let boundary = /\r?\n\r?\n/.exec(buffer);
          while (boundary) {
            const data = parseEventBlock(buffer.slice(0, boundary.index));
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (data) dispatchMessage(data);
            boundary = /\r?\n\r?\n/.exec(buffer);
          }
          if (done) break;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("[RemoteGateway] Event stream disconnected", error);
        }
      } finally {
        if (streamAbortController === controller) streamAbortController = null;
        if (!controller.signal.aborted) scheduleReconnect();
      }
    })();
  };

  const ensureEventStream = () => {
    if (eventSource || streamAbortController || listeners.size === 0) return;
    if (bearerToken || options.baseUrl) {
      connectFetchEventStream();
      return;
    }

    eventSource = new EventSource(resolveGatewayApiUrl(`${GATEWAY_PREFIX}/events`), {
      withCredentials: true,
    });
    eventSource.onmessage = (message) => dispatchMessage(message.data);
    eventSource.onerror = () => {
      console.warn("[RemoteGateway] Event stream disconnected");
    };
  };

  const closeEventStreamIfIdle = () => {
    if (listeners.size > 0) return;
    eventSource?.close();
    eventSource = null;
    streamAbortController?.abort();
    streamAbortController = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const readGatewayResponse = async <T>(response: Response, fallback: string): Promise<T> => {
    const payload = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `${fallback} with HTTP ${response.status}`);
    return payload;
  };

  return {
    async invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
      const response = await fetch(resolveGatewayApiUrl(`${GATEWAY_PREFIX}/invoke`), {
        method: "POST",
        credentials,
        headers: requestHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ command, args: args ?? {} }),
      });
      const payload = await readGatewayResponse<{ result?: T }>(response, "Gateway command failed");
      return payload.result as T;
    },

    listen<T = unknown>(event: string, callback: EventCallback<T>): () => void {
      const callbackSet = listeners.get(event) ?? new Set<EventCallback<unknown>>();
      listeners.set(event, callbackSet);
      callbackSet.add(callback as EventCallback<unknown>);
      ensureEventStream();
      return () => {
        callbackSet.delete(callback as EventCallback<unknown>);
        if (callbackSet.size === 0) listeners.delete(event);
        closeEventStreamIfIdle();
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
          url: `${getGatewayBaseUrl()}/`,
          error: null,
        });
      },
      setEnabled(): Promise<WebClientStatus> {
        return Promise.reject(new Error("Web client controls are only available in the desktop app"));
      },
      async getTokenSettings(): Promise<GatewayTokenSettings> {
        const response = await fetch(resolveGatewayApiUrl(`${GATEWAY_PREFIX}/gateway-settings`), {
          credentials,
          headers: requestHeaders(),
        });
        return readGatewayResponse<GatewayTokenSettings>(response, "Gateway settings request failed");
      },
      async setToken(token: string): Promise<GatewayTokenSettings> {
        const response = await fetch(resolveGatewayApiUrl(`${GATEWAY_PREFIX}/gateway-settings`), {
          method: "PUT",
          credentials,
          headers: requestHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ token }),
        });
        const settings = await readGatewayResponse<GatewayTokenSettings>(
          response,
          "Gateway settings request failed",
        );
        bearerToken = settings.token;
        updateDirectGatewayToken(settings.token);
        options.onTokenChanged?.(settings.token);
        return settings;
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

export function installBrowserGatewayApi(
  targetWindow: GatewayWindow = window,
  options: BrowserGatewayOptions = {},
): void {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  if (
    (!targetWindow.orkestrator || options.replaceExisting)
    && targetWindow.location.protocol.startsWith("http")
  ) {
    if (baseUrl && options.token) {
      configureDirectGatewayTransport(baseUrl, options.token.trim());
    }
    targetWindow.orkestratorGateway = { enabled: true, ...(baseUrl ? { baseUrl } : {}) };
    targetWindow.orkestrator = createBrowserGatewayApi({ ...options, baseUrl });
  }
}

if (typeof window !== "undefined") {
  installBrowserGatewayApi();
}

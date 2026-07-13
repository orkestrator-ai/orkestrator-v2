interface DirectGatewayAuth {
  baseUrl: string;
  token: string;
}

let directGatewayAuth: DirectGatewayAuth | null = null;
let originalFetch: typeof globalThis.fetch | null = null;
let originalEventSource: typeof globalThis.EventSource | null = null;

function inputUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof Request) return new URL(input.url);
    return new URL(String(input), window.location.href);
  } catch {
    return null;
  }
}

function isGatewayRequest(input: RequestInfo | URL): boolean {
  if (!directGatewayAuth) return false;
  const url = inputUrl(input);
  if (!url) return false;
  return url.origin === directGatewayAuth.baseUrl
    && url.pathname.startsWith("/__orkestrator/");
}

function authenticatedInit(input: RequestInfo | URL, init?: RequestInit): RequestInit {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.set("authorization", `Bearer ${directGatewayAuth?.token ?? ""}`);
  return { ...init, credentials: "omit", headers };
}

type Listener = EventListenerOrEventListenerObject;

class FetchEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = FetchEventSource.CONNECTING;
  onopen: ((this: EventSource, event: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, event: Event) => unknown) | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly controller = new AbortController();

  constructor(url: string | URL) {
    this.url = String(url);
    void this.connect();
  }

  addEventListener(type: string, callback: Listener | null): void {
    if (!callback) return;
    const callbacks = this.listeners.get(type) ?? new Set<Listener>();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type: string, callback: Listener | null): void {
    if (!callback) return;
    this.listeners.get(type)?.delete(callback);
  }

  dispatchEvent(event: Event): boolean {
    for (const callback of this.listeners.get(event.type) ?? []) {
      if (typeof callback === "function") callback.call(this, event);
      else callback.handleEvent(event);
    }
    if (event.type === "open") this.onopen?.call(this as unknown as EventSource, event);
    if (event.type === "message") {
      this.onmessage?.call(this as unknown as EventSource, event as MessageEvent);
    }
    if (event.type === "error") this.onerror?.call(this as unknown as EventSource, event);
    return !event.defaultPrevented;
  }

  close(): void {
    this.readyState = FetchEventSource.CLOSED;
    this.controller.abort();
  }

  private dispatchBlock(block: string): void {
    let type = "message";
    let lastEventId = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trimStart();
      else if (line.startsWith("id:")) lastEventId = line.slice(3).trimStart();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    this.dispatchEvent(new MessageEvent(type, {
      data: data.join("\n"),
      lastEventId,
      origin: new URL(this.url).origin,
    }));
  }

  private async connect(): Promise<void> {
    try {
      const response = await fetch(this.url, { signal: this.controller.signal });
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed with HTTP ${response.status}`);
      }
      this.readyState = FetchEventSource.OPEN;
      this.dispatchEvent(new Event("open"));

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.controller.signal.aborted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          this.dispatchBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (!this.controller.signal.aborted) throw new Error("Event stream ended");
    } catch {
      if (!this.controller.signal.aborted) {
        this.readyState = FetchEventSource.CLOSED;
        this.dispatchEvent(new Event("error"));
      }
    }
  }
}

export function configureDirectGatewayTransport(baseUrl: string, token: string): void {
  directGatewayAuth = { baseUrl: baseUrl.replace(/\/$/, ""), token };

  if (!originalFetch) {
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (!isGatewayRequest(input)) return originalFetch!(input, init);
      return originalFetch!(input, authenticatedInit(input, init));
    }) as typeof globalThis.fetch;
  }

  if (!originalEventSource && typeof globalThis.EventSource !== "undefined") {
    originalEventSource = globalThis.EventSource;
    // Fetch supports the Authorization header required by the separately
    // hosted client; the native EventSource constructor does not. The fetch
    // wrapper above still scopes that credential to this gateway only.
    globalThis.EventSource = FetchEventSource as unknown as typeof globalThis.EventSource;
  }
}

export function updateDirectGatewayToken(token: string): void {
  if (directGatewayAuth) directGatewayAuth.token = token;
}

export function clearDirectGatewayTransport(): void {
  directGatewayAuth = null;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource;
    originalEventSource = null;
  }
}

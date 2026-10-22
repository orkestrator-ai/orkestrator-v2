import {
  GATEWAY_EVENT_CURSOR_PARAM,
  GatewayEventStreamState,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
  readSseStream,
} from "@orkestrator/protocol/gateway-event-stream";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";

/**
 * The command node's own subscription to one node's authoritative event
 * stream, over the link's verified route. Each attached command node keeps
 * its own subscription, so every one of them sees the node's changes.
 *
 * Only the named event prefixes are requested. The stream resumes from its
 * cursor on reconnect; a gap the node could not replay is reported as
 * `NATIVE_EVENT_STREAM_CONNECTED_EVENT` so the consumer re-reads.
 */

export interface NodeEventTransport {
  baseUrl: string;
  headers: Record<string, string>;
}

export class NodeEventStream {
  private abort: AbortController | null = null;
  private readonly state = new GatewayEventStreamState();

  constructor(
    private readonly options: {
      transport: () => NodeEventTransport | null;
      prefixes: readonly string[];
      onEvent: (event: string, payload: unknown) => void;
      onOpen?: () => void;
      fetchImpl?: typeof fetch;
    },
  ) {}

  get running(): boolean {
    return this.abort !== null;
  }

  start(): void {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.consume(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private async consume(signal: AbortSignal): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const backoff = new ReconnectBackoff({
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      healthyAfterMs: 30_000,
    });
    while (!signal.aborted) {
      const transport = this.options.transport();
      if (!transport) return;
      try {
        const url = new URL("/__orkestrator/events", transport.baseUrl);
        url.searchParams.set("events", this.options.prefixes.join(","));
        if (this.state.cursor) url.searchParams.set(GATEWAY_EVENT_CURSOR_PARAM, this.state.cursor);
        const response = await fetchImpl(url, {
          headers: { ...transport.headers, accept: "text/event-stream" },
          redirect: "manual",
          signal,
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`The node's event stream answered HTTP ${response.status}`);
        }
        backoff.connected();
        this.options.onOpen?.();
        await readSseStream(response.body, signal, (frame) => {
          if (!frame.data) return;
          const message = this.state.accept(frame.data, frame.id);
          if (message.kind === "event") this.options.onEvent(message.event, message.payload);
          else if (message.kind === "resync") {
            this.options.onEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
          }
        });
      } catch {
        if (signal.aborted) return;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, backoff.nextDelayMs());
        (timer as { unref?: () => void }).unref?.();
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}

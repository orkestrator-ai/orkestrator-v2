import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  clearDirectGatewayTransport,
  configureDirectGatewayTransport,
  updateDirectGatewayToken,
} from "./gateway-auth-transport";

const browserFetch = globalThis.fetch;
const browserEventSource = globalThis.EventSource;

afterEach(() => {
  clearDirectGatewayTransport();
  globalThis.fetch = browserFetch;
  globalThis.EventSource = browserEventSource;
});

describe("direct gateway authentication transport", () => {
  test("adds current bearer credentials only to the configured gateway namespace", async () => {
    const requests: Array<{ url: string; authorization: string | null; custom: string | null; credentials?: RequestCredentials }> = [];
    globalThis.fetch = mock(async (input, init) => {
      const request = input instanceof Request ? input : null;
      const headers = new Headers(init?.headers ?? request?.headers);
      requests.push({
        url: request?.url ?? String(input),
        authorization: headers.get("authorization"),
        custom: headers.get("x-custom"),
        credentials: init?.credentials,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    configureDirectGatewayTransport("https://workstation.example/", "first-token-123456");

    await fetch(new Request(
      "https://workstation.example/__orkestrator/status",
      { headers: { "x-custom": "request" } },
    ), { headers: { "x-custom": "override" }, credentials: "include" });
    await fetch("https://workstation.example/not-gateway");
    await fetch("https://other.example/__orkestrator/status");
    updateDirectGatewayToken("second-token-123456");
    await fetch("https://workstation.example/__orkestrator/status");

    expect(requests).toEqual([
      {
        url: "https://workstation.example/__orkestrator/status",
        authorization: "Bearer first-token-123456",
        custom: "override",
        credentials: "omit",
      },
      {
        url: "https://workstation.example/not-gateway",
        authorization: null,
        custom: null,
        credentials: undefined,
      },
      {
        url: "https://other.example/__orkestrator/status",
        authorization: null,
        custom: null,
        credentials: undefined,
      },
      {
        url: "https://workstation.example/__orkestrator/status",
        authorization: "Bearer second-token-123456",
        custom: null,
        credentials: "omit",
      },
    ]);
  });

  test("parses named CRLF events when delimiter bytes cross stream chunks", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: message.updated\r\ndata: first\r"));
        controller.enqueue(encoder.encode("\n\r"));
        controller.enqueue(encoder.encode("\nevent: message.updated\r\ndata: second\r\n\r\n"));
        controller.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;
    globalThis.EventSource = class {} as unknown as typeof EventSource;
    configureDirectGatewayTransport("https://workstation.example", "gateway-token-123456");

    const values: string[] = [];
    const source = new EventSource("https://workstation.example/__orkestrator/events");
    await new Promise<void>((resolve) => {
      source.addEventListener("message.updated", (event) => {
        values.push((event as MessageEvent).data as string);
        if (values.length === 2) resolve();
      });
    });
    source.close();

    expect(values).toEqual(["first", "second"]);
  });

  test("dispatches an error for rejected event streams and supports listener removal", async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    globalThis.EventSource = class {} as unknown as typeof EventSource;
    configureDirectGatewayTransport("https://workstation.example", "gateway-token-123456");

    const source = new EventSource("https://workstation.example/__orkestrator/events");
    const removed = mock(() => undefined);
    source.addEventListener("error", removed);
    source.removeEventListener("error", removed);
    await new Promise<void>((resolve) => {
      source.onerror = () => resolve();
    });

    expect(source.readyState).toBe(EventSource.CLOSED);
    expect(removed).not.toHaveBeenCalled();
  });
});

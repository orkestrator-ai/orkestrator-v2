import { configureLogger } from "@orkestrator/protocol/logger";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { describe, expect, mock, test } from "bun:test";
import {
  installRemoteGatewayRequestAuth,
  type RemoteGatewayRequestAuthOptions,
} from "../electron/remote-gateway-request-auth";

function installHarness(options: RemoteGatewayRequestAuthOptions = {}) {
  let beforeHeaders: ((details: any, callback: (response: any) => void) => void) | null = null;
  let receivedHeaders: ((details: any, callback: (response: any) => void) => void) | null = null;
  const webRequest = {
    onBeforeSendHeaders: mock((_filter: unknown, listener: typeof beforeHeaders) => {
      beforeHeaders = listener;
    }),
    onHeadersReceived: mock((_filter: unknown, listener: typeof receivedHeaders) => {
      receivedHeaders = listener;
    }),
  };
  installRemoteGatewayRequestAuth(
    webRequest as never,
    (url) =>
      url.startsWith("https://desk.example/__orkestrator/") ? "Bearer gateway-token" : null,
    options,
  );
  return {
    beforeHeaders: () => {
      if (!beforeHeaders) throw new Error("before-headers listener was not installed");
      return beforeHeaders;
    },
    receivedHeaders: () => {
      if (!receivedHeaders) throw new Error("headers-received listener was not installed");
      return receivedHeaders;
    },
  };
}

describe("remote gateway renderer request authentication", () => {
  test("presents the origin it is given in place of the hosted client's", () => {
    const harness = installHarness({ requestOrigin: () => "https://desk.example" });
    const callback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        requestHeaders: { Origin: "file://" },
        resourceType: "xhr",
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: "Bearer gateway-token",
        Origin: "https://desk.example",
      },
    });
  });

  test("replaces sensitive request headers and rewrites CORS only for authorized gateway URLs", () => {
    const harness = installHarness();

    const requestCallback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        requestHeaders: {
          authorization: "Bearer stale",
          Origin: "file://",
          Accept: "application/json",
        },
      },
      requestCallback,
    );
    expect(requestCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "application/json",
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });

    const responseCallback = mock(() => undefined);
    harness.receivedHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        responseHeaders: {
          "Access-Control-Allow-Origin": ["https://orkestrator.dev"],
          Server: ["test"],
        },
      },
      responseCallback,
    );
    expect(responseCallback).toHaveBeenCalledWith({
      responseHeaders: { Server: ["test"], "Access-Control-Allow-Origin": ["*"] },
    });

    const untouched = mock(() => undefined);
    harness.beforeHeaders()(
      { url: "https://example.com/", requestHeaders: { Origin: "file://" } },
      untouched,
    );
    expect(untouched).toHaveBeenCalledWith({ requestHeaders: { Origin: "file://" } });
  });

  test("strips credentials from a nested frame's request, even through a frame-parent cycle", () => {
    const harness = installHarness();
    const frameA: { url: string; parent: unknown } = { url: "https://app.example/a", parent: null };
    const frameB = { url: "https://app.example/b", parent: frameA };
    frameA.parent = frameB;

    const callback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        resourceType: "xhr",
        referrer: "",
        frame: frameA,
        requestHeaders: { Authorization: "Bearer ambient", Accept: "application/json" },
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({ requestHeaders: { Accept: "application/json" } });
  });

  test("never authorizes a subframe navigation, even one the trusted renderer creates", () => {
    const harness = installHarness();
    const callback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        resourceType: "subFrame",
        referrer: "file:///Applications/Orkestrator/index.html",
        frame: {
          url: "",
          parent: { url: "file:///Applications/Orkestrator/index.html", parent: null },
        },
        requestHeaders: { Authorization: "Bearer ambient", Cookie: "gateway=ambient" },
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({ requestHeaders: {} });
  });
});

test("a throwing credential lookup still answers both hooks, with no credential (0622)", () => {
  type Listener = (details: any, callback: (response: any) => void) => void;
  const listeners: Partial<Record<"before" | "received", Listener>> = {};
  const webRequest = {
    onBeforeSendHeaders: (_filter: unknown, listener: Listener) =>
      void (listeners.before = listener),
    onHeadersReceived: (_filter: unknown, listener: Listener) =>
      void (listeners.received = listener),
  };
  const capture = captureLogs();
  try {
    configureLogger({ areaLevels: { gateway: "debug" } });
    // A closed window's session finishing a request after its scope was released.
    installRemoteGatewayRequestAuth(webRequest as never, () => {
      throw new Error("The requesting window is no longer available.");
    });
    const before = mock((_response: unknown) => undefined);
    listeners.before!(
      {
        url: "https://desk.example/__orkestrator/invoke",
        resourceType: "xhr",
        requestHeaders: { Authorization: "Bearer stale", Cookie: "a=b", Accept: "*/*" },
      },
      before,
    );
    expect(before).toHaveBeenCalledWith({ requestHeaders: { Accept: "*/*" } });
    const received = mock((_response: unknown) => undefined);
    const responseHeaders = { "Access-Control-Allow-Origin": ["https://desk.example"] };
    listeners.received!(
      { url: "https://desk.example/__orkestrator/invoke", resourceType: "xhr", responseHeaders },
      received,
    );
    expect(received).toHaveBeenCalledWith({ responseHeaders });
    // The shared helper names the listener; neither line holds the URL or the error.
    expect(capture.outputs.map(({ method, line }) => [method, line])).toEqual([
      [
        "warn",
        "[desktop.webrequest] listener.failed-closed scope=gateway-request-auth.before-send-headers kind=Error",
      ],
      ["debug", "[gateway] request-auth.fallback phase=request"],
      [
        "warn",
        "[desktop.webrequest] listener.failed-closed scope=gateway-request-auth.headers-received kind=Error",
      ],
      ["debug", "[gateway] request-auth.fallback phase=response"],
    ]);
  } finally {
    capture.restore();
  }
});

import { describe, expect, mock, test } from "bun:test";
import { installRemoteGatewayRequestAuth } from "../../../apps/desktop/electron/remote-gateway-request-auth";

describe("remote gateway renderer request authentication", () => {
  test("replaces sensitive request headers and rewrites CORS only for authorized gateway URLs", () => {
    let beforeHeaders: ((details: any, callback: (response: any) => void) => void) | null = null;
    let receivedHeaders: ((details: any, callback: (response: any) => void) => void) | null = null;
    const webRequest = {
      onBeforeSendHeaders: mock((_filter: unknown, listener: typeof beforeHeaders) => { beforeHeaders = listener; }),
      onHeadersReceived: mock((_filter: unknown, listener: typeof receivedHeaders) => { receivedHeaders = listener; }),
    };
    installRemoteGatewayRequestAuth(
      webRequest as never,
      (url) => url.startsWith("https://desk.example/__orkestrator/") ? "Bearer gateway-token" : null,
    );

    const requestCallback = mock(() => undefined);
    beforeHeaders?.({
      url: "https://desk.example/__orkestrator/invoke",
      requestHeaders: { authorization: "Bearer stale", Origin: "file://", Accept: "application/json" },
    }, requestCallback);
    expect(requestCallback).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "application/json",
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });

    const responseCallback = mock(() => undefined);
    receivedHeaders?.({
      url: "https://desk.example/__orkestrator/invoke",
      responseHeaders: { "Access-Control-Allow-Origin": ["https://orkestrator.dev"], Server: ["test"] },
    }, responseCallback);
    expect(responseCallback).toHaveBeenCalledWith({
      responseHeaders: { Server: ["test"], "Access-Control-Allow-Origin": ["*"] },
    });

    const untouched = mock(() => undefined);
    beforeHeaders?.({ url: "https://example.com/", requestHeaders: { Origin: "file://" } }, untouched);
    expect(untouched).toHaveBeenCalledWith({ requestHeaders: { Origin: "file://" } });
  });
});

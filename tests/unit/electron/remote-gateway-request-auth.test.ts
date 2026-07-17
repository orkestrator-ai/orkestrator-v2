import { describe, expect, mock, test } from "bun:test";
import { installRemoteGatewayRequestAuth } from "../../../apps/desktop/electron/remote-gateway-request-auth";

function installHarness() {
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
  test("replaces sensitive request headers and rewrites CORS only for authorized gateway URLs", () => {
    const harness = installHarness();

    const requestCallback = mock(() => undefined);
    harness.beforeHeaders()({
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
    harness.receivedHeaders()({
      url: "https://desk.example/__orkestrator/invoke",
      responseHeaders: { "Access-Control-Allow-Origin": ["https://orkestrator.dev"], Server: ["test"] },
    }, responseCallback);
    expect(responseCallback).toHaveBeenCalledWith({
      responseHeaders: { Server: ["test"], "Access-Control-Allow-Origin": ["*"] },
    });

    const untouched = mock(() => undefined);
    harness.beforeHeaders()({ url: "https://example.com/", requestHeaders: { Origin: "file://" } }, untouched);
    expect(untouched).toHaveBeenCalledWith({ requestHeaders: { Origin: "file://" } });
  });

  test("confines preview frames to their exact loopback namespace", () => {
    const harness = installHarness();
    const previewFrame = {
      url: "https://desk.example/__orkestrator/browser/loopback/3000/app",
      parent: null,
    };

    const samePreview = mock(() => undefined);
    harness.beforeHeaders()({
      url: "https://desk.example/__orkestrator/browser/loopback/3000/api/status",
      resourceType: "xhr",
      referrer: previewFrame.url,
      frame: previewFrame,
      requestHeaders: { Accept: "application/json" },
    }, samePreview);
    expect(samePreview).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "application/json",
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });

    for (const url of [
      "https://desk.example/__orkestrator/browser/loopback/4000/private",
      "https://desk.example/__orkestrator/gateway-settings",
      "https://desk.example/__orkestrator/invoke",
    ]) {
      const blocked = mock(() => undefined);
      harness.beforeHeaders()({
        url,
        resourceType: "xhr",
        referrer: previewFrame.url,
        frame: previewFrame,
        requestHeaders: {
          Authorization: "Bearer supplied",
          Cookie: "orkestrator_gateway_auth=ambient",
          "Proxy-Authorization": "Basic ambient",
          Accept: "application/json",
        },
      }, blocked);
      expect(blocked).toHaveBeenCalledWith({ requestHeaders: { Accept: "application/json" } });
    }
  });

  test("detects nested preview frames and leaves blocked responses without permissive CORS", () => {
    const harness = installHarness();
    const previewFrame = {
      url: "https://desk.example/__orkestrator/browser/loopback/3000/",
      parent: null,
    };
    const nestedFrame = { url: "about:blank", parent: previewFrame };
    const requestCallback = mock(() => undefined);
    harness.beforeHeaders()({
      url: "https://desk.example/__orkestrator/gateway-settings",
      resourceType: "xhr",
      referrer: "",
      frame: nestedFrame,
      requestHeaders: { Cookie: "orkestrator_gateway_auth=ambient" },
    }, requestCallback);
    expect(requestCallback).toHaveBeenCalledWith({ requestHeaders: {} });

    const responseCallback = mock(() => undefined);
    harness.receivedHeaders()({
      url: "https://desk.example/__orkestrator/gateway-settings",
      resourceType: "xhr",
      referrer: previewFrame.url,
      frame: null,
      responseHeaders: { Server: ["test"] },
    }, responseCallback);
    expect(responseCallback).toHaveBeenCalledWith({ responseHeaders: { Server: ["test"] } });

    const navigatedFrameCallback = mock(() => undefined);
    harness.beforeHeaders()({
      url: "https://desk.example/__orkestrator/gateway-settings",
      resourceType: "xhr",
      referrer: "",
      frame: {
        url: "https://desk.example/__orkestrator/gateway-settings",
        parent: { url: "file:///Applications/Orkestrator/index.html", parent: null },
      },
      requestHeaders: { Authorization: "Bearer ambient", Cookie: "gateway=ambient" },
    }, navigatedFrameCallback);
    expect(navigatedFrameCallback).toHaveBeenCalledWith({ requestHeaders: {} });
  });

  test("treats malformed referrers as non-preview initiators", () => {
    const harness = installHarness();

    const mainRenderer = mock(() => undefined);
    harness.beforeHeaders()({
      url: "https://desk.example/__orkestrator/invoke",
      resourceType: "xhr",
      referrer: "::not-a-url::",
      frame: null,
      requestHeaders: { Accept: "application/json" },
    }, mainRenderer);
    expect(mainRenderer).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "application/json",
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });

    const responseCallback = mock(() => undefined);
    harness.receivedHeaders()({
      url: "https://desk.example/__orkestrator/invoke",
      resourceType: "xhr",
      referrer: "::not-a-url::",
      frame: null,
      responseHeaders: { "Access-Control-Allow-Origin": ["https://orkestrator.dev"] },
    }, responseCallback);
    expect(responseCallback).toHaveBeenCalledWith({
      responseHeaders: { "Access-Control-Allow-Origin": ["*"] },
    });
  });

  test("terminates on frame-parent cycles and still strips subframe credentials", () => {
    const harness = installHarness();
    const frameA: { url: string; parent: unknown } = { url: "https://app.example/a", parent: null };
    const frameB = { url: "https://app.example/b", parent: frameA };
    frameA.parent = frameB;

    const callback = mock(() => undefined);
    harness.beforeHeaders()({
      url: "https://desk.example/__orkestrator/invoke",
      resourceType: "xhr",
      referrer: "",
      frame: frameA,
      requestHeaders: { Authorization: "Bearer ambient", Accept: "application/json" },
    }, callback);
    expect(callback).toHaveBeenCalledWith({ requestHeaders: { Accept: "application/json" } });
  });

  test("authorizes a newly created preview subframe from the trusted renderer", () => {
    const harness = installHarness();
    const callback = mock(() => undefined);
    harness.beforeHeaders()({
      url: "https://desk.example/__orkestrator/browser/loopback/3000/",
      resourceType: "subFrame",
      referrer: "file:///Applications/Orkestrator/index.html",
      frame: { url: "", parent: { url: "file:///Applications/Orkestrator/index.html", parent: null } },
      requestHeaders: {},
    }, callback);
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });
  });
});

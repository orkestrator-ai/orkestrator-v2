import { describe, expect, mock, test } from "bun:test";
import {
  createRealmRequestAuthInstaller,
  installRemoteGatewayRequestAuth,
  type RemoteGatewayRequestAuthOptions,
} from "../electron/remote-gateway-request-auth";

/** A dedicated preview session whose view 7 was opened on `viewUrl`. */
function previewOnly(viewUrl: string): RemoteGatewayRequestAuthOptions {
  return {
    browserPreviewOnly: true,
    previewViewUrl: (webContentsId) => (webContentsId === 7 ? viewUrl : undefined),
  };
}

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

  test("confines preview frames to their exact loopback namespace", () => {
    const harness = installHarness();
    const previewFrame = {
      url: "https://desk.example/__orkestrator/browser/loopback/3000/app",
      parent: null,
    };

    const samePreview = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/api/status",
        resourceType: "xhr",
        referrer: previewFrame.url,
        frame: previewFrame,
        requestHeaders: { Accept: "application/json" },
      },
      samePreview,
    );
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
      harness.beforeHeaders()(
        {
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
        },
        blocked,
      );
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
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/gateway-settings",
        resourceType: "xhr",
        referrer: "",
        frame: nestedFrame,
        requestHeaders: { Cookie: "orkestrator_gateway_auth=ambient" },
      },
      requestCallback,
    );
    expect(requestCallback).toHaveBeenCalledWith({ requestHeaders: {} });

    const responseCallback = mock(() => undefined);
    harness.receivedHeaders()(
      {
        url: "https://desk.example/__orkestrator/gateway-settings",
        resourceType: "xhr",
        referrer: previewFrame.url,
        frame: null,
        responseHeaders: { Server: ["test"] },
      },
      responseCallback,
    );
    expect(responseCallback).toHaveBeenCalledWith({ responseHeaders: { Server: ["test"] } });

    const navigatedFrameCallback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/gateway-settings",
        resourceType: "xhr",
        referrer: "",
        frame: {
          url: "https://desk.example/__orkestrator/gateway-settings",
          parent: { url: "file:///Applications/Orkestrator/index.html", parent: null },
        },
        requestHeaders: { Authorization: "Bearer ambient", Cookie: "gateway=ambient" },
      },
      navigatedFrameCallback,
    );
    expect(navigatedFrameCallback).toHaveBeenCalledWith({ requestHeaders: {} });
  });

  test("treats malformed referrers as non-preview initiators", () => {
    const harness = installHarness();

    const mainRenderer = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        resourceType: "xhr",
        referrer: "::not-a-url::",
        frame: null,
        requestHeaders: { Accept: "application/json" },
      },
      mainRenderer,
    );
    expect(mainRenderer).toHaveBeenCalledWith({
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
        resourceType: "xhr",
        referrer: "::not-a-url::",
        frame: null,
        responseHeaders: { "Access-Control-Allow-Origin": ["https://orkestrator.dev"] },
      },
      responseCallback,
    );
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

  test("authorizes a newly created preview subframe from the trusted renderer", () => {
    const harness = installHarness();
    const callback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/",
        resourceType: "subFrame",
        referrer: "file:///Applications/Orkestrator/index.html",
        frame: {
          url: "",
          parent: { url: "file:///Applications/Orkestrator/index.html", parent: null },
        },
        requestHeaders: {},
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });
  });

  test("limits a dedicated preview session to preview namespaces", () => {
    const harness = installHarness(
      previewOnly("https://desk.example/__orkestrator/browser/loopback/3000/"),
    );
    const preview = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/",
        resourceType: "mainFrame",
        webContentsId: 7,
        frame: null,
        requestHeaders: {},
      },
      preview,
    );
    expect(preview).toHaveBeenCalledWith({
      requestHeaders: {
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });

    const privileged = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        resourceType: "mainFrame",
        webContentsId: 7,
        frame: null,
        requestHeaders: { Authorization: "Bearer ambient", Cookie: "gateway=ambient" },
      },
      privileged,
    );
    expect(privileged).toHaveBeenCalledWith({ requestHeaders: {} });
  });

  test("authorizes a dedicated preview view only inside the namespace it was opened on (M2)", () => {
    const harness = installHarness(
      previewOnly("https://desk.example/__orkestrator/browser/loopback/3000/app"),
    );
    const previewFrame = {
      url: "https://desk.example/__orkestrator/browser/loopback/3000/app",
      parent: null,
    };

    // The page navigating its own main frame to another port gets no credential.
    const crossPort = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/4000/next",
        resourceType: "mainFrame",
        webContentsId: 7,
        referrer: previewFrame.url,
        frame: previewFrame,
        requestHeaders: { Authorization: "Bearer stale", Accept: "text/html" },
      },
      crossPort,
    );
    expect(crossPort).toHaveBeenCalledWith({ requestHeaders: { Accept: "text/html" } });

    const samePort = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/next",
        resourceType: "mainFrame",
        webContentsId: 7,
        referrer: previewFrame.url,
        frame: previewFrame,
        requestHeaders: { Accept: "text/html" },
      },
      samePort,
    );
    expect(samePort).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "text/html",
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });

    const sameScopeXhr = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/api",
        resourceType: "xhr",
        webContentsId: 7,
        referrer: previewFrame.url,
        frame: previewFrame,
        requestHeaders: { Accept: "application/json" },
      },
      sameScopeXhr,
    );
    expect(sameScopeXhr).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "application/json",
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
      },
    });

    const crossScopeXhr = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/4000/api",
        resourceType: "xhr",
        webContentsId: 7,
        referrer: previewFrame.url,
        frame: previewFrame,
        requestHeaders: {
          Authorization: "Bearer ambient",
          Cookie: "gateway=ambient",
          Accept: "application/json",
        },
      },
      crossScopeXhr,
    );
    expect(crossScopeXhr).toHaveBeenCalledWith({ requestHeaders: { Accept: "application/json" } });

    // A view the manager does not know (or a request with no view) gets nothing.
    for (const webContentsId of [8, undefined]) {
      const unknownView = mock(() => undefined);
      harness.beforeHeaders()(
        {
          url: "https://desk.example/__orkestrator/browser/loopback/3000/",
          resourceType: "mainFrame",
          webContentsId,
          frame: null,
          requestHeaders: {},
        },
        unknownView,
      );
      expect(unknownView).toHaveBeenCalledWith({ requestHeaders: {} });
    }
  });

  test("names the view's environment on the preview requests it authorizes (M2)", () => {
    const harness = installHarness({
      ...previewOnly("https://desk.example/__orkestrator/browser/loopback/3000/app"),
      previewViewEnvironment: (webContentsId) => (webContentsId === 7 ? "env-a" : null),
    });
    const previewFrame = {
      url: "https://desk.example/__orkestrator/browser/loopback/3000/app",
      parent: null,
    };

    // A page cannot pick the environment: its own copy is replaced.
    const subresource = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/api",
        resourceType: "xhr",
        webContentsId: 7,
        frame: previewFrame,
        requestHeaders: { "X-Orkestrator-Preview-Environment": "env-b", Accept: "*/*" },
      },
      subresource,
    );
    expect(subresource).toHaveBeenCalledWith({
      requestHeaders: {
        Accept: "*/*",
        Authorization: "Bearer gateway-token",
        Origin: "https://orkestrator.dev",
        "x-orkestrator-preview-environment": "env-a",
      },
    });

    // An unauthorized request carries neither the credential nor any environment.
    const crossPort = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/4000/api",
        resourceType: "xhr",
        webContentsId: 7,
        frame: previewFrame,
        requestHeaders: { "x-orkestrator-preview-environment": "env-b" },
      },
      crossPort,
    );
    expect(crossPort).toHaveBeenCalledWith({ requestHeaders: {} });

    // Nor does a request to a host that is not the gateway.
    const external = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://example.com/",
        resourceType: "xhr",
        webContentsId: 7,
        frame: previewFrame,
        requestHeaders: { "x-orkestrator-preview-environment": "env-b", Accept: "*/*" },
      },
      external,
    );
    expect(external).toHaveBeenCalledWith({ requestHeaders: { Accept: "*/*" } });
  });

  test("a preview view attached without an environment names none", () => {
    const harness = installHarness({
      ...previewOnly("https://desk.example/__orkestrator/browser/loopback/3000/"),
      previewViewEnvironment: () => null,
    });
    const callback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/",
        resourceType: "mainFrame",
        webContentsId: 7,
        frame: null,
        requestHeaders: { "x-orkestrator-preview-environment": "env-b" },
      },
      callback,
    );
    // The gateway refuses such a request rather than guessing an environment.
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Authorization: "Bearer gateway-token", Origin: "https://orkestrator.dev" },
    });
  });

  test("the main renderer session never names a preview environment", () => {
    const harness = installHarness({ previewViewEnvironment: () => "env-a" });
    const callback = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/invoke",
        requestHeaders: { "x-orkestrator-preview-environment": "env-b" },
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Authorization: "Bearer gateway-token", Origin: "https://orkestrator.dev" },
    });
  });

  test("a preview-only session without a view lookup authorizes nothing", () => {
    const harness = installHarness({ browserPreviewOnly: true });
    const preview = mock(() => undefined);
    harness.beforeHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/3000/",
        resourceType: "mainFrame",
        webContentsId: 7,
        frame: null,
        requestHeaders: {},
      },
      preview,
    );
    expect(preview).toHaveBeenCalledWith({ requestHeaders: {} });
  });

  test("rewrites response CORS only for authorized dedicated-preview requests", () => {
    const harness = installHarness(
      previewOnly("https://desk.example/__orkestrator/browser/loopback/4000/"),
    );
    const previewFrame = {
      url: "https://desk.example/__orkestrator/browser/loopback/3000/",
      parent: null,
    };

    const mainFrame = mock(() => undefined);
    harness.receivedHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/4000/",
        resourceType: "mainFrame",
        webContentsId: 7,
        referrer: previewFrame.url,
        frame: previewFrame,
        responseHeaders: {
          "Access-Control-Allow-Origin": ["https://desk.example"],
          Server: ["test"],
        },
      },
      mainFrame,
    );
    expect(mainFrame).toHaveBeenCalledWith({
      responseHeaders: { Server: ["test"], "Access-Control-Allow-Origin": ["*"] },
    });

    const xhr = mock(() => undefined);
    harness.receivedHeaders()(
      {
        url: "https://desk.example/__orkestrator/browser/loopback/4000/api",
        resourceType: "xhr",
        webContentsId: 7,
        referrer: previewFrame.url,
        frame: previewFrame,
        responseHeaders: {
          "Access-Control-Allow-Origin": ["https://desk.example"],
          Server: ["test"],
        },
      },
      xhr,
    );
    expect(xhr).toHaveBeenCalledWith({
      responseHeaders: {
        "Access-Control-Allow-Origin": ["https://desk.example"],
        Server: ["test"],
      },
    });
  });
});

test("reopened realms share one session auth listener and use only live renderer scopes", () => {
  type BeforeListener = Parameters<import("electron").WebRequest["onBeforeSendHeaders"]>[0];
  const webRequest = {
    onBeforeSendHeaders: mock((_filter: unknown, _listener: BeforeListener) => undefined),
    onHeadersReceived: mock((_filter: unknown, _listener: unknown) => undefined),
  };
  const scopes = new Map<number, string>([[10, "first"]]);
  const authorization = mock((_url: string, scope: string) => `Bearer ${scope}`);
  const install = createRealmRequestAuthInstaller((id) => scopes.get(id), authorization);
  install({ session: { webRequest: webRequest as never } });
  scopes.delete(10);
  scopes.set(11, "second");
  install({ session: { webRequest: webRequest as never } });
  expect(webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
  expect(webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
  const listener = webRequest.onBeforeSendHeaders.mock.calls[0]![1]!;
  const callback = mock((_response: unknown) => undefined);
  const details = { url: "https://desk.example/api", resourceType: "xhr", requestHeaders: {} };
  listener({ ...details, webContentsId: 10 } as never, callback);
  listener(details as never, callback);
  expect(authorization).not.toHaveBeenCalled();
  listener({ ...details, webContentsId: 11 } as never, callback);
  expect(authorization).toHaveBeenCalledWith(details.url, "second");
  expect(callback).toHaveBeenLastCalledWith({
    requestHeaders: {
      Authorization: "Bearer second",
      Origin: "https://orkestrator.dev",
    },
  });
  scopes.delete(11);
  listener({ ...details, webContentsId: 11 } as never, callback);
  expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {} });
});

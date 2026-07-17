import { afterEach, describe, expect, test } from "bun:test";
import { getGatewayBaseUrl, isGatewayBrowserPreviewSupported, resolveGatewayApiUrl, resolveGatewayBrowserPreviewUrl, resolveGatewayLoopbackBaseUrl } from "./gateway-url";

afterEach(() => {
  delete window.orkestratorGateway;
});

describe("isGatewayBrowserPreviewSupported", () => {
  test("supports previews with no gateway and with the desktop gateway", () => {
    expect(isGatewayBrowserPreviewSupported()).toBe(true);

    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };
    expect(isGatewayBrowserPreviewSupported()).toBe(true);
  });

  test("rejects previews in the non-desktop web client", () => {
    window.orkestratorGateway = { enabled: true };
    expect(isGatewayBrowserPreviewSupported()).toBe(false);

    window.orkestratorGateway = { enabled: false };
    expect(isGatewayBrowserPreviewSupported()).toBe(true);
  });
});

describe("resolveGatewayBrowserPreviewUrl", () => {
  test("uses the dedicated backend browser namespace", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    expect(resolveGatewayBrowserPreviewUrl("http://localhost:3000/app?mode=dark#main")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/app?mode=dark#main",
    );
  });

  test("leaves addresses direct when no remote gateway is active", () => {
    expect(resolveGatewayBrowserPreviewUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000/",
    );
  });

  test("uses the current origin when the gateway has no explicit base URL", () => {
    window.orkestratorGateway = { enabled: true };
    expect(resolveGatewayBrowserPreviewUrl("http://localhost:3000/")).toBe(
      `${window.location.origin}/__orkestrator/browser/loopback/3000/`,
    );
  });

  test("supports IPv6 and the default HTTP port", () => {
    window.orkestratorGateway = { enabled: true };
    expect(resolveGatewayBrowserPreviewUrl("http://[::1]:6000/api/")).toBe(
      `${window.location.origin}/__orkestrator/browser/loopback/6000/api/`,
    );
    expect(resolveGatewayBrowserPreviewUrl("http://127.0.0.1/")).toBe(
      `${window.location.origin}/__orkestrator/browser/loopback/80/`,
    );
  });

  test("leaves invalid, non-loopback, and non-HTTP addresses unchanged", () => {
    window.orkestratorGateway = { enabled: true };
    for (const address of ["not a url", "http://example.com:3000/", "https://localhost:3000/"]) {
      expect(resolveGatewayBrowserPreviewUrl(address)).toBe(address);
    }
  });
});

describe("resolveGatewayLoopbackBaseUrl", () => {
  test("uses and normalizes a configured direct gateway base URL", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    expect(getGatewayBaseUrl()).toBe("https://workstation.tailnet.ts.net");
    expect(resolveGatewayApiUrl("__orkestrator/status")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/status",
    );
    expect(resolveGatewayApiUrl("/__orkestrator/status")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/status",
    );
    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1:4000/api/")).toBe(
      "https://workstation.tailnet.ts.net/__orkestrator/proxy/loopback/4000/api",
    );
  });

  test("uses same-origin URLs when no direct base URL is configured", () => {
    expect(getGatewayBaseUrl()).toBe(window.location.origin);
    expect(resolveGatewayApiUrl("__orkestrator/status")).toBe("/__orkestrator/status");
  });

  test("leaves loopback URLs unchanged outside the remote gateway", () => {
    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
  });

  test("rewrites loopback URLs to the authenticated gateway proxy", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1:4000")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/4000`,
    );
    expect(resolveGatewayLoopbackBaseUrl("http://localhost:5000/api")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/5000/api`,
    );
    expect(resolveGatewayLoopbackBaseUrl("http://[::1]:6000/api/")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/6000/api`,
    );
  });

  test("does not rewrite non-loopback URLs", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("http://example.com:4000")).toBe("http://example.com:4000");
  });

  test("leaves invalid URLs unchanged and routes the default HTTP port", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("not a url")).toBe("not a url");
    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/80`,
    );
  });

  test("preserves query strings and fragments", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("http://localhost:4000/app?mode=dark#main")).toBe(
      `${window.location.origin}/__orkestrator/proxy/loopback/4000/app?mode=dark#main`,
    );
  });
});

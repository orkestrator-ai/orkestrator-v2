import { afterEach, describe, expect, test } from "bun:test";
import { getGatewayBaseUrl, resolveGatewayApiUrl, resolveGatewayLoopbackBaseUrl } from "./gateway-url";

afterEach(() => {
  delete window.orkestratorGateway;
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

  test("leaves invalid URLs and loopback URLs without explicit ports unchanged", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("not a url")).toBe("not a url");
    expect(resolveGatewayLoopbackBaseUrl("http://127.0.0.1")).toBe("http://127.0.0.1");
  });
});

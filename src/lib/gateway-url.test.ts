import { afterEach, describe, expect, test } from "bun:test";
import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";

afterEach(() => {
  delete window.orkestratorGateway;
});

describe("resolveGatewayLoopbackBaseUrl", () => {
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
  });

  test("does not rewrite non-loopback URLs", () => {
    window.orkestratorGateway = { enabled: true };

    expect(resolveGatewayLoopbackBaseUrl("http://example.com:4000")).toBe("http://example.com:4000");
  });
});

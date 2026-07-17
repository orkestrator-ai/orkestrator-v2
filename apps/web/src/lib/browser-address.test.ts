import { afterEach, describe, expect, test } from "bun:test";
import { resolveBrowserAddress } from "./browser-address";

afterEach(() => {
  delete window.orkestratorGateway;
});

describe("resolveBrowserAddress", () => {
  test("normalizes port and localhost shorthand", () => {
    expect(resolveBrowserAddress("3000")).toEqual({
      displayUrl: "http://localhost:3000/",
      iframeUrl: "http://localhost:3000/",
    });
    expect(resolveBrowserAddress("localhost:4173/app").displayUrl).toBe(
      "http://localhost:4173/app",
    );
  });

  test("routes loopback previews through the configured backend gateway", () => {
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    expect(resolveBrowserAddress("127.0.0.1:3000/dashboard?mode=dark")).toEqual({
      displayUrl: "http://127.0.0.1:3000/dashboard?mode=dark",
      iframeUrl: "https://workstation.tailnet.ts.net/__orkestrator/browser/loopback/3000/dashboard?mode=dark",
    });
  });

  test("rejects previews in the web client, which cannot authenticate iframe loads", () => {
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    expect(() => resolveBrowserAddress("localhost:3000")).toThrow("desktop app");
  });

  test("rejects non-loopback and non-HTTP addresses", () => {
    expect(() => resolveBrowserAddress("https://localhost:3000")).toThrow(
      "backend-local HTTP",
    );
    expect(() => resolveBrowserAddress("example.com:3000")).toThrow(
      "Use localhost or 127.0.0.1",
    );
    expect(() => resolveBrowserAddress(" ")).toThrow("Enter a backend-local address");
  });

  test("supports IPv6 loopback and the default HTTP port", () => {
    expect(resolveBrowserAddress("[::1]:4173/app").displayUrl).toBe("http://[::1]:4173/app");
    expect(resolveBrowserAddress("localhost").displayUrl).toBe("http://localhost/");
  });

  test("rejects embedded credentials, malformed input, and invalid boundary ports", () => {
    expect(() => resolveBrowserAddress("http://user:password@localhost:3000/")).toThrow(
      "embedded credentials",
    );
    expect(() => resolveBrowserAddress("0")).toThrow("port between 1 and 65535");
    expect(resolveBrowserAddress("1").displayUrl).toBe("http://localhost:1/");
    expect(resolveBrowserAddress("65535").displayUrl).toBe("http://localhost:65535/");
    expect(() => resolveBrowserAddress("65536")).toThrow();
    expect(() => resolveBrowserAddress(":")).toThrow("Enter an address such as localhost:3000");
  });
});

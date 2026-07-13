import { describe, expect, test } from "bun:test";
import { normalizeBackendAddress } from "./connection";

describe("public backend address", () => {
  test("defaults hostnames to HTTPS and removes the root slash", () => {
    expect(normalizeBackendAddress("workstation.tailnet.ts.net")).toBe(
      "https://workstation.tailnet.ts.net",
    );
    expect(normalizeBackendAddress(" http://127.0.0.1:34121/ ")).toBe(
      "http://127.0.0.1:34121",
    );
  });

  test("rejects credentials and gateway subpaths", () => {
    expect(() => normalizeBackendAddress("https://token@example.com")).toThrow("token field");
    expect(() => normalizeBackendAddress("https://example.com/gateway")).toThrow("origin only");
    expect(() => normalizeBackendAddress("file:///tmp/backend")).toThrow("HTTP or HTTPS");
  });
});

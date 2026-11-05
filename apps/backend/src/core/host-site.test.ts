import { describe, expect, test } from "bun:test";

import { approximateSite, hostsShareSite } from "./host-site.js";

describe("host site approximation", () => {
  test("errs towards 'same site'", () => {
    expect(approximateSite("app.example.com")).toBe("example.com");
    expect(approximateSite("a.b.example.co.uk")).toBe("example.co.uk");
    expect(approximateSite("127.0.0.1")).toBe("127.0.0.1");
    expect(hostsShareSite("artifacts.example.com", "app.example.com")).toBe(true);
    expect(hostsShareSite("example.com", "x.example.com")).toBe(true);
    expect(hostsShareSite("usercontent.example.net", "app.example.com")).toBe(false);
    expect(hostsShareSite("localhost", "127.0.0.1")).toBe(false);
    expect(hostsShareSite("a.example.co.uk", "b.example.co.uk")).toBe(true);
  });

  test("without extra public suffixes every ts.net host is one site", () => {
    expect(approximateSite("machine.tailnet.ts.net")).toBe("ts.net");
    expect(hostsShareSite("machine.one.ts.net", "preview.two.ts.net")).toBe(true);
  });

  test("a listed public suffix makes the label below it a site of its own", () => {
    const options = { publicSuffixes: ["ts.net"] };
    expect(approximateSite("machine.tailnet.ts.net", options)).toBe("tailnet.ts.net");
    expect(approximateSite("s-1.preview.tailnet.ts.net", options)).toBe("tailnet.ts.net");
    expect(approximateSite("app.example.com", options)).toBe("example.com");
    // Different tailnets are different sites.
    expect(hostsShareSite("machine.one.ts.net", "preview.two.ts.net", options)).toBe(false);
    // A preview domain under the application's own tailnet name is the same site.
    expect(hostsShareSite("machine.tailnet.ts.net", "preview.tailnet.ts.net", options)).toBe(true);
    expect(hostsShareSite("tailnet.ts.net", "preview.tailnet.ts.net", options)).toBe(true);
  });

  test("bracketed IPv6 literals and trailing dots are normalized", () => {
    expect(hostsShareSite("[::1]", "::1")).toBe(true);
    expect(hostsShareSite("app.example.com.", "example.com")).toBe(true);
  });
});

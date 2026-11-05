import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOOPBACK_URL, ModuleCache, decodedBodyHeaders, isModuleLoad } from "./browser-test";

const directory = import.meta.dirname;

/** Specs that keep Chromium's own network path for module loads, and why. */
const DIRECT_SPECS = new Map([
  ["browser-gateway.spec.ts", "the gateway's direct browser check"],
  ["client-outage.spec.ts", "outages of the browser's own network path"],
]);

function browserSuiteSpecs(): string[] {
  const config = readFileSync(path.join(directory, "playwright.browser.config.ts"), "utf8");
  const list = /testMatch: \[([^\]]*)\]/.exec(config)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+\.spec\.ts)"/g)].map((match) => match[1]!);
}

describe("the browser suite's shared test", () => {
  test("every browser-suite spec takes `test` from it unless it is listed as direct", () => {
    const specs = browserSuiteSpecs();
    expect(specs.length).toBeGreaterThan(40);
    const offenders = specs.filter((spec) => {
      const source = readFileSync(path.join(directory, spec), "utf8");
      const shared = /import \{[^}]*\btest\b[^}]*\} from "\.\/browser-test";/.test(source);
      return DIRECT_SPECS.has(spec) === shared;
    });
    expect(offenders).toEqual([]);
  });

  test("every context a browser-suite spec creates also fetches its modules itself", () => {
    const offenders = browserSuiteSpecs().flatMap((spec) => {
      if (DIRECT_SPECS.has(spec)) return [];
      const source = readFileSync(path.join(directory, spec), "utf8");
      const created = source.match(/\bbrowser\.newContext\(/g)?.length ?? 0;
      const routed = source.match(/\bfetchModulesOutsideChromium\(/g)?.length ?? 0;
      return created > routed ? [spec] : [];
    });
    expect(offenders).toEqual([]);
  });

  test("routes loopback origins only", () => {
    for (const url of [
      "http://127.0.0.1:43123/src/main.tsx",
      "http://localhost:5173/@vite/client",
      "http://[::1]:8080/assets/index.css",
      "https://127.0.0.1/",
    ])
      expect(LOOPBACK_URL.test(url), url).toBe(true);
    for (const url of [
      "https://example.com/127.0.0.1/main.js",
      "http://127.0.0.1.example.com/main.js",
      "http://localhost.example.com/main.js",
    ])
      expect(LOOPBACK_URL.test(url), url).toBe(false);
  });

  test("fetches GET scripts and stylesheets, and leaves everything else to Chromium", () => {
    const request = (method: string, resourceType: string) => ({
      method: () => method,
      resourceType: () => resourceType,
    });
    expect(isModuleLoad(request("GET", "script"))).toBe(true);
    expect(isModuleLoad(request("GET", "stylesheet"))).toBe(true);
    expect(isModuleLoad(request("POST", "script"))).toBe(false);
    for (const type of ["document", "fetch", "xhr", "eventsource", "websocket", "image", "font"])
      expect(isModuleLoad(request("GET", type)), type).toBe(false);
  });

  test("keeps complete module responses within its byte budget", () => {
    const cache = new ModuleCache(10);
    const module = (status: number, bytes: number) => ({
      status,
      headers: { "content-type": "text/javascript" },
      body: Buffer.alloc(bytes),
    });
    cache.set("http://127.0.0.1/a.js", module(200, 6));
    cache.set("http://127.0.0.1/missing.js", module(404, 1));
    cache.set("http://127.0.0.1/b.js", module(200, 6));
    cache.set("http://127.0.0.1/c.js", module(200, 4));
    expect(cache.get("http://127.0.0.1/a.js")?.body.byteLength).toBe(6);
    expect(cache.get("http://127.0.0.1/missing.js")).toBeUndefined();
    expect(cache.get("http://127.0.0.1/b.js")).toBeUndefined();
    expect(cache.get("http://127.0.0.1/c.js")?.body.byteLength).toBe(4);
    expect(cache.size).toBe(2);
  });

  test("drops the wire encoding headers of a body it serves decoded", () => {
    expect(
      decodedBodyHeaders({
        "content-type": "text/javascript",
        "content-encoding": "gzip",
        "content-length": "120",
        etag: "W/1",
      }),
    ).toEqual({ "content-type": "text/javascript", etag: "W/1" });
  });
});

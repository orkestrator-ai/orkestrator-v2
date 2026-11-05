import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOOPBACK_URL, isModuleLoad } from "./browser-test";

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
});

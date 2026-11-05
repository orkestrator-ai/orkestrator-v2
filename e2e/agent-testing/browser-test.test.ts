import { describe, expect, mock, test } from "bun:test";
import type { BrowserContext, Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LOOPBACK_URL,
  ModuleCache,
  decodedBodyHeaders,
  fetchModulesOutsideChromium,
  isModuleLoad,
} from "./browser-test";

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

/** Capture the real installed callback without replacing any shared module. */
async function moduleHandler() {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = {
    route: mock(async (pattern: RegExp, callback: (route: Route) => Promise<void>) => {
      expect(pattern).toBe(LOOPBACK_URL);
      handler = callback;
    }),
  };
  await fetchModulesOutsideChromium(context as unknown as BrowserContext);
  expect(context.route).toHaveBeenCalledTimes(1);
  if (!handler) throw new Error("Module route was not installed");
  return handler;
}

function moduleRoute(options: { method?: string; resourceType?: string; status?: number } = {}) {
  const body = Buffer.from("export const loaded = true;");
  const route = {
    request: () => ({
      method: () => options.method ?? "GET",
      resourceType: () => options.resourceType ?? "script",
      url: () => "http://127.0.0.1:5173/src/main.ts",
    }),
    fetch: mock(async () => ({
      status: () => options.status ?? 200,
      headers: () => ({
        "content-type": "text/javascript",
        "content-encoding": "gzip",
        "content-length": "100",
      }),
      body: async () => body,
    })),
    fulfill: mock(async (_response: unknown) => {}),
    fallback: mock(async () => {}),
    abort: mock(async () => {}),
  };
  return {
    route,
    body,
    dispatch: (handler: (route: Route) => Promise<void>) => handler(route as unknown as Route),
  };
}

describe("installed module route handler", () => {
  test("fetches a module once and fulfils a same-URL load from the context cache", async () => {
    const handler = await moduleHandler();
    const first = moduleRoute();
    await first.dispatch(handler);
    expect(first.route.fetch).toHaveBeenCalledWith({ maxRetries: 2 });
    expect(first.route.fulfill).toHaveBeenCalledWith({
      status: 200,
      headers: { "content-type": "text/javascript" },
      body: first.body,
    });
    const reload = moduleRoute();
    await reload.dispatch(handler);
    expect(reload.route.fetch).not.toHaveBeenCalled();
    expect(reload.route.fulfill).toHaveBeenCalledWith(first.route.fulfill.mock.calls[0]![0]);
    expect(first.route.fallback).not.toHaveBeenCalled();
    expect(first.route.abort).not.toHaveBeenCalled();

    const otherContext = moduleRoute();
    await otherContext.dispatch(await moduleHandler());
    expect(otherContext.route.fetch).toHaveBeenCalledTimes(1);
  });

  test("falls back without fetching or fulfilling non-module requests", async () => {
    const handler = await moduleHandler();
    for (const options of [
      { resourceType: "document" },
      { resourceType: "fetch" },
      { method: "POST" },
    ]) {
      const { route, dispatch } = moduleRoute(options);
      await dispatch(handler);
      expect(route.fallback).toHaveBeenCalledTimes(1);
      expect(route.fetch).not.toHaveBeenCalled();
      expect(route.fulfill).not.toHaveBeenCalled();
      expect(route.abort).not.toHaveBeenCalled();
    }
  });

  test("fulfils unsuccessful responses but fetches them again on the next load", async () => {
    const handler = await moduleHandler();
    const missing = moduleRoute({ status: 404, resourceType: "stylesheet" });
    await missing.dispatch(handler);
    expect(missing.route.fulfill).toHaveBeenCalledWith({
      status: 404,
      headers: { "content-type": "text/javascript" },
      body: missing.body,
    });
    const retry = moduleRoute();
    await retry.dispatch(handler);
    expect(retry.route.fetch).toHaveBeenCalledTimes(1);
  });

  test("aborts a failed fetch without caching it, even if abort also rejects", async () => {
    const handler = await moduleHandler();
    const failed = moduleRoute();
    failed.route.fetch.mockRejectedValueOnce(new Error("Request closed"));
    failed.route.abort.mockRejectedValueOnce(new Error("Page closed"));
    await failed.dispatch(handler);
    expect(failed.route.abort).toHaveBeenCalledTimes(1);
    expect(failed.route.fulfill).not.toHaveBeenCalled();
    expect(failed.route.fallback).not.toHaveBeenCalled();
    const retry = moduleRoute();
    await retry.dispatch(handler);
    expect(retry.route.fetch).toHaveBeenCalledTimes(1);
    expect(retry.route.fulfill).toHaveBeenCalledTimes(1);
  });
});

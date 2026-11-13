import { gzipSync } from "node:zlib";
import { createCounter, routeLabel, type CounterFile } from "./conditional-reads-bridge-counter";
import {
  assertWindowEvidence,
  summarizeCounters,
  withCleanup,
} from "./conditional-reads-measurement";

import { describe, expect, mock, test } from "bun:test";
import type { BrowserContext, Page, Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseSync, visitorKeys, type Node } from "oxc-parser";
import {
  DIRECT_LOAD_TIMEOUT_MS,
  DIRECT_LOAD_NAVIGATION_MS,
  DIRECT_LOAD_WAIT_MS,
  runDirectLoads,
  LOOPBACK_URL,
  ModuleCache,
  NETWORK_CHANGED,
  decodedBodyHeaders,
  directLoadOutcome,
  fetchModulesOutsideChromium,
  isModuleLoad,
  isNetworkChangedNavigation,
  moduleStatusFailure,
  retryNavigationsOnNetworkChange,
} from "./browser-test";

const directory = import.meta.dirname;

/** Specs that keep Chromium's own network path for module loads, and why. */
const DIRECT_SPECS = new Map([
  ["client-outage.spec.ts", "outages of the browser's own network path"],
  [
    "background-tab-reconnect-live.spec.ts",
    "a hidden tab needs a browser Playwright did not launch",
  ],
]);

/** Specs with cases that load modules through Chromium themselves, and how many. */
const DIRECT_CASES = new Map([["browser-gateway.spec.ts", 1]]);

function browserSuiteSpecs(): string[] {
  const config = readFileSync(path.join(directory, "playwright.browser.config.ts"), "utf8");
  const list = /testMatch: \[([^\]]*)\]/.exec(config)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+\.spec\.ts)"/g)].map((match) => match[1]!);
}

/** Conservative syntax guard: newPage is allowed only on an explicitly routed context.
 * Inspect syntax rather than counting text so receiver aliases, bracket access,
 * comments and unrelated routing calls cannot bypass the guard.
 */
function contextRoutingGaps(source: string): string[] {
  const { program, errors } = parseSync("browser-spec.ts", source);
  if (errors.length) throw new Error(errors[0]!.message);
  const nodes: { node: Node; parent?: Node }[] = [];
  function visit(node: Node, parent?: Node) {
    nodes.push({ node, parent });
    for (const key of visitorKeys[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item) visit(item as Node, node);
      } else if (child) visit(child as Node, node);
    }
  }
  visit(program);
  const contexts = new Map<string, number>();
  const routed = new Map<string, number>();
  const engines = new Set(["chromium", "firefox", "webkit"]);
  for (const { node } of nodes) {
    if (
      node.type === "ImportSpecifier" &&
      node.imported.type === "Identifier" &&
      engines.has(node.imported.name)
    ) {
      engines.add(node.local.name);
    }
  }
  const gaps: string[] = [];
  const memberName = (node: Node): string | undefined => {
    if (node.type !== "MemberExpression") return;
    if (!node.computed && node.property.type === "Identifier") return node.property.name;
    if (
      node.computed &&
      node.property.type === "Literal" &&
      typeof node.property.value === "string"
    )
      return node.property.value;
  };
  for (const { node, parent } of nodes) {
    if (node.type !== "CallExpression") continue;
    if (
      node.callee.type === "Identifier" &&
      node.callee.name === "fetchModulesOutsideChromium" &&
      parent?.type === "AwaitExpression"
    ) {
      const arg = node.arguments[0];
      if (arg?.type === "Identifier") routed.set(arg.name, node.start);
    }
    const method = memberName(node.callee);
    if (node.callee.type !== "MemberExpression") continue;
    const receiver = node.callee.object;
    if (method === "newContext") {
      const declaration = nodes.find(
        (entry) => entry.node.type === "VariableDeclarator" && entry.node.init === parent,
      )?.node;
      if (declaration?.type === "VariableDeclarator" && declaration.id.type === "Identifier") {
        contexts.set(declaration.id.name, node.start);
      } else gaps.push("newContext must be assigned to a named context");
    }
    if (method === "newPage") {
      const name = receiver.type === "Identifier" ? receiver.name : "";
      const created = contexts.get(name);
      const installed = routed.get(name);
      if (
        created === undefined ||
        installed === undefined ||
        installed < created ||
        installed > node.start
      ) {
        gaps.push("newPage requires an awaited route on its named context before use");
      }
    }
    if (
      (method === "launch" || method === "launchPersistentContext") &&
      ((receiver.type === "Identifier" && engines.has(receiver.name)) ||
        engines.has(memberName(receiver) ?? ""))
    ) {
      gaps.push("use the shared browser fixture instead of launching another browser");
    }
  }
  for (const [name, created] of contexts) {
    if ((routed.get(name) ?? -1) < created) gaps.push(`unrouted context: ${name}`);
  }
  return gaps;
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

  test("only the listed cases opt back into Chromium's own module loads", () => {
    const counts = browserSuiteSpecs().flatMap((spec) => {
      const source = readFileSync(path.join(directory, spec), "utf8");
      const count = source.split("modulesThroughChromium: true").length - 1;
      return count > 0 ? [[spec, count] as const] : [];
    });
    expect(new Map(counts)).toEqual(DIRECT_CASES);
  });

  test("a direct load is retried only when it lost modules to network changes alone", () => {
    expect(directLoadOutcome([], true)).toBe("loaded");
    expect(directLoadOutcome([], false)).toBe("failed");
    expect(directLoadOutcome([NETWORK_CHANGED, NETWORK_CHANGED], false)).toBe("network-changed");
    expect(directLoadOutcome([NETWORK_CHANGED], true)).toBe("network-changed");
    expect(directLoadOutcome([NETWORK_CHANGED, "HTTP 502"], false)).toBe("failed");
    expect(directLoadOutcome(["net::ERR_CONNECTION_RESET"], true)).toBe("failed");
  });

  test("a direct load counts a revalidated module as loaded and any other status as failed", () => {
    expect(moduleStatusFailure(200)).toBeUndefined();
    expect(moduleStatusFailure(304)).toBeUndefined();
    for (const status of [204, 404, 500, 502])
      expect(moduleStatusFailure(status)).toBe(`HTTP ${status}`);
  });

  test("every context a browser-suite spec creates also fetches its modules itself", () => {
    const offenders = browserSuiteSpecs().flatMap((spec) => {
      if (DIRECT_SPECS.has(spec)) return [];
      const source = readFileSync(path.join(directory, spec), "utf8");
      return contextRoutingGaps(source).map((gap) => `${spec}: ${gap}`);
    });
    expect(offenders).toEqual([]);
  });

  test("the context guard rejects browser shortcuts, renamed receivers and extra launches", () => {
    for (const source of [
      "await browser.newPage();",
      "const renamed = browser; await renamed.newPage();",
      "const second = await renamed.newContext();",
      "const second = await renamed['newContext']();",
      "import { chromium } from '@playwright/test'; await chromium.launch();",
      "import { chromium as engine } from './browser-test'; await engine.launch();",
      "import * as pw from '@playwright/test'; await pw.chromium.launch();",
      // Routing a different context must not satisfy the check.
      "const second = await browser.newContext(); await fetchModulesOutsideChromium(first);",
      "const second = await browser.newContext(); second.newPage(); await fetchModulesOutsideChromium(second);",
      "const second = await browser.newContext(); fetchModulesOutsideChromium(second); second.newPage();",
    ]) {
      expect(contextRoutingGaps(source).length, source).toBeGreaterThan(0);
    }
  });

  test("the context guard accepts routed named contexts and ignores comments and strings", () => {
    expect(
      contextRoutingGaps(`
      const second = await renamed.newContext();
      await fetchModulesOutsideChromium(second);
      const page = await second.newPage();
      // browser.newPage(); chromium.launch();
      const description = "browser.newContext()";
    `),
    ).toEqual([]);
    expect(
      contextRoutingGaps(`
      const first = await browser.newContext();
      await fetchModulesOutsideChromium(first);
      const second = await browser.newContext();
      await fetchModulesOutsideChromium(first);
      second.newPage();
    `),
    ).not.toEqual([]);
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
    on: mock((_event: string, _listener: unknown) => context),
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

describe("navigations Chromium aborted for a network change", () => {
  const networkChanged = () => new Error(`page.goto: ${NETWORK_CHANGED} at http://127.0.0.1:1/`);

  function fakePage(outcomes: (Error | string)[]) {
    const calls: unknown[][] = [];
    const next = async (...args: unknown[]) => {
      calls.push(args);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    const page = { goto: next, reload: next };
    retryNavigationsOnNetworkChange(page as unknown as Page);
    return { page, calls };
  }

  test("are tried again with the same arguments until one lands", async () => {
    const { page, calls } = fakePage([networkChanged(), networkChanged(), "response"]);
    expect(await page.goto("http://127.0.0.1:1/", { waitUntil: "load" })).toBe("response");
    expect(calls).toEqual(Array(3).fill(["http://127.0.0.1:1/", { waitUntil: "load" }]));
  });

  test("covers reload too", async () => {
    const { page, calls } = fakePage([networkChanged(), "reloaded"]);
    expect(await page.reload()).toBe("reloaded");
    expect(calls).toHaveLength(2);
  });

  test("give up after the last attempt with Chromium's own error", async () => {
    const { page, calls } = fakePage([networkChanged(), networkChanged(), networkChanged()]);
    await expect(page.goto("http://127.0.0.1:1/")).rejects.toThrow(NETWORK_CHANGED);
    expect(calls).toHaveLength(3);
  });

  test("never retry any other failure", async () => {
    const { page, calls } = fakePage([new Error("page.goto: net::ERR_CONNECTION_REFUSED")]);
    await expect(page.goto("http://127.0.0.1:1/")).rejects.toThrow("ERR_CONNECTION_REFUSED");
    expect(calls).toHaveLength(1);
    expect(isNetworkChangedNavigation("net::ERR_NETWORK_CHANGED")).toBe(false);
  });

  test("apply to every page a routed context opens", async () => {
    const listeners: ((page: Page) => void)[] = [];
    const context = {
      on: (event: string, listener: (page: Page) => void) => {
        expect(event).toBe("page");
        listeners.push(listener);
      },
      route: async () => {},
    };
    await fetchModulesOutsideChromium(context as unknown as BrowserContext);
    expect(listeners).toHaveLength(1);
    const outcomes: (Error | string)[] = [networkChanged(), "response"];
    const page = {
      goto: async () => {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      reload: async () => "reloaded",
    };
    listeners[0]!(page as unknown as Page);
    expect(await page.goto()).toBe("response");
  });
});

describe("one-shot login navigation recovery", () => {
  test("renews a consumed code rather than accepting a replayed 401", async () => {
    const spent = new Set<string>();
    const urls: string[] = [];
    const first = "http://127.0.0.1:1/__orkestrator/agent-test/login?code=first";
    const second = first.replace("first", "second");
    const page = {
      goto: async (url: string) => {
        urls.push(url);
        if (spent.has(url)) return { status: 401 };
        spent.add(url);
        if (url === first) throw new Error(NETWORK_CHANGED);
        return { status: 200 };
      },
      reload: async () => undefined,
    };
    retryNavigationsOnNetworkChange(page as unknown as Page, 3, () => second);
    expect(await page.goto(first)).toEqual({ status: 200 });
    expect(urls).toEqual([first, second]);
  });

  test("does not renew a login on an unrelated error", async () => {
    const renew = mock(() => "unused");
    const page = {
      goto: async () => {
        throw new Error("refused");
      },
      reload: async () => {},
    };
    retryNavigationsOnNetworkChange(page as unknown as Page, 3, renew);
    await expect(
      (page as unknown as Page).goto("http://127.0.0.1/__orkestrator/agent-test/login?code=one"),
    ).rejects.toThrow("refused");
    expect(renew).not.toHaveBeenCalled();
  });
});

describe("direct-load orchestration budget", () => {
  test("four blank churn loads finish with the churn diagnostic inside the case budget", async () => {
    let elapsed = 120_000;
    let calls = 0;
    await expect(
      runDirectLoads(async () => {
        calls += 1;
        // Model both navigations exhausting their retries and the entire blank UI wait.
        elapsed += 2 * 3 * DIRECT_LOAD_NAVIGATION_MS + DIRECT_LOAD_WAIT_MS;
        return { failures: [NETWORK_CHANGED], rendered: false };
      }),
    ).rejects.toThrow("All 4 loads lost module requests");
    expect(calls).toBe(4);
    expect(elapsed).toBeLessThanOrEqual(DIRECT_LOAD_TIMEOUT_MS);
    const spec = readFileSync(path.join(directory, "browser-gateway.spec.ts"), "utf8");
    expect(spec).toContain("test.setTimeout(DIRECT_LOAD_TIMEOUT_MS)");
    expect(spec).toContain("await runDirectLoads(");
  });

  test("allows the fourth load to succeed and stops real module errors immediately", async () => {
    let calls = 0;
    await runDirectLoads(async () => ({
      failures: ++calls < 4 ? [NETWORK_CHANGED] : [],
      rendered: calls === 4,
    }));
    expect(calls).toBe(4);
    const load = mock(async () => ({ failures: ["HTTP 500"], rendered: false }));
    await expect(runDirectLoads(load)).rejects.toThrow("HTTP 500");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

const snapshot = (messages: unknown[]) =>
  Buffer.from(JSON.stringify({ status: "snapshot", value: { messages } }));
describe("bridge measurements", () => {
  test("normalizes session ids and query values while retaining the v2 discriminator", () => {
    expect(
      routeLabel("GET", "/session/private/transcript?version=2&knownToken=secret&knownToken=again"),
    ).toBe("GET /session/:id/transcript?knownToken&version=2");
    expect(routeLabel("POST", "/sessions/activity")).toBe("POST /sessions/activity");
    expect(routeLabel(undefined, undefined)).toBe("GET /");
    expect(routeLabel("GET", "/sessions/private/status?token=secret")).toBe(
      "GET /sessions/:id/status?token",
    );
  });
  test("estimates changed and added rows, includes order, and isolates sessions", () => {
    const counter = createCounter();
    const first = { id: "a", text: "old" };
    counter.recordSnapshot("one", snapshot([first]), false);
    expect(counter.delta.snapshots).toBe(0); // no base yet
    const changed = { id: "a", text: "new" };
    const added = { id: "b", text: "é" };
    const body = snapshot([changed, added]);
    expect(counter.recordSnapshot("one", gzipSync(body), true)).toBe(body.byteLength);
    expect(counter.delta).toEqual({
      snapshots: 1,
      snapshotBytes: body.byteLength,
      changedRows: 2,
      rows: 2,
      trimmedHeads: 0,
      estimatedDeltaBytes:
        Buffer.byteLength(JSON.stringify(changed)) +
        Buffer.byteLength(JSON.stringify(added)) +
        8 +
        512,
    });
    const previous = { ...counter.delta };
    counter.recordSnapshot("one", snapshot([added, changed]), false);
    expect(counter.delta.changedRows).toBe(previous.changedRows);
    expect(counter.delta.estimatedDeltaBytes - previous.estimatedDeltaBytes).toBe(520);
    counter.recordSnapshot("other", body, false);
    expect(counter.delta.snapshots).toBe(2);
    counter.recordSnapshot("one", snapshot([added]), false); // removed id is absent from order
    expect(counter.delta.estimatedDeltaBytes - previous.estimatedDeltaBytes).toBe(520 + 516);
    counter.recordSnapshot("one", Buffer.from('{"status":"unchanged"}'), false);
    expect(counter.delta.snapshots).toBe(3);
  });
  test("counts snapshots whose head row was part-trimmed", () => {
    const counter = createCounter();
    const trimmed = (omittedParts?: number) =>
      Buffer.from(
        JSON.stringify({
          status: "snapshot",
          value: {
            messages: [{ id: "head", text: "tail" }],
            messageWindow: { truncated: true, ...(omittedParts ? { omittedParts } : {}) },
          },
        }),
      );
    counter.recordSnapshot("one", trimmed(3), false);
    counter.recordSnapshot("one", trimmed(), false);
    counter.recordSnapshot("one", gzipSync(trimmed(1)), true);
    expect(counter.delta.trimmedHeads).toBe(2);
  });
  test("state repeats compare decoded bodies per route and session", () => {
    const counter = createCounter();
    const body = Buffer.from('{"phase":"idle"}');
    expect(counter.stateRepeated("GET /session/:id", "a", body, false)).toBe(false);
    expect(counter.stateRepeated("GET /session/:id", "a", gzipSync(body), true)).toBe(true);
    expect(counter.stateRepeated("GET /session/:id/status", "a", body, false)).toBe(false);
    expect(counter.stateRepeated("GET /session/:id", "b", body, false)).toBe(false);
    expect(counter.stateRepeated("GET /session/:id", "a", Buffer.from("{}"), false)).toBe(false);
  });
  test("uses exact half-open boundaries despite delayed flushes", () => {
    const delta = {
      snapshots: 1,
      snapshotBytes: 100,
      estimatedDeltaBytes: 50,
      changedRows: 1,
      rows: 2,
      trimmedHeads: 1,
    };
    const route = { count: 1, bytes: 10, decodedBytes: 100, ms: 2, maxMs: 2, repeats: 1 };
    const file: CounterFile = {
      flushedAt: 5000,
      droppedThrough: 0,
      samples: [999, 1000, 1999, 2000, 4000].map((at) => ({
        at,
        label: "GET /session/:id",
        route,
        delta,
      })),
    };
    const result = summarizeCounters([file], 1000, 2000);
    expect(result.routes["GET /session/:id"]).toEqual({
      count: 2,
      bytes: 20,
      decodedBytes: 200,
      ms: 4,
      meanMs: 2,
      repeats: 2,
    });
    expect(result.delta.snapshots).toBe(2);
    expect(result.delta.trimmedHeads).toBe(2);
    expect(() => summarizeCounters([], 1000, 2000)).toThrow("Missing bridge instrumentation");
    expect(() => summarizeCounters([{ ...file, flushedAt: 1999 }], 1000, 2000)).toThrow(
      "not flushed",
    );
    expect(() => summarizeCounters([{ ...file, droppedThrough: 1000 }], 1000, 2000)).toThrow(
      "bounded history",
    );
  });
  test("rejects missing route, snapshot and viewer evidence", () => {
    const route = { count: 1, bytes: 1, decodedBytes: 1, ms: 1, meanMs: 1, repeats: 0 };
    const window = {
      bridge: {
        routes: { "GET /session/:id": route, "GET /session/:id/transcript?version=2": route },
        delta: {
          snapshots: 1,
          snapshotBytes: 1,
          estimatedDeltaBytes: 1,
          changedRows: 1,
          rows: 1,
          trimmedHeads: 0,
        },
      },
      renderer: { first: { "transcript:delta": 1, "state:unchanged": 1 } },
    };
    expect(() => assertWindowEvidence(window, ["first"], true)).not.toThrow();
    const codex = {
      ...window,
      bridge: {
        ...window.bridge,
        routes: {
          "GET /session/:id/status": route,
          "GET /session/:id/transcript?version=2": route,
        },
      },
    };
    expect(() => assertWindowEvidence(codex, ["first"], true)).not.toThrow();
    expect(() => assertWindowEvidence(window, ["first", "second"], true)).toThrow("viewer");
    expect(() =>
      assertWindowEvidence(
        { ...window, bridge: { ...window.bridge, routes: {} } },
        ["first"],
        true,
      ),
    ).toThrow("state");
    expect(() =>
      assertWindowEvidence(
        { ...window, bridge: { ...window.bridge, routes: { "GET /session/:id": route } } },
        ["first"],
        true,
      ),
    ).toThrow("transcript observations");
    const idle = {
      ...window,
      bridge: { ...window.bridge, delta: { ...window.bridge.delta, snapshots: 0 } },
    };
    expect(() => assertWindowEvidence(idle, ["first"], true)).toThrow("snapshots");
    expect(() => assertWindowEvidence(idle, ["first"], false)).not.toThrow();
  });
  test("cleans up on setup and artifact failures", async () => {
    for (const failure of ["setup", "artifact"]) {
      const released: string[] = [];
      await expect(
        withCleanup(
          async () => {
            throw new Error(failure);
          },
          async () => {
            try {
              if (failure === "artifact") throw new Error("artifact");
            } finally {
              released.push("files", "model");
            }
          },
        ),
      ).rejects.toThrow(failure);
      expect(released).toEqual(["files", "model"]);
    }
  });
});

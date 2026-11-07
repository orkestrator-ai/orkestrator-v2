import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  INVOKE_OBSERVER_BINDING,
  classifyCaller,
  normalizeEventName,
  observeCommandInvokes,
  observerInitScript,
  readObservations,
  summarizeObservations,
  wireInvoke,
  type ObservationFile,
} from "./invoke-observer";
import type { BrowserContext } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:51234";

describe("classifyCaller", () => {
  test("the command client's module is the client path", () => {
    expect(
      classifyCaller(
        `    at Object.invokeRaw (${ORIGIN}/src/lib/node-scope/command-client.ts?t=1730000000000:212:18)`,
      ),
    ).toEqual({ path: "client" });
    expect(classifyCaller(`    at ${ORIGIN}/src/lib/node-scope/command-client.ts:212:18`)).toEqual({
      path: "client",
    });
  });

  test("another page module is a direct call, named by its pathname", () => {
    expect(
      classifyCaller(`    at loadThing (${ORIGIN}/src/components/Thing.tsx?t=1:10:3)`),
    ).toEqual({ path: "direct", module: "/src/components/Thing.tsx" });
    // The command client's name elsewhere in a path does not count as the client.
    expect(
      classifyCaller(`    at x (${ORIGIN}/src/lib/node-scope/command-client.ts.bak:1:1)`),
    ).toMatchObject({ path: "direct" });
  });

  test("no page-module frame is a spec's own evaluate", () => {
    expect(classifyCaller("")).toEqual({ path: "harness" });
    expect(classifyCaller("    at eval (eval at evaluate (:234:30), <anonymous>:1:22)")).toEqual({
      path: "harness",
    });
  });
});

test("event names lose their ids", () => {
  expect(normalizeEventName("terminal-output-3f2c9e1a")).toBe("terminal-output-*");
  expect(normalizeEventName("agent-event-0b8f4a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(
    "agent-event-<id>",
  );
  expect(normalizeEventName("resource-changed")).toBe("resource-changed");
});

test("wireInvoke reads only invoke posts, by command name", () => {
  const request = (method: string, url: string, body: string | null) => ({
    method: () => method,
    url: () => url,
    postData: () => body,
  });
  expect(
    wireInvoke(
      request("POST", `${ORIGIN}/__orkestrator/invoke`, '{"command":"get_projects","args":{}}'),
    ),
  ).toEqual({ name: "get_projects", base: "" });
  expect(
    wireInvoke(
      request("POST", `${ORIGIN}/__orkestrator/nodes/n1/__orkestrator/invoke`, '{"command":"a"}'),
    ),
  ).toEqual({ name: "a", base: "/__orkestrator/nodes/n1" });
  expect(wireInvoke(request("GET", `${ORIGIN}/__orkestrator/invoke`, null))).toBeUndefined();
  expect(wireInvoke(request("POST", `${ORIGIN}/__orkestrator/hello`, "{}"))).toBeUndefined();
  expect(wireInvoke(request("POST", `${ORIGIN}/__orkestrator/invoke`, "not json"))).toBeUndefined();
});

describe("observerInitScript", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete (globalThis as Record<string, unknown>).window;
  });

  test("wraps the API's invoke and listen in place when it is assigned, and reports names only", async () => {
    const reports: unknown[] = [];
    const fakeWindow: Record<string, unknown> = {
      [INVOKE_OBSERVER_BINDING]: async (record: unknown) => void reports.push(record),
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    observerInitScript(INVOKE_OBSERVER_BINDING);

    const calls: unknown[][] = [];
    const api = {
      invoke: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve("result");
      },
      listen: (_event: string, _handler: () => void) => () => {},
      other: 1,
    };
    expect(fakeWindow.orkestrator).toBeUndefined();
    fakeWindow.orkestrator = api;
    // Same object (a WeakMap keyed by the API still finds it), with wrapped members.
    expect(fakeWindow.orkestrator).toBe(api);
    expect(await api.invoke("get_projects", { secret: "x" })).toBe("result");
    expect(calls).toEqual([["get_projects", { secret: "x" }]]);
    expect(typeof api.listen("resource-changed", () => {})).toBe("function");
    // Reassigning the same object does not wrap it twice.
    fakeWindow.orkestrator = api;
    await api.invoke("get_config");

    expect(reports).toHaveLength(3);
    expect(reports.map((report) => (report as { kind: string; name: string }).name)).toEqual([
      "get_projects",
      "resource-changed",
      "get_config",
    ]);
    expect(JSON.stringify(reports)).not.toContain("secret");
  });
});

test("observeCommandInvokes does nothing without the opt-in", async () => {
  const context = new Proxy(
    {},
    {
      get: () => {
        throw new Error("touched");
      },
    },
  ) as BrowserContext;
  await observeCommandInvokes(context, undefined);
  await observeCommandInvokes(context, "");
});

describe("summarizeObservations", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("totals paths, lists direct calls and wire-only commands", () => {
    const files: ObservationFile[] = [
      {
        test: "a",
        calls: [
          { kind: "invoke", name: "get_projects", path: "client", count: 3 },
          { kind: "invoke", name: "get_config", path: "harness", count: 1 },
          { kind: "listen", name: "resource-changed", path: "client", count: 2 },
          { kind: "invoke", name: "x", path: "direct", module: "/src/x.ts", count: 1 },
        ],
        wire: [
          { name: "get_projects", base: "", count: 3 },
          { name: "write_terminal", base: "", count: 1 },
        ],
      },
      {
        test: "b",
        calls: [{ kind: "invoke", name: "write_terminal", path: "client", count: 1 }],
        wire: [{ name: "write_terminal", base: "", count: 1 }],
      },
    ];
    directory = mkdtempSync(path.join(tmpdir(), "invoke-observer-"));
    files.forEach((file, index) =>
      writeFileSync(path.join(directory!, `${index}.json`), JSON.stringify(file)),
    );
    const summary = summarizeObservations(readObservations(directory));
    expect(summary.contexts).toBe(2);
    expect(summary.totals["invoke:client"]).toBe(4);
    expect(summary.totals["invoke:harness"]).toBe(1);
    expect(summary.totals["invoke:direct"]).toBe(1);
    expect(summary.totals["listen:client"]).toBe(2);
    expect(summary.clientNames).toEqual({ invoke: 2, listen: 1 });
    expect(summary.direct).toEqual([
      { kind: "invoke", name: "x", path: "direct", module: "/src/x.ts", count: 1, test: "a" },
    ]);
    // Per context: "write_terminal" went through the client in b, not in a.
    expect(summary.wireOnly).toEqual([{ test: "a", name: "write_terminal", base: "" }]);
    expect(summary.wireTotal).toBe(5);
  });
});

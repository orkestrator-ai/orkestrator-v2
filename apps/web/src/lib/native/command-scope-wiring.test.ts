/**
 * `invoke` and `listen` are command-scope wrappers (plan item 2010): with a
 * fake command client installed, every call the app makes through them
 * reaches that client, and none reaches `window.orkestrator`.
 *
 * `tests/setup.ts` replaces both modules for every suite, and Bun keys that
 * mock by resolved path, so the real implementations are imported with a
 * query suffix (see `events.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  commandClient,
  getWindowScope,
  resetWindowScopeForTests,
} from "@/lib/node-scope/app-window-scope";
import { invokeInScope } from "@/lib/node-scope/scope-transport";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { listenAuthoritativeWith } from "./authoritative-events";

const realBackendPath = "./backend.ts?real";
const realEventsPath = "./events.ts?real";
const { invoke } = (await import(realBackendPath)) as typeof import("./backend");
const { listen } = (await import(realEventsPath)) as typeof import("./events");

type Api = NonNullable<Window["orkestrator"]>;

const COMMAND = "bk_command" as BackendId;
const LEAF = "bk_leaf" as BackendId;

let fake: FakeNodeClient;
let leafWindow: WindowScope | null = null;
const previousApi = window.orkestrator;
const directInvoke = mock(() => Promise.reject(new Error("window.orkestrator.invoke was called")));
const directListen = mock(() => () => {});

beforeEach(() => {
  // Anything that still reached the global would be recorded here.
  window.orkestrator = { invoke: directInvoke, listen: directListen } as unknown as Api;
  fake = new FakeNodeClient({ nodeId: COMMAND });
  resetWindowScopeForTests(fake);
});

afterEach(() => {
  getWindowScope().commandScope().prefetched.clear();
  leafWindow?.dispose();
  leafWindow = null;
  resetWindowScopeForTests();
  window.orkestrator = previousApi;
  directInvoke.mockClear();
  directListen.mockClear();
});

describe("invoke through the command scope", () => {
  test("every invoke reaches the command scope's client", async () => {
    fake
      .respond("get_config", { theme: "dark" })
      .respond("update_config", (args: Readonly<Record<string, unknown>>) => args);
    expect(getWindowScope().commandScope().client).toBe(fake);
    expect(commandClient()).toBe(fake);
    await expect(invoke("get_config")).resolves.toEqual({ theme: "dark" });
    await expect(invoke("update_config", { theme: "light" })).resolves.toEqual({ theme: "light" });
    expect(fake.invocations.map((call) => call.command)).toEqual(["get_config", "update_config"]);
    expect(directInvoke).not.toHaveBeenCalled();
  });

  test("a client failure is the caller's rejection", async () => {
    await expect(invoke("get_missing")).rejects.toThrow("no response for get_missing");
  });

  test("a primed read is answered from the command scope's cache until a write drops it", async () => {
    fake.respond("get_projects", ["fresh"]).respond("create_project", null);
    getWindowScope()
      .commandScope()
      .prefetched.prime([{ command: "get_projects", args: {}, snapshot: ["primed"] }]);
    expect(getWindowScope().commandScope().prefetched.size).toBe(1);
    await expect(invoke("get_projects", {})).resolves.toEqual(["primed"]);
    expect(fake.invocations).toEqual([]);
    await invoke("create_project", { name: "x" });
    await expect(invoke("get_projects", {})).resolves.toEqual(["fresh"]);
    expect(fake.invocations.map((call) => call.command)).toEqual([
      "create_project",
      "get_projects",
    ]);
  });

  test("the cache belongs to the scope: a new command scope starts empty", async () => {
    getWindowScope()
      .commandScope()
      .prefetched.prime([{ command: "get_projects", args: {}, snapshot: ["primed"] }]);
    const replacement = new FakeNodeClient({ nodeId: COMMAND }).respond("get_projects", ["new"]);
    resetWindowScopeForTests(replacement);
    await expect(invoke("get_projects", {})).resolves.toEqual(["new"]);
    expect(fake.invocations).toEqual([]);
  });

  test("another node's scope has its own client and cache", async () => {
    leafWindow = new WindowScope();
    const leafClient = new FakeNodeClient({ nodeId: LEAF }).respond("get_projects", ["leaf"]);
    const leaf = leafWindow.open({ role: "leaf", client: leafClient });
    getWindowScope()
      .commandScope()
      .prefetched.prime([{ command: "get_projects", args: {}, snapshot: ["primed"] }]);
    await expect(invokeInScope(leaf, "get_projects", {})).resolves.toEqual(["leaf"]);
    leaf.prefetched.prime([{ command: "get_kanban_tasks", args: {}, snapshot: ["leaf-primed"] }]);
    await expect(invokeInScope(leaf, "get_kanban_tasks", {})).resolves.toEqual(["leaf-primed"]);
    await expect(invoke("get_projects", {})).resolves.toEqual(["primed"]);
    expect(fake.invocations).toEqual([]);
    expect(leafClient.calls("get_projects")).toHaveLength(1);
  });
});

describe("listen through the command scope", () => {
  test("registers on the command client and stops with its unlisten", async () => {
    const handler = mock((_event: { payload: unknown }) => {});
    const unlisten = await listen("projects-changed", handler);
    expect(fake.listenerCount("projects-changed")).toBe(1);
    fake.emit("projects-changed", { id: "p1" });
    expect(handler).toHaveBeenCalledWith({ payload: { id: "p1" } });
    unlisten();
    expect(fake.listenerCount()).toBe(0);
    expect(directListen).not.toHaveBeenCalled();
  });

  test("an aborted listen leaves nothing registered", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      listen("projects-changed", () => {}, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(fake.listenerCount()).toBe(0);
  });

  test("an authoritative listen over the real listen subscribes both events on the command client", async () => {
    const onResync = mock(() => {});
    const stop = await listenAuthoritativeWith(listen, "projects-changed", () => {}, {
      onResync,
      resyncOnSubscribe: true,
    });
    expect(fake.listenerCount("projects-changed")).toBe(1);
    expect(fake.listenerCount("native-event-stream-connected")).toBe(1);
    fake.emit("native-event-stream-connected");
    await Promise.resolve();
    await Promise.resolve();
    expect(onResync).toHaveBeenCalledTimes(2);
    stop();
    expect(fake.listenerCount()).toBe(0);
  });
});

describe("the default command client", () => {
  test("is a view over window.orkestrator, read at each call", async () => {
    resetWindowScopeForTests();
    const viaGlobal = mock((command: string) => Promise.resolve({ via: "global", command }));
    window.orkestrator = { invoke: viaGlobal, listen: directListen } as unknown as Api;
    await expect(invoke("get_config")).resolves.toEqual({ via: "global", command: "get_config" });
    expect(viaGlobal).toHaveBeenCalledWith("get_config", undefined);
  });

  test("rejects as before when no host API is installed", async () => {
    resetWindowScopeForTests();
    window.orkestrator = undefined;
    await expect(invoke("get_config")).rejects.toThrow(
      "Orkestrator native backend is not available",
    );
  });
});

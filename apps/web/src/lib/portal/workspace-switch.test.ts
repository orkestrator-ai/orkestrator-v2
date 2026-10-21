import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  keepStoredWorkspaceAlive,
  recoverStoredWorkspace,
  switchWorkspace,
  takeSwitchSelection,
  takeWorkspaceStartupError,
} from "./workspace-switch";
import { readStoredWorkspace, writeStoredWorkspace } from "./workspace-target-storage";
import { WORKSPACE_RENEW_INTERVAL_MS, type LeafWorkspace } from "./workspaces";

const originalNative = window.orkestrator;
const invokeMock = invoke as ReturnType<typeof mock>;
const current: LeafWorkspace = {
  workspaceId: "old",
  nodeId: "bk_A" as never,
  nodeName: "A",
  path: "relay",
  baseUrl: "https://command.test/relay",
  expiresAt: Date.now() - 1,
};
const opened = {
  workspaceId: "new",
  nodeId: "bk_A",
  nodeName: "A",
  directOrigins: [],
  relayBase: "/relay",
  grant: { token: "short-lived", expiresAt: Date.now() + 900000 },
};
afterEach(() => {
  mock.restore();
  invokeMock.mockReset();
  window.orkestrator = originalNative;
  delete window.orkestratorPortal;
  sessionStorage.clear();
});

function browser() {
  window.orkestrator = undefined;
  delete window.orkestratorPortal;
  writeStoredWorkspace(current);
  return spyOn(window.location, "reload").mockImplementation(() => undefined);
}

test("desktop competing selection cannot overwrite or clear the accepted intent", async () => {
  let resolve!: () => void;
  const set = mock(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  window.orkestrator = { workspaceTarget: { set } } as never;
  const reload = spyOn(window.location, "reload").mockImplementation(() => undefined);
  const accepted = switchWorkspace("A", { projectId: "pA", environmentId: "eA" });
  await expect(switchWorkspace("B", { projectId: "pB" })).rejects.toThrow("in progress");
  resolve();
  await accepted;
  expect(takeSwitchSelection()).toEqual({ projectId: "pA", environmentId: "eA" });
  expect(set).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("expired startup opens immediately and failed recovery returns to command node with an outcome", async () => {
  const reload = browser();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "open_node_workspace") throw new Error("offline");
    return {};
  });
  expect(await recoverStoredWorkspace()).toBe(true);
  expect(invokeMock.mock.calls.some(([command]) => command === "open_node_workspace")).toBe(true);
  expect(readStoredWorkspace()).toBeNull();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(takeWorkspaceStartupError()).toContain("Returned to the command node");
  expect(takeWorkspaceStartupError()).toBeNull();
});

test("renewal and first reopen can fail then recover on the next bounded tick", async () => {
  const reload = browser();
  let clock = Date.now();
  spyOn(Date, "now").mockImplementation(() => clock);
  let tick!: () => void;
  spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
    tick = fn;
    return 123;
  }) as never);
  spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
  let opens = 0;
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "renew_node_workspace") throw new Error("lapsed");
    if (command === "open_node_workspace") {
      if (++opens === 1) throw new Error("offline");
      return opened;
    }
    return {};
  });
  const stop = keepStoredWorkspaceAlive();
  try {
    clock += WORKSPACE_RENEW_INTERVAL_MS;
    tick();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(opens).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    tick();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(opens).toBe(2);
    expect(readStoredWorkspace()?.workspaceId).toBe("new");
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

test("failed destination preserves storage; failed old grant close still reloads committed target", async () => {
  const reload = browser();
  let offline = true;
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "open_node_workspace") {
      if (offline) throw new Error("offline");
      return opened;
    }
    if (command === "close_node_workspace") throw new Error("close failed");
    return {};
  });
  await expect(switchWorkspace("B")).rejects.toThrow("offline");
  expect(readStoredWorkspace()).toEqual(current);
  expect(reload).not.toHaveBeenCalled();
  offline = false;
  await switchWorkspace("A");
  expect(readStoredWorkspace()?.workspaceId).toBe("new");
  expect(reload).toHaveBeenCalledTimes(1);
});

test("failed target persistence revokes only the new grant and leaves the current leaf usable", async () => {
  const reload = browser();
  invokeMock.mockImplementation(async (command: string) =>
    command === "open_node_workspace" ? opened : {},
  );
  const storage = window.sessionStorage;
  const descriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: (key: string, value: string) => {
        if (key === "orkestrator.workspace-target") throw new Error("storage full");
        storage.setItem(key, value);
      },
    },
  });
  try {
    await expect(switchWorkspace("B")).rejects.toThrow("Could not save");
    expect(readStoredWorkspace()).toEqual(current);
    expect(invokeMock.mock.calls).toContainEqual(["close_node_workspace", { workspaceId: "new" }]);
    expect(invokeMock.mock.calls).not.toContainEqual([
      "close_node_workspace",
      { workspaceId: "old" },
    ]);
    expect(reload).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(window, "sessionStorage", descriptor);
    else Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  }
});

test("expired startup succeeds before rendering; unexpired startup preserves the current grant", async () => {
  const reload = browser();
  invokeMock.mockImplementation(async (command: string) =>
    command === "open_node_workspace" ? opened : {},
  );
  expect(await recoverStoredWorkspace()).toBe(true);
  expect(readStoredWorkspace()?.workspaceId).toBe("new");
  expect(reload).toHaveBeenCalledTimes(1);
  invokeMock.mockClear();
  expect(await recoverStoredWorkspace()).toBe(false);
  expect(invokeMock).not.toHaveBeenCalled();
});

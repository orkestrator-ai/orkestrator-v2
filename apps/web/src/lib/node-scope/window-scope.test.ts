import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  COMMAND_SCOPE_PROVISIONAL_NODE_ID,
  getWindowScope,
  resetWindowScopeForTests,
} from "./app-window-scope";
import { defineScopedService } from "./scoped-service";
import { WindowScope } from "./window-scope";

const NODE_A = "bk_node-a" as BackendId;
const NODE_B = "bk_node-b" as BackendId;

const windows: WindowScope[] = [];
function openWindow(): WindowScope {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  return windowScope;
}

afterEach(() => {
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  resetWindowScopeForTests();
});

describe("WindowScope registry", () => {
  test("opens one scope per node and finds the command scope by role", () => {
    const windowScope = openWindow();
    const leaf = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });
    const command = windowScope.open({
      role: "command",
      client: new FakeNodeClient({ nodeId: NODE_A }),
    });
    expect(windowScope.commandScope()).toBe(command);
    expect(windowScope.get(NODE_B)).toBe(leaf);
    expect(windowScope.nodeScopes.get()).toEqual([leaf, command]);
  });

  test("refuses a second scope for a node and a second command scope", () => {
    const windowScope = openWindow();
    windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) });
    expect(() =>
      windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_A }) }),
    ).toThrow(/already open/);
    expect(() =>
      windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_B }) }),
    ).toThrow(/already has a command scope/);
  });

  test("commandScope() throws when the window has none", () => {
    expect(() => openWindow().commandScope()).toThrow(/no command scope/);
  });

  test("a disposed node scope leaves the registry and can be reopened", () => {
    const windowScope = openWindow();
    const seen: number[] = [];
    const stop = windowScope.nodeScopes.subscribe((scopes) => seen.push(scopes.length));
    const first = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: NODE_B }),
    });
    first.dispose();
    expect(windowScope.get(NODE_B)).toBeNull();
    const second = windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({ nodeId: NODE_B }),
    });
    expect(second).not.toBe(first);
    stop();
    expect(seen).toEqual([1, 0, 1]);
  });

  test("dispose ends every node scope and their services", () => {
    const windowScope = openWindow();
    const stopped: string[] = [];
    const service = defineScopedService("test-window-service", (scope) => ({
      stop: () => {
        stopped.push(scope.role);
      },
    }));
    const command = windowScope.open({
      role: "command",
      client: new FakeNodeClient({ nodeId: NODE_A }),
    });
    const leaf = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });
    command.service(service);
    leaf.service(service);

    windowScope.dispose();

    expect(stopped.sort()).toEqual(["command", "leaf"]);
    expect(command.disposed).toBe(true);
    expect(leaf.disposed).toBe(true);
    expect(windowScope.disposed).toBe(true);
    expect(() =>
      windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) }),
    ).toThrow(/disposed/);
  });

  test("holds a node-qualified selection", () => {
    const windowScope = openWindow();
    expect(windowScope.selection.get()).toBeNull();
    const selection = { nodeId: NODE_A, projectId: "p1", environmentId: null };
    windowScope.select(selection);
    expect(windowScope.selection.get()).toBe(selection);
  });
});

describe("the app window scope", () => {
  test("is created once, with a live command scope under the provisional id", () => {
    const windowScope = getWindowScope();
    expect(getWindowScope()).toBe(windowScope);
    const command = windowScope.commandScope();
    expect(command.role).toBe("command");
    expect(command.nodeId).toBe(COMMAND_SCOPE_PROVISIONAL_NODE_ID);
    expect(command.tier.get()).toBe("live");
  });

  test("reset disposes it and the next read builds a fresh one", () => {
    const first = getWindowScope();
    resetWindowScopeForTests();
    expect(first.disposed).toBe(true);
    expect(getWindowScope()).not.toBe(first);
  });
});

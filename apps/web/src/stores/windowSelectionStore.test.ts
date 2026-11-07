import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { uiStore } from "./uiStore";
import {
  bindWindowSelectionPersistence,
  isCommandNodeSelection,
  readStoredWindowSelection,
  selectionOnScope,
  windowSelectionPersistenceService,
} from "./windowSelectionStore";

const NODE_A = "bk_node-a" as BackendId;
const NODE_B = "bk_node-b" as BackendId;

const windows: WindowScope[] = [];
const stops: Array<() => void> = [];

/** A window as a fresh document opens it: a command scope, and a leaf. */
function openWindow() {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const command = windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: NODE_A }),
  });
  const leaf = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });
  return { windowScope, command, leaf };
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const windowScope of windows.splice(0)) windowScope.dispose();
  sessionStorage.clear();
  localStorage.clear();
});

describe("the window selection", () => {
  test("survives a reload of the window", () => {
    const first = openWindow();
    stops.push(bindWindowSelectionPersistence(first.windowScope, { restore: true }));
    first.command.store(uiStore).getState().selectProjectAndEnvironment("p-1", "env-1");
    first.windowScope.dispose();

    const reloaded = openWindow();
    stops.push(bindWindowSelectionPersistence(reloaded.windowScope, { restore: true }));
    expect(reloaded.windowScope.selection.get()).toMatchObject({
      nodeId: NODE_A,
      projectId: "p-1",
      environmentId: "env-1",
    });
    const ui = reloaded.command.store(uiStore).getState();
    expect(ui.selectedProjectId).toBe("p-1");
    expect(ui.selectedEnvironmentId).toBe("env-1");
    expect(reloaded.leaf.store(uiStore).getState().selectedProjectId).toBeNull();
  });

  test("keeps only the command node's selection; another node keeps its own", () => {
    const first = openWindow();
    stops.push(bindWindowSelectionPersistence(first.windowScope, { restore: true }));
    first.command.store(uiStore).getState().selectProject("p-1");
    expect(readStoredWindowSelection()).toEqual({ projectId: "p-1", environmentId: null });
    first.leaf.store(uiStore).getState().selectProjectAndEnvironment("p-b", "env-b");
    expect(readStoredWindowSelection()).toBeNull();
  });

  test("a restore never replaces what the window already selected", () => {
    sessionStorage.setItem(
      "orkestrator.window-selection.v1",
      JSON.stringify({ version: 1, projectId: "stale", environmentId: null }),
    );
    const { windowScope } = openWindow();
    windowScope.select({ nodeId: NODE_A, projectId: "linked", environmentId: null });
    stops.push(bindWindowSelectionPersistence(windowScope, { restore: true }));
    expect(windowScope.selection.get()?.projectId).toBe("linked");
  });

  test("a corrupt or oversized record is ignored", () => {
    for (const value of [
      "{",
      JSON.stringify({ version: 2, projectId: "p", environmentId: null }),
      JSON.stringify({ version: 1, projectId: "x".repeat(300), environmentId: null }),
      JSON.stringify({ version: 1, projectId: 7, environmentId: null }),
    ]) {
      sessionStorage.setItem("orkestrator.window-selection.v1", value);
      expect(readStoredWindowSelection()).toBeNull();
    }
  });

  test("the service restores once per document and runs only on the command scope", () => {
    const first = openWindow();
    first.command.store(uiStore).getState().selectProject("p-1");
    const handle = first.command.service(windowSelectionPersistenceService);
    expect(handle.status).toBe("running");
    first.command.store(uiStore).getState().selectProject("p-2");
    expect(readStoredWindowSelection()?.projectId).toBe("p-2");
    expect(first.leaf.service(windowSelectionPersistenceService).status).toBe("failed");
    handle.stop();
    // A second window scope in the same document does not restore.
    const second = openWindow();
    stops.push(() => second.command.service(windowSelectionPersistenceService).stop());
    second.command.service(windowSelectionPersistenceService);
    expect(second.windowScope.selection.get()).toBeNull();
  });

  test("is read against a node through the window's registry", () => {
    const { windowScope, command, leaf } = openWindow();
    const selection = { nodeId: NODE_B, projectId: "p", environmentId: "e" } as const;
    windowScope.select(selection);
    expect(selectionOnScope(leaf)).toEqual(selection);
    expect(selectionOnScope(command)).toBeNull();
    expect(isCommandNodeSelection(windowScope, selection)).toBe(false);
    expect(isCommandNodeSelection(windowScope, null)).toBe(true);
    // A node with no scope (yet) in this window: not the command node's.
    expect(
      isCommandNodeSelection(windowScope, {
        nodeId: "bk_unopened" as BackendId,
        projectId: null,
        environmentId: null,
      }),
    ).toBe(false);
  });
});

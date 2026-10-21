import { afterEach, describe, expect, test } from "bun:test";
import { desktopConnectionStorageKey, windowStorageKey } from "./desktop-storage-key";

afterEach(() => {
  localStorage.clear();
  delete window.orkestrator;
  delete window.orkestratorGateway;
});

describe("desktop connection storage keys", () => {
  test("keeps browser storage keys unchanged", () => {
    window.orkestratorGateway = { enabled: true, baseUrl: "https://desk.example" };
    expect(desktopConnectionStorageKey("ui-storage")).toBe("ui-storage");
  });

  test("separates local and remote state inside an Electron window", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    const local = desktopConnectionStorageKey("ui-storage");
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://desk.example",
    };
    const remote = desktopConnectionStorageKey("ui-storage");

    expect(local).toStartWith("ui-storage:desktop:");
    expect(remote).toStartWith("ui-storage:desktop:");
    expect(remote).not.toBe(local);
    expect(desktopConnectionStorageKey("ui-storage")).toBe(remote);
  });

  test("copies a legacy value into the first connection-specific key once", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    localStorage.setItem("ui-storage", '{"state":{"zoomLevel":120},"version":0}');

    const migratedKey = desktopConnectionStorageKey("ui-storage");
    expect(localStorage.getItem(migratedKey)).toBe('{"state":{"zoomLevel":120},"version":0}');

    localStorage.setItem(migratedKey, "newer-state");
    desktopConnectionStorageKey("ui-storage");
    expect(localStorage.getItem(migratedKey)).toBe("newer-state");

    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://desk.example",
    };
    const remoteKey = desktopConnectionStorageKey("ui-storage");
    expect(remoteKey).not.toBe(migratedKey);
    expect(localStorage.getItem(remoteKey)).toBeNull();
  });
});

describe("machine-identity storage keys", () => {
  afterEach(() => {
    delete window.orkestratorDesktopIdentity;
  });

  test("CL-02/MG-01: a verified machine keeps one namespace across routes and adopts its old one", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "https://desk.example" };
    const legacyKey = desktopConnectionStorageKey("ui-storage");
    localStorage.setItem(legacyKey, "remembered");

    window.orkestratorDesktopIdentity = {
      connectionId: "c1",
      backendId: "bk_desk",
      legacyOrigin: "https://desk.example",
    };
    const verifiedKey = desktopConnectionStorageKey("ui-storage");
    expect(verifiedKey).not.toBe(legacyKey);
    expect(localStorage.getItem(verifiedKey)).toBe("remembered");

    // Reached later over an SSH tunnel on an ephemeral port: same namespace.
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "http://127.0.0.1:49152" };
    expect(desktopConnectionStorageKey("ui-storage")).toBe(verifiedKey);
  });

  test("an unproved SSH-only machine is namespaced by its entry, never its port", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    window.orkestratorDesktopIdentity = {
      connectionId: "ssh-entry",
      backendId: null,
      legacyOrigin: null,
    };
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "http://127.0.0.1:41001" };
    const first = desktopConnectionStorageKey("ui-storage");
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "http://127.0.0.1:41002" };
    expect(desktopConnectionStorageKey("ui-storage")).toBe(first);
  });
});

describe("a workspace on another node", () => {
  afterEach(() => {
    delete window.orkestratorDesktopIdentity;
    delete window.orkestratorWorkspaceTarget;
  });

  test("ID-01: a browser tab on a leaf namespaces its state by that node; the page keeps its keys", () => {
    window.orkestrator = undefined;
    window.orkestratorWorkspaceTarget = { nodeId: "machine-b", nodeName: "B", path: "relay" };
    const leafKey = desktopConnectionStorageKey("pane-layout");
    window.orkestratorWorkspaceTarget = { nodeId: "machine-c", nodeName: "C", path: "relay" };
    const otherLeafKey = desktopConnectionStorageKey("pane-layout");
    delete window.orkestratorWorkspaceTarget;
    expect(leafKey).toStartWith("pane-layout:machine:");
    expect(otherLeafKey).not.toBe(leafKey);
    expect(desktopConnectionStorageKey("pane-layout")).toBe("pane-layout");
    // Window-level presentation stays with the page.
    window.orkestratorWorkspaceTarget = { nodeId: "machine-b", nodeName: "B", path: "relay" };
    expect(windowStorageKey("ui-storage")).toBe("ui-storage");
  });

  test("a desktop window keeps its own presentation while its workspace is on a leaf", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    window.orkestratorDesktopIdentity = {
      connectionId: "local",
      backendId: null,
      legacyOrigin: null,
    };
    const deskWindow = windowStorageKey("ui-storage");
    const deskWorkspace = desktopConnectionStorageKey("pane-layout");
    window.orkestratorDesktopIdentity = {
      connectionId: "workspace:w1",
      backendId: "bk_leaf",
      legacyOrigin: null,
      portal: { connectionId: "local", backendId: null, legacyOrigin: null },
    };
    expect(windowStorageKey("ui-storage")).toBe(deskWindow);
    expect(desktopConnectionStorageKey("pane-layout")).not.toBe(deskWorkspace);
  });
});

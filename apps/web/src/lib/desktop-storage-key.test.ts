import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  COMMAND_STORAGE_NODE,
  desktopConnectionStorageKey,
  type StorageNode,
} from "./desktop-storage-key";

afterEach(() => {
  localStorage.clear();
  delete window.orkestrator;
  delete window.orkestratorGateway;
});

describe("desktop connection storage keys", () => {
  test("keeps browser storage keys unchanged", () => {
    window.orkestratorGateway = { enabled: true, baseUrl: "https://desk.example" };
    expect(desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE)).toBe("ui-storage");
  });

  test("separates local and remote state inside an Electron window", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    const local = desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE);
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://desk.example",
    };
    const remote = desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE);

    expect(local).toStartWith("ui-storage:desktop:");
    expect(remote).toStartWith("ui-storage:desktop:");
    expect(remote).not.toBe(local);
    expect(desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE)).toBe(remote);
  });

  test("never copies an un-namespaced value: no published desktop wrote one", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    localStorage.setItem("ui-storage", '{"state":{"zoomLevel":120},"version":0}');

    const key = desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE);
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("ui-storage:desktop:migrated-v1")).toBeNull();
  });
});

describe("machine-identity storage keys", () => {
  afterEach(() => {
    delete window.orkestratorDesktopIdentity;
  });

  test("CL-02/MG-01: a verified machine keeps one namespace across routes and adopts its old one", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "https://desk.example" };
    const legacyKey = desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE);
    localStorage.setItem(legacyKey, "remembered");

    window.orkestratorDesktopIdentity = {
      connectionId: "c1",
      backendId: "bk_desk",
      legacyOrigin: "https://desk.example",
    };
    const verifiedKey = desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE);
    expect(verifiedKey).not.toBe(legacyKey);
    expect(localStorage.getItem(verifiedKey)).toBe("remembered");

    // Reached later over an SSH tunnel on an ephemeral port: same namespace.
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "http://127.0.0.1:49152" };
    expect(desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE)).toBe(verifiedKey);
  });

  test("an unproved SSH-only machine is namespaced by its entry, never its port", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    window.orkestratorDesktopIdentity = {
      connectionId: "ssh-entry",
      backendId: null,
      legacyOrigin: null,
    };
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "http://127.0.0.1:41001" };
    const first = desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE);
    window.orkestratorGateway = { enabled: true, desktop: true, baseUrl: "http://127.0.0.1:41002" };
    expect(desktopConnectionStorageKey("ui-storage", COMMAND_STORAGE_NODE)).toBe(first);
  });
});

describe("keys take a node (plan item 3015)", () => {
  const leaf = (nodeId: string): StorageNode => ({ nodeId: nodeId as BackendId, role: "leaf" });

  afterEach(() => {
    delete window.orkestratorDesktopIdentity;
  });

  test("the command node's key is the key this renderer used before keys took a node", () => {
    window.orkestrator = undefined;
    expect(desktopConnectionStorageKey("pane-layout", COMMAND_STORAGE_NODE)).toBe("pane-layout");
    // A command scope's own id, provisional or proven, never changes its key.
    const proven: StorageNode = { nodeId: "bk_command" as BackendId, role: "command" };
    expect(desktopConnectionStorageKey("pane-layout", proven)).toBe("pane-layout");

    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    window.orkestratorDesktopIdentity = {
      connectionId: "local",
      backendId: null,
      legacyOrigin: null,
    };
    const desktop = desktopConnectionStorageKey("pane-layout", COMMAND_STORAGE_NODE);
    expect(desktop).toStartWith("pane-layout:desktop:");
    expect(desktopConnectionStorageKey("pane-layout", proven)).toBe(desktop);
  });

  test("a leaf's key is the per-node form earlier browser releases wrote, on every host", () => {
    window.orkestrator = undefined;
    const leafKey = desktopConnectionStorageKey("pane-layout", leaf("bk_leaf-b"));
    expect(leafKey).toStartWith("pane-layout:machine:");
    expect(desktopConnectionStorageKey("pane-layout", leaf("bk_leaf-c"))).not.toBe(leafKey);
    // The same form inside a desktop window: per-node partitions are abandoned (13.7 A).
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    expect(desktopConnectionStorageKey("pane-layout", leaf("bk_leaf-b"))).toBe(leafKey);
  });

  test("a leaf never adopts the command node's legacy un-namespaced value", () => {
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];
    localStorage.setItem("ui-storage", "command state");
    const leafKey = desktopConnectionStorageKey("ui-storage", leaf("bk_leaf-b"));
    expect(localStorage.getItem(leafKey)).toBeNull();
  });
});

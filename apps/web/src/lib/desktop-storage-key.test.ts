import { afterEach, describe, expect, test } from "bun:test";
import { desktopConnectionStorageKey } from "./desktop-storage-key";

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

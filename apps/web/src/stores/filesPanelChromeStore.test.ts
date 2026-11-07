import { afterEach, expect, test } from "bun:test";
import { windowStorageKey } from "@/lib/desktop-storage-key";
import {
  FILES_PANEL_DEFAULT_WIDTH_PX,
  legacyFilesPanelWidth,
  useFilesPanelChromeStore,
} from "./filesPanelChromeStore";

afterEach(() => {
  localStorage.clear();
  useFilesPanelChromeStore.setState({ isOpen: false, panelWidth: FILES_PANEL_DEFAULT_WIDTH_PX });
});

test("the window keeps its width, not whether the panel is open", () => {
  useFilesPanelChromeStore.getState().openPanel();
  useFilesPanelChromeStore.getState().setPanelWidth(480);
  const stored = JSON.parse(localStorage.getItem(windowStorageKey("files-panel-chrome"))!);
  expect(stored.state).toEqual({ panelWidth: 480 });
});

test("a stored width is restored only when it is a plausible width", async () => {
  const key = windowStorageKey("files-panel-chrome");
  for (const [panelWidth, expected] of [
    [512, 512],
    ["512", FILES_PANEL_DEFAULT_WIDTH_PX],
    [-1, FILES_PANEL_DEFAULT_WIDTH_PX],
    [Number.MAX_SAFE_INTEGER, FILES_PANEL_DEFAULT_WIDTH_PX],
  ] as const) {
    useFilesPanelChromeStore.setState({ panelWidth: FILES_PANEL_DEFAULT_WIDTH_PX });
    localStorage.setItem(key, JSON.stringify({ state: { panelWidth }, version: 0 }));
    await useFilesPanelChromeStore.persist.rehydrate();
    expect(useFilesPanelChromeStore.getState().panelWidth).toBe(expected);
  }
});

test("the width from before the split is read from the command node's files panel key", () => {
  expect(legacyFilesPanelWidth()).toBeNull();
  localStorage.setItem(
    "files-panel-storage",
    JSON.stringify({ state: { panelWidth: 400, expandedFolders: [] }, version: 0 }),
  );
  expect(legacyFilesPanelWidth()).toBe(400);
  localStorage.setItem("files-panel-storage", JSON.stringify({ state: { panelWidth: "wide" } }));
  expect(legacyFilesPanelWidth()).toBeNull();
  localStorage.setItem("files-panel-storage", "{not json");
  expect(legacyFilesPanelWidth()).toBeNull();
});

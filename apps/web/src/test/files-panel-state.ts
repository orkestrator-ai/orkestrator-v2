/**
 * Test helpers for the files panel, whose state is split (plan item 3007):
 * the open state and width are the window's (`filesPanelChromeStore`), and
 * everything else is the node's (`filesPanelStore`). Test-only.
 */

import type { StoreApi } from "zustand/vanilla";
import {
  useFilesPanelChromeStore,
  type FilesPanelChromeState,
} from "@/stores/filesPanelChromeStore";
import { filesPanelStore, type FilesPanelState } from "@/stores/filesPanelStore";
import { appCommandStore } from "./app-command-store";

type ChromeFields = Pick<FilesPanelChromeState, "isOpen" | "panelWidth">;

export type FilesPanelTestState = FilesPanelState & ChromeFields;

/**
 * Sets the window's chrome fields and the node's panel fields of `partial`.
 * The node's are the app command scope's unless `store` names another
 * instance (`scope.store(filesPanelStore)`).
 */
export function setFilesPanelTestState(
  partial: Partial<FilesPanelTestState>,
  store?: StoreApi<FilesPanelState>,
): void {
  const { isOpen, panelWidth, ...node } = partial;
  const chrome: Partial<ChromeFields> = {};
  if (isOpen !== undefined) chrome.isOpen = isOpen;
  if (panelWidth !== undefined) chrome.panelWidth = panelWidth;
  if (Object.keys(chrome).length > 0) useFilesPanelChromeStore.setState(chrome);
  if (Object.keys(node).length > 0) (store ?? appCommandStore(filesPanelStore)).setState(node);
}

/** The window's chrome fields together with the node's panel state. */
export function filesPanelTestState(store?: StoreApi<FilesPanelState>): FilesPanelTestState {
  const chrome = useFilesPanelChromeStore.getState();
  return {
    ...(store ?? appCommandStore(filesPanelStore)).getState(),
    isOpen: chrome.isOpen,
    panelWidth: chrome.panelWidth,
  };
}

// Test setup file for Bun
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register happy-dom globals for React testing
GlobalRegistrator.register();

// Mock @tauri-apps/api modules
import { mock } from "bun:test";

// Mock the core invoke function and Resource class
mock.module("@tauri-apps/api/core", () => ({
  invoke: mock(() => Promise.resolve()),
  Resource: class Resource {
    close() { return Promise.resolve(); }
  },
}));

// Mock the event listener
mock.module("@tauri-apps/api/event", () => ({
  listen: mock(() => Promise.resolve(() => {})),
  emit: mock(() => Promise.resolve()),
}));

// --- Centralised mocks for modules used by multiple test files ---
// Registering these once here prevents conflicting mock.module() calls
// across test files from polluting the Bun module cache.

import { mockReadImage, mockReadText, mockWriteText } from "./mocks/clipboard";

// Mock clipboard plugin (used by PersistentTerminal, useClipboardImagePaste, terminal-paste tests)
mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  readImage: mockReadImage,
  readText: mockReadText,
  writeText: mockWriteText,
}));

// NOTE: @/hooks/useClipboardImagePaste is NOT mocked here because
// useClipboardImagePaste.test.ts needs to import the real module.
// Tests that need it mocked (terminal-paste.test.ts) do so per-file.

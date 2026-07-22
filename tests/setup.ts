// Test setup file for Bun
import { GlobalRegistrator } from "@happy-dom/global-registrator";

process.env.CODEX_BRIDGE_NO_SERVER ??= "1";

// Register happy-dom globals for React testing
GlobalRegistrator.register();

// Mock native backend modules
import { beforeEach, mock } from "bun:test";

// Mock the command invoke function.
mock.module("@/lib/native/backend", () => ({
  invoke: mock(() => Promise.resolve()),
}));

// Mock the event listener
mock.module("@/lib/native/events", () => ({
  listen: mock(() => Promise.resolve(() => {})),
  emit: mock(() => Promise.resolve()),
}));

// --- Centralised mocks for modules used by multiple test files ---
// Registering these once here prevents conflicting mock.module() calls
// across test files from polluting the Bun module cache.

import { mockReadImage, mockReadText, mockWriteText } from "./mocks/clipboard";
import {
  mockToast,
  mockToastCustom,
  mockToastDismiss,
  mockToastError,
  mockToastInfo,
  mockToastLoading,
  mockToastPromise,
  mockToastSuccess,
  mockToastWarning,
  resetSonnerMocks,
} from "./mocks/sonner";
import * as realSonner from "../apps/web/node_modules/sonner";

// Mock clipboard plugin (used by PersistentTerminal, useClipboardImagePaste, terminal-paste tests)
mock.module("@/lib/native/clipboard", () => ({
  readImage: mockReadImage,
  readText: mockReadText,
  writeText: mockWriteText,
}));

// Sonner is imported throughout the app, so test-local module replacements can
// leak into unrelated suites through Bun's global module cache. Keep one stable
// module shape and share its spy functions with tests that need assertions.
mock.module("sonner", () => ({
  ...realSonner,
  toast: Object.assign(mockToast, realSonner.toast, {
    success: mockToastSuccess,
    error: mockToastError,
    info: mockToastInfo,
    warning: mockToastWarning,
    loading: mockToastLoading,
    custom: mockToastCustom,
    promise: mockToastPromise,
    dismiss: mockToastDismiss,
  }),
}));

beforeEach(resetSonnerMocks);

// NOTE: @/hooks/useClipboardImagePaste is NOT mocked here because
// useClipboardImagePaste.test.ts needs to import the real module.
// Tests that need it mocked (terminal-paste.test.ts) do so per-file.

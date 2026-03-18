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

import { defineConfig } from "@playwright/test";
import { HEADLESS_CAPABLE_ELECTRON_SPECS } from "./electron-launch-switches";
import electron from "./playwright.electron.config";

// Only these specs implement the explicit headless opt-in everywhere they launch.
export default defineConfig(electron, { testMatch: [...HEADLESS_CAPABLE_ELECTRON_SPECS] });

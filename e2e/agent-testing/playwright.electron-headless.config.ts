import { defineConfig } from "@playwright/test";
import electron from "./playwright.electron.config";

// Only this journey implements the explicit headless opt-in.
export default defineConfig(electron, { testMatch: ["design-canvas-electron.spec.ts"] });

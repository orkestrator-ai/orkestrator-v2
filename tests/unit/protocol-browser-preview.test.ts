import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
  BrowserPreviewOpenLinkEvent,
  BrowserPreviewState,
} from "@orkestrator/protocol/browser-preview";

describe("browser preview protocol contract", () => {
  test("publishes the browser-preview workspace export", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "packages/protocol/package.json"), "utf8"),
    ) as { exports: Record<string, string> };

    expect(packageJson.exports["./browser-preview"]).toBe("./src/browser-preview.ts");
    expect(
      Bun.resolveSync(
        "@orkestrator/protocol/browser-preview",
        path.join(process.cwd(), "apps/desktop"),
      ),
    ).toBe(path.join(process.cwd(), "packages/protocol/src/browser-preview.ts"));
  });

  test("keeps attachment bounds and state fields aligned", () => {
    const bounds = {
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    } satisfies BrowserPreviewBounds;
    const input = {
      tabId: "browser-1",
      service: {
        backendInstanceId: "backend-1",
        environmentId: "env-1",
        serviceId: "web",
        path: "/",
      },
      bounds,
      visible: true,
    } satisfies BrowserPreviewAttachInput;
    const state = {
      tabId: input.tabId,
      url: "http://localhost:3000/",
      loading: false,
      canGoBack: false,
      canGoForward: true,
      error: null,
    } satisfies BrowserPreviewState;
    const openLinkEvent = {
      tabId: input.tabId,
      url: "http://localhost:3000/docs",
      service: { ...input.service, path: "/docs" },
    } satisfies BrowserPreviewOpenLinkEvent;

    expect(input.bounds).toEqual(bounds);
    expect(state).toMatchObject({ tabId: "browser-1", canGoForward: true, error: null });
    expect(openLinkEvent).toEqual({
      tabId: "browser-1",
      url: "http://localhost:3000/docs",
      service: {
        backendInstanceId: "backend-1",
        environmentId: "env-1",
        serviceId: "web",
        path: "/docs",
      },
    });
  });
});

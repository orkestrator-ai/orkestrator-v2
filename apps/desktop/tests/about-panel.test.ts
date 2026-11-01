import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABOUT_PANEL_ICON_RESOURCE,
  aboutPanelIconPath,
  aboutPanelOptions,
} from "../electron/about-panel";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(desktopRoot, "..", "..");

describe("About panel", () => {
  test("passes the product name, version and icon", () => {
    expect(
      aboutPanelOptions({
        productName: "Orkestrator AI",
        version: "2.34.5-beta",
        iconPath: "/opt/orkestrator/resources/icon.png",
      }),
    ).toEqual({
      applicationName: "Orkestrator AI",
      applicationVersion: "2.34.5-beta",
      version: "2.34.5-beta",
      iconPath: "/opt/orkestrator/resources/icon.png",
    });
  });

  test("a packaged app reads the icon from its resources directory", () => {
    expect(
      aboutPanelIconPath({
        isPackaged: true,
        resourcesPath: "/opt/orkestrator/resources",
        dirname: "/opt/orkestrator/resources/app.asar/apps/desktop/dist/electron",
      }),
    ).toBe(path.join("/opt/orkestrator/resources", "icon.png"));
  });

  test("an unpackaged run reads the source icon next to the emitted bundle", () => {
    const iconPath = aboutPanelIconPath({
      isPackaged: false,
      resourcesPath: "/repo/node_modules/electron/dist/resources",
      dirname: path.join(desktopRoot, "dist", "electron"),
    });
    expect(iconPath).toBe(path.join(desktopRoot, "electron", "resources", "icon.png"));
    expect(existsSync(iconPath)).toBe(true);
  });

  test("packaging copies the same icon to the resource name the packaged app reads", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as {
      build: { extraResources: Array<{ from: string; to: string }> };
    };
    const entry = manifest.build.extraResources.find(
      (resource) => resource.to === ABOUT_PANEL_ICON_RESOURCE,
    );
    expect(entry?.from).toBe("apps/desktop/electron/resources/icon.png");
    expect(existsSync(path.join(repositoryRoot, entry!.from))).toBe(true);
  });
});

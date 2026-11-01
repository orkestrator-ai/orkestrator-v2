import type { AboutPanelOptionsOptions } from "electron";
import path from "node:path";

/**
 * The icon's file name under a packaged app's resources directory. The root
 * `package.json` `build.extraResources` copies
 * `apps/desktop/electron/resources/icon.png` there: electron-builder's
 * `build.linux.icon` only installs the desktop entry's icons, and nothing
 * under `buildResources` reaches the app itself.
 */
export const ABOUT_PANEL_ICON_RESOURCE = "icon.png";

/**
 * Where the About panel's icon is. An unpackaged run (the dev launcher, or an
 * Electron spec starting `apps/desktop/dist/electron/main.js`) reads the
 * source file next to the emitted bundle rather than Electron's own
 * resources directory, which holds no Orkestrator icon.
 */
export function aboutPanelIconPath(options: {
  isPackaged: boolean;
  resourcesPath: string;
  /** The emitted main bundle's directory, `apps/desktop/dist/electron`. */
  dirname: string;
}): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, ABOUT_PANEL_ICON_RESOURCE)
    : path.resolve(options.dirname, "..", "..", "electron", "resources", ABOUT_PANEL_ICON_RESOURCE);
}

/**
 * What Help › About (Windows, Linux) and the app menu's About (macOS) show.
 *
 * Without these, Electron's Linux panel falls back to GTK's program name (the
 * executable, `orkestrator-v2`), with no version and a missing-image icon.
 * `version` is the build number macOS shows in brackets; an unpackaged macOS
 * run would otherwise show Electron's own release there. `iconPath` is read
 * on Linux and Windows only; macOS uses the bundle's icon.
 */
export function aboutPanelOptions(options: {
  productName: string;
  version: string;
  iconPath: string;
}): AboutPanelOptionsOptions {
  return {
    applicationName: options.productName,
    applicationVersion: options.version,
    version: options.version,
    iconPath: options.iconPath,
  };
}

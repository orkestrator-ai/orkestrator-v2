import type { App } from "electron";
import desktopPackage from "../package.json" with { type: "json" };

/**
 * This package's manifest version. `scripts/set-version.ts` writes the same
 * Orkestrator version into every manifest, including the web package the
 * renderer compares the backend against.
 */
export const DESKTOP_PACKAGE_VERSION: string = desktopPackage.version;

/**
 * The Orkestrator version this desktop process runs, as the backend should
 * advertise it.
 *
 * A packaged app's `app.getVersion()` is the application's own version. The
 * dev launcher (`scripts/dev/lifecycle.ts`) starts Electron on a script file
 * rather than an application directory, so Electron finds no application
 * manifest and reports its own release (44.x, 45.x); exported as
 * `ORKESTRATOR_VERSION`, every dev browser then announced a server update to
 * that version. Starting Electron on a directory instead would also change
 * the application name it derives from that manifest.
 */
export function desktopApplicationVersion(
  app: Pick<App, "isPackaged" | "getVersion">,
  packageVersion: string = DESKTOP_PACKAGE_VERSION,
): string {
  return app.isPackaged ? app.getVersion() : packageVersion;
}

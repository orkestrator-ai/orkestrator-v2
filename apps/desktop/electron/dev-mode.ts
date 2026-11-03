import type { App } from "electron";

/**
 * Whether this desktop process runs in development mode, and the Vite dev
 * server its trusted renderer loads from when it does.
 *
 * Development mode loads the renderer from `VITE_DEV_SERVER_URL` and gives
 * that page the privileged preload bridge. A packaged app never honours it:
 * otherwise anyone able to set two environment variables on a launch could
 * make an installed app load a remote page as its trusted renderer (security
 * report finding L4). The dev launcher (`scripts/dev/lifecycle.ts`) and the
 * Electron specs start Electron on the unpacked bundle, which is never
 * packaged, so they keep working.
 */
export type DesktopDevMode = {
  isDev: boolean;
  /** Set only in development mode; a packaged app never reads it. */
  devServerUrl: string | undefined;
  /** A packaged app was launched with `ELECTRON_DEV=1` and ignored it. */
  ignoredDevRequest: boolean;
};

export function desktopDevMode(
  app: Pick<App, "isPackaged">,
  env: NodeJS.ProcessEnv = process.env,
): DesktopDevMode {
  const requested = env.ELECTRON_DEV === "1";
  const isDev = requested && !app.isPackaged;
  return {
    isDev,
    devServerUrl: isDev ? env.VITE_DEV_SERVER_URL : undefined,
    ignoredDevRequest: requested && app.isPackaged,
  };
}

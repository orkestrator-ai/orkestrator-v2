export const APP_SLUG = "orkestrator-v2";
export const PRODUCT_NAME = "Orkestrator AI";
export const LINUX_DESKTOP_ENTRY_FILENAME = `${APP_SLUG}.desktop`;

/**
 * Directory name under Electron's appData path.
 *
 * Dev uses a suffix so `bun run dev` can run next to a packaged install
 * without sharing storage or the single-instance lock.
 */
export const userDataDirectoryName = (isDev: boolean): string =>
  isDev ? `${APP_SLUG}-dev` : APP_SLUG;

export const APP_SLUG = "orkestrator-v2";
export const PRODUCT_NAME = "Orkestrator AI";
export const LINUX_DESKTOP_ENTRY_FILENAME = `${APP_SLUG}.desktop`;

/** The GitHub repository the desktop app updates from and publishes releases to. */
export const GITHUB_REPOSITORY = { owner: "orkestrator-ai", repo: "orkestrator-v2" } as const;
/** The project's release notes, opened from Help → Release Notes. */
export const RELEASE_NOTES_URL = `https://github.com/${GITHUB_REPOSITORY.owner}/${GITHUB_REPOSITORY.repo}/releases`;

/**
 * Directory name under Electron's appData path.
 *
 * Dev uses a suffix so `mise run dev` can run next to a packaged install
 * without sharing storage or the single-instance lock.
 */
export const userDataDirectoryName = (isDev: boolean): string =>
  isDev ? `${APP_SLUG}-dev` : APP_SLUG;

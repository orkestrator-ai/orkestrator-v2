/**
 * Chromium switches every Electron spec launches with, before the entrypoint.
 *
 * `--use-mock-keychain` (macOS): `safeStorage` otherwise uses the login
 * keychain item "<app name> Safe Storage", and the app name is the profile's
 * `electronTitle`. The specs use fixed profile ids, so every worktree shares
 * one item per spec, and its access list names the Electron binary that
 * created it. Electron from any other worktree then waits on a keychain access
 * prompt that nobody answers. Main awaits `isAsyncEncryptionAvailable()`
 * (`ConnectionManager.initialize`) before it creates the first window, so
 * startup hangs with no window and no error. The mock keychain keeps the specs
 * off the host keychain entirely, and `safeStorage` still round-trips.
 */
export const ELECTRON_TEST_SWITCHES: readonly string[] =
  process.platform === "darwin" ? ["--use-mock-keychain"] : [];

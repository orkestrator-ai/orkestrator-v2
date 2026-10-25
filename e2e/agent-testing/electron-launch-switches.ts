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
 *
 * The three background switches: the specs run on a desktop shared with other
 * worktrees' windows, which can cover this one. Chromium then treats the
 * window as occluded and throttles its renderer timers, and UI libraries move
 * keyboard focus in timers (Radix menus' roving focus), so a test reads stale
 * focus or a dialog opens late (flake 0620,
 * docs/tests/flaky-tests/previews-annotations-and-gateway/). A user never
 * types into a covered window, so turning the throttling off changes nothing
 * a test asserts about real use. They apply on every platform.
 */
const BACKGROUND_THROTTLING_SWITCHES = [
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
] as const;

export const ELECTRON_TEST_SWITCHES: readonly string[] = [
  ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
  ...BACKGROUND_THROTTLING_SWITCHES,
];

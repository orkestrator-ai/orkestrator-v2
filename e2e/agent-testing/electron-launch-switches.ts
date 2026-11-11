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

/**
 * The switches and environment that start Electron with no display on Linux,
 * as `dev:test --headless` does. Playwright drives the page over CDP, which
 * needs no display.
 */
export {
  HEADLESS_ELECTRON_SWITCHES,
  withoutDisplay,
} from "../../apps/desktop/electron/runtime-profile";

/**
 * Whether a spec that supports it should launch Electron headless: Linux with
 * `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`. `dev:test`'s own
 * `ORKESTRATOR_AGENT_TEST_HEADLESS` and its no-terminal default deliberately do
 * not apply: these specs launch their own Electron and most assert on a real
 * window, so a variable meant for a profile must not take theirs away.
 */
export function headlessElectronRequested(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === "linux" && env.ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON === "1";
}

/**
 * The specs that honour `headlessElectronRequested()` everywhere they launch
 * Electron and pass without a display. `playwright.electron-headless.config.ts`
 * runs exactly these, and only a run limited to them may start with no display.
 */
export const HEADLESS_CAPABLE_ELECTRON_SPECS: readonly string[] = [
  "design-canvas-electron.spec.ts",
  "electron-cleanup.spec.ts",
  "web-annotations-electron.spec.ts",
  // Launches through `service-preview-electron-launch.ts`, which honours the
  // opt-in. Its Linux runs (through `ss` and `lsof`) are in 0042's evidence log.
  "service-preview-seeded-electron.spec.ts",
  // Terminal snapshot owners of `terminalVisibleText`. Both passed headless on
  // Linux on 2026-11-11 (to-do 7340, retired; its record is in 2181 task 3).
  "terminal-input-resume-electron.spec.ts",
  "local-gateway-transport-electron.spec.ts",
];

/**
 * What `playwright.electron.config.ts` needs and this host lacks, or `null`.
 * Without a display Electron exits at launch and every spec reports a launch
 * timeout that names nothing, so the run says it up front.
 */
export function electronSpecDisplayProblem(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  headlessOnly = false,
): string | null {
  if (platform !== "linux" || env.DISPLAY || env.WAYLAND_DISPLAY) return null;
  if (headlessOnly && headlessElectronRequested(platform, env)) return null;
  return [
    "The Electron specs open a real window, and this run has neither DISPLAY nor WAYLAND_DISPLAY.",
    "Give them a disposable display: xvfb-run -a mise run test:agent:electron.",
    "dev:test --headless does not apply to them; they launch their own Electron.",
    `For a headless run of ${HEADLESS_CAPABLE_ELECTRON_SPECS.join(" or ")}, set ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1 and use playwright.electron-headless.config.ts.`,
  ].join("\n");
}

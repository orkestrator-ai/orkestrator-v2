# Two Electron specs fail every time on mbp3's macOS display

## Task analysis

Analysed 2026-11-15 against `main` at `0cc406750`. Found while working to-do
7062 (retired) on mbp3's own display: the full `mise run test:agent:electron`
run passed 66 of 85 cases and skipped 15. Two of its four failures failed
again when their spec was rerun alone. The other two passed alone and are
flakes [9800](../../tests/flaky-tests/electron-and-desktop/9800-terminal-resume-vite-start-settypeofservice.md)
and [9801](../../tests/flaky-tests/previews-annotations-and-gateway/9801-seeded-preview-check-2-b-preview-not-visible.md).

### Tasks

1. **Find why the renderer permission spec hangs on a macOS display**:
   `real renderer sessions grant writes/fullscreen and deny other permissions and subframes`
   times out. Status: open.
2. **Find why the remote terminal link case cannot connect on mbp3**:
   `a remote terminal link opens the native localhost forward in a separate browser`
   fails with `Failed to fetch`. Status: open.

### 1. Find why the renderer permission spec hangs on a macOS display

**Problem.** `e2e/agent-testing/renderer-permissions-electron.spec.ts:14`
reached the test's 120 s timeout in the full suite and again alone, so the
real permission policy (`apps/desktop/electron/renderer-permissions.ts`) is
not being checked on macOS.

**Context.** The spec opens two windows on their own sessions, installs the
real policy and runs one in-page script per window. The script writes to the
clipboard, enters and leaves fullscreen, queries geolocation and notification
permissions, and tries a clipboard write from a subframe. It does not use
`watchElectronStartup`: its page is a `file:` fixture, which Vite does not
serve.

**Investigation.** Run 2026-11-15 on mbp3 (macOS 27.2, Electron 45.2.3,
Playwright 1.65.0, one worker):

- full suite: timed out (120 s);
- `ORKESTRATOR_AGENT_TEST_RUN_ID=7062-rerun-renderer-permissions-electron mise run test:logged -- --name rerun-renderer-permissions-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts renderer-permissions-electron.spec.ts`:
  timed out again.

Both windows were found: the trace's last action is the in-page `Evaluate`,
so one of the script's awaits never settles. Which one was not established.
On a real macOS display `requestFullscreen()` moves the window into its own
Space with an animation, and `exitFullscreen()` called before that finishes
is a plausible stall, but that is a hypothesis. A rejected clipboard write
(an unfocused document) would throw rather than hang.

**Decisions.**

- **How to find the stalled step?**
  - **Time each await separately (one `executeJavaScript` per step, each with
    its own timeout) on a macOS display (recommended).**
    - Pros: names the step in the failure message from then on; changes no
      assertion.
    - Cons: more round trips.
  - **Skip the fullscreen step on macOS.**
    - Pros: quick.
    - Cons: drops coverage on a guess, and the guess is not confirmed.

### 2. Find why the remote terminal link case cannot connect on mbp3

**Problem.** `e2e/agent-testing/service-preview-electron.spec.ts:3140`
failed in the full suite (7.8 s) and again alone, so the desktop's native
localhost forward for a remote terminal link is not being checked on macOS.

**Context.** The case opens a second window, connects it to a second backend
("External preview") through `orkestrator.connections.connect`, then drives a
terminal link. The other 22 cases of the same spec passed in the same run.
It was fixed once for a different failure, flake
[2390](../../tests/flaky-tests/previews-annotations-and-gateway/2390-remote-terminal-link-hover-new-window.md).

**Investigation.** Run 2026-11-15 on mbp3:

- full suite: `Error: page.evaluate: TypeError: Failed to fetch` at
  `invokeImmediately` (`apps/web/src/lib/native/node-transport.ts:975`),
  inside one of the second window's `page.evaluate` calls;
- `ORKESTRATOR_AGENT_TEST_RUN_ID=7062-rerun-service-preview mise run test:logged -- --name rerun-service-preview -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-electron.spec.ts -g "a remote terminal link opens the native localhost forward"`:
  failed the same way. The rerun selected the one case, not the whole file.

Which invoke failed, and whether the remote backend was listening at that
moment, was not established. It is not known whether this case passes on
`main` on another macOS host.

**Decisions.**

- **Where to start?**
  - **Record the failing invoke's command name and the remote backend's
    address and readiness in the case's failure message, then rerun on
    mbp3 (recommended).**
    - Pros: separates "the remote backend was not up" from "the window's
      transport refused the request".
    - Cons: one more run before a fix.
  - **Run the case on `main` on another macOS host first.**
    - Pros: tells whether mbp3 or the branch is the variable.
    - Cons: needs a second Mac with a display.

## Current state

Both cases fail deterministically on mbp3's display. Nothing in to-do 7062's
change reaches them: it added `startup-recovery-electron.spec.ts` and one
line to the Electron config's spec list.

## Related

- [agent-testing.md](../../development/agent-testing.md#electron-specs-and-their-display),
  which describes how the Electron specs run and what they need.
- [9800](../../tests/flaky-tests/electron-and-desktop/9800-terminal-resume-vite-start-settypeofservice.md)
  and [9801](../../tests/flaky-tests/previews-annotations-and-gateway/9801-seeded-preview-check-2-b-preview-not-visible.md),
  the flakes from the same run.

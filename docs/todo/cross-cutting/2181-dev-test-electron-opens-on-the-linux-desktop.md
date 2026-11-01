# `dev:test` opens its Electron window on the Linux desktop

Found on 2026-11-01 while running
[0048](../transcripts-and-observation/0048-recurring-work-qualification.md)
tasks 3 and 4 on a Linux workstation (Hyprland, Wayland).

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfba`.

### Tasks

1. **A headless mode for agent-test Electron**: an agent run of `dev:test` on a Linux desktop puts a window on the user's live session. Status: open.

### 1. A headless mode for agent-test Electron

**Problem.** `dev:test` always spawns Electron with the caller's environment (`apps/desktop/scripts/dev/lifecycle.ts`, the `electron` spawn). On a Linux host with `DISPLAY` or `WAYLAND_DISPLAY` set, an agent's disposable profile opens a real window on the user's desktop, takes focus and can receive the user's keystrokes. Several concurrent builds do this at once on a shared workstation.

**Context.** The browser suites drive the gateway with their own headless Chromium; they need Electron only to own the backend and announce readiness. `chromiumSwitchesForRuntime` (`apps/desktop/electron/runtime-profile.ts`) adds switches per flavour but none for headless.

**Investigation.** 0048's run used a workaround outside the repository: `ELECTRON_OVERRIDE_DIST_PATH` pointing at a directory whose `electron` script unsets `DISPLAY` and `WAYLAND_DISPLAY` and execs the real binary with `--ozone-platform=headless`, plus `env -u DISPLAY -u WAYLAND_DISPLAY` around `mise run dev:test`. Electron 45 started, reported ready, and served both browser specs; no window appeared. Not checked: the Electron-only specs (`playwright.electron.config.ts`), which need a real window.

**Decisions.**

- **How should an agent-test profile avoid the desktop?**
  - **A `dev:test --headless` flag (default on when no TTY or when `ORKESTRATOR_AGENT_TEST_HEADLESS=1`) that clears the display variables and adds `--ozone-platform=headless` on Linux (recommended).**
    - Pros: explicit and testable; the one-shot isolated runners can always pass it.
    - Cons: Electron-window specs still need a display (Xvfb or a nested compositor), so the flag must stay off for them.
  - **Document the wrapper workaround.**
    - Pros: no code.
    - Cons: every agent has to rediscover it, and a missed step opens the window anyway.

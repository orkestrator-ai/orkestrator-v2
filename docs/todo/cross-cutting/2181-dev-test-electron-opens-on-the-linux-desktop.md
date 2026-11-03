# `dev:test` opens its Electron window on the Linux desktop

## Task analysis

Analysed 2026-11-01 against `main` at `93b99bfba`. Acted on 2026-11-03 against
`main` at `4d9ff8690`.

### Tasks

1. **A headless mode for agent-test Electron**: an agent run of `dev:test` on a Linux desktop puts a window on the user's live session. Status: open (implementation done 2026-11-03; real-display Electron and macOS/Windows qualification remain open).

### 1. A headless mode for agent-test Electron

**Problem.** `dev:test` spawned Electron with the caller's environment (`apps/desktop/scripts/dev/lifecycle.ts`, the `electron` spawn). On a Linux host with `DISPLAY` or `WAYLAND_DISPLAY` set, an agent's disposable profile opened a real window on the user's desktop, took focus and could receive the user's keystrokes. Several concurrent builds did this at once on a shared workstation. Found on 2026-11-01 while running [0048](../transcripts-and-observation/0048-recurring-work-qualification.md) tasks 3 and 4 on a Linux workstation (Hyprland, Wayland).

**Context.** The browser suites drive the gateway with their own headless Chromium; they need Electron only to own the backend and announce readiness. `chromiumSwitchesForRuntime` (`apps/desktop/electron/runtime-profile.ts`) adds switches per flavour but none for headless.

**Investigation.** 0048's run used a workaround outside the repository: `ELECTRON_OVERRIDE_DIST_PATH` pointing at a directory whose `electron` script unsets `DISPLAY` and `WAYLAND_DISPLAY` and execs the real binary with `--ozone-platform=headless`, plus `env -u DISPLAY -u WAYLAND_DISPLAY` around `mise run dev:test`. Electron 45 started, reported ready, and served both browser specs; no window appeared. By 2026-11-03 two opt-ins had landed separately: `--headless-electron` (to-do 0022) and `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1` (to-do 0036). Neither was a default, they used different switches, and the flag was an error on macOS and Windows.

**Decisions.**

- **How should an agent-test profile avoid the desktop?**
  - **A `dev:test --headless` flag (default on when no TTY or when `ORKESTRATOR_AGENT_TEST_HEADLESS=1`) that clears the display variables and adds `--ozone-platform=headless` on Linux (recommended; implemented).**
    - Pros: explicit and testable; the one-shot isolated runners can always pass it.
    - Cons: Electron-window specs still need a display (Xvfb or a nested compositor), so the flag must stay off for them.
  - **Document the wrapper workaround.**
    - Pros: no code.
    - Cons: every agent has to rediscover it, and a missed step opens the window anyway.

## Assumptions and decisions

### Task 1: review repair and qualification status

Keep the task and index unfinished while the real-display Electron and native-platform
checks in Needs verification remain open. Unit coverage is useful but does not close
those live checks. The isolated runner now forces the environment setting as well as
the initial flag so spec-triggered restarts retain headless mode.

### Task 1: what counts as "no TTY"

Both stdin and stdout have to be terminals for a run to count as interactive.
Measured through `mise run` with a pseudo-terminal: mise passes all three streams
through, so a person's `mise run dev:test` stays interactive and `| cat` makes
stdout not a terminal while stdin still is. An agent's shell often captures stdout
while inheriting a terminal's stdin, so checking stdin alone would open the
window. The cost is that a person piping to `tee` goes headless; the launcher says
so and names `--no-headless`. A tool that gives its shell a pseudo-terminal cannot
be told apart from a person, so it has to pass `--headless` or set the variable.

### Task 1: how the inputs combine

Precedence is flag, then `ORKESTRATOR_AGENT_TEST_HEADLESS` (`1` or `0`), then the
earlier `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, then the terminal check. The
flag has to win so that a one-shot runner stays headless whatever the caller's
environment says. Another value of the variable is ignored, as the earlier
variable already did. `--headless` with `--no-headless` is an error.

### Task 1: keeping the earlier spellings

`--headless-electron` and `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1` still work,
because scripts, notes and other agents' habits use them. Removing them would
turn those into errors or, for the variable, into a silent window. It costs one
alias in the parser and one line in the decision.

### Task 1: one list of switches

`dev:test` had two lists and the Electron specs a third.
`HEADLESS_ELECTRON_SWITCHES` in `runtime-profile.ts` is now the only one:
`--ozone-platform=headless`, `--disable-gpu` and `--password-store=basic`. The last
two go beyond what the to-do asked for. `--password-store=basic` keeps `safeStorage`
off the signed-in user's keyring, whose unlock prompt would be a window on their
desktop. Its cost is that `ConnectionManager` treats Linux `basic_text` as insecure,
so the desktop's remote connection tokens last only for the session in this mode.
That manager lives in Electron's main process, which a browser client does not go
through. Only the two cases below that failed were rerun without the extra switches;
the other cases ran only with the full list.

### Task 1: macOS and Windows

`--headless` was an error there and is now accepted and ignored, as the ticket asks.
There is no Ozone to select and no shared desktop problem to solve.

### Task 1: the Electron specs

They launch their own Electron, so `dev:test`'s mode cannot reach them and they
keep whatever display they are given. They deliberately do not read
`ORKESTRATOR_AGENT_TEST_HEADLESS`, so a variable meant for a profile cannot take
away a window they assert on. To state what they need, the config's `globalSetup`
stops a Linux run with no display and says what to do, instead of letting each
spec report a launch timeout. The design canvas spec's own opt-in still skips that
check. CI's native-menu job already runs under `xvfb-run`, which sets `DISPLAY`.

### Task 1: proving headless from the running processes

`headless-profile.spec.ts` joins the browser config and runs only on Linux with
`ORKESTRATOR_AGENT_TEST_HEADLESS=1`, which the isolated runners set. A launcher's
arguments can claim anything; this reads `/proc` for the Electron tree the profile
reports, compares variable names only, and then loads the app in a browser. Every
isolated browser run therefore records the result in its own output, without a
person reading `hyprctl`. It cannot see a window directly: it proves Electron has no
display to open one on. `hyprctl clients` remains a manual, Hyprland-only check.

### Task 1: making the isolated suite finish

The review run's timeout came from the suite, not from headless mode: the Docker
reachability modal blocked several specs, some spending their full 120 s, until the
runner's 900 s budget ran out. Closing the modal in those specs (4221) fixes the cause, so the
budget stays as it was.

### Task 1: `NODE_ENV` in `test:browser`

`env = { NODE_ENV = false }` on the mise task, not an edit to any spec.
`scripts/test-all.ts` already removes the variable for the same reason, and CI does
not set it. It goes beyond the ticket's wording; it is here because it was the
demonstrated cause of two recorded validation failures on this branch, and the cost is
one line.

### Task 1: the one-shot runners

`isolatedProfileArguments` always adds `--headless`, and refuses `--no-headless`.
Every isolated task, the coordinator suite and the goals suite go through it.
`--headless` is accepted as a harmless pass-through because it is what a caller
would naturally type. `test:agent:docker:isolated` no longer needs its own variable.

## Current state

Durable behaviour is in
[`agent-testing.md`](../../development/agent-testing.md#headless-electron), and the
Electron specs' needs in
[its own section](../../development/agent-testing.md#electron-specs-and-their-display).
The decision is `resolveElectronHeadless` in `apps/desktop/scripts/dev/lifecycle.ts`.

Live evidence, 2026-11-03 on beelink (Hyprland), branch based on `4d9ff8690`. Every
run used a fake `DISPLAY=:4242` and `WAYLAND_DISPLAY=ork-no-such-display`, so a
launcher that failed to clear them would crash rather than reach the real desktop.

| Run | Launcher | Electron | Window for the profile (`hyprctl clients`) |
| --- | --- | --- | --- |
| No TTY, `--headless` | Ready | The three switches; no display variables in `/proc/<pid>/environ` | None |
| No TTY, no flag | Ready, `headless (no terminal)` | Same | None |
| Pseudo-terminal, `ORKESTRATOR_AGENT_TEST_HEADLESS=1` | Ready | Same | None |
| Pseudo-terminal, no flag | Failed: `The platform failed to initialize`, as expected on a fake display | Unchanged: kept the display variables | None |
| No TTY, `--no-headless` | Failed the same way | Unchanged | None |
| `mise run test:agent:design:isolated` | Started with `--fixture --headless`; ready; stopped and reset | Headless | None |

### Full isolated run, 2026-11-03

`mise run test:agent:browser:isolated` on fake display values: started with
`--fixture --headless --no-agent-credentials --agent-platforms codex`, reached ready,
and stopped and reset its profile. The suite finished in 760 s, against a 900 s
timeout at case 88 of 143 before the reachability handlers. Hyprland listed no
window for the profile in any of 51 samples, taken every 15 s across the run.

It gave 46 passed, 94 skipped (opt-in Docker and live cases) and 4 failed. The
`/proc` half of `headless-profile.spec.ts` passed in that run, which reads the running
Electron tree: no display variable in any process, and the headless switches on the
launcher's child. The four failures:

| Case | Cause | State |
| --- | --- | --- |
| `headless-profile.spec.ts` | Its last check did not find the `DEV ·` label with `getByText`; it now checks for the project in the sidebar. | Fixed; passed alone against a `--headless` profile |
| `web-annotations-gateway.spec.ts`, `a desktop capture…` | The reachability modal, on a page the spec's own helper creates. | Fixed; passed alone against a `--headless` profile |
| `cli-ui.spec.ts`, `a CLI-initialized project…` | Flake [0901](../../tests/flaky-tests/web-ui/0901-cli-ui-fixture-project-hydration.md): a blank page after a second navigation. | Fixed; 10 of 10 across both cases that share the helper |
| `terminal-input-resume.spec.ts`, `a lost terminal write…` | The host has no `vim`. | Open; see [4222](4222-browser-failures-left-after-headless-qualification.md) |

`project Home retains…` ([4220](4220-project-home-terminal-check-vs-shell-osc-context.md))
and the design canvas cases ([4221](4221-design-canvas-spec-reachability-dialog.md))
passed. So did `capped file tree…`, in 71 s; flake
[2930](../../tests/flaky-tests/previews-annotations-and-gateway/2930-capped-file-tree-exceeds-test-budget.md)
stays open, since one pass does not settle it. The suite was not rerun in full after
the three fixes above.

### `test:browser`

The four files the review package classified as undetermined fail the same way
alone, so they are not load flakes. `AgentsMdApproval.spec.ts` and
`SettingsMachineRouting.spec.ts` fail only with the agent shell's inherited
`NODE_ENV=production` and pass with it unset, which `mise run test:browser` now does.
The two Multi Review layout assertions fail either way, with no change on this
branch to anything they load; see [4222](4222-browser-failures-left-after-headless-qualification.md).

## Needs verification

- The Electron specs under a real display. This host has no Xvfb and they must not
  open on the user's session, so only their no-display preflight and the design
  canvas spec's headless opt-in ran here. That spec is intermittent on this host
  (flake [4250](../../tests/flaky-tests/design-canvas-and-artifacts/4250-design-electron-reachability-dialog-race.md)),
  with and without this change. CI's native-menu job covers two of them under Xvfb.
- macOS and Windows. The no-op there is covered by unit tests with an injected
  platform and has not run on those systems.

## Related

- [0048](../transcripts-and-observation/0048-recurring-work-qualification.md), where this was found.
- [4220](4220-project-home-terminal-check-vs-shell-osc-context.md) and [4221](4221-design-canvas-spec-reachability-dialog.md), found while qualifying this.

# Browser suite cases that fail on macOS

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c`, from the hidden-profile run
of [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) task 4 on the
Mac `arktech-mini` (macOS 27.2, Electron 45.2.3).

### Tasks

1. **`a lost terminal write stays fenced…` waits for a ruler macOS vim never draws**. Status: open.
2. **The two late `browser-gateway.spec.ts` cases fail every time on this Mac**. Status: open.
3. **`Global settings opens the Docker tab and reviewed cleanup` sees only "Loading Docker stats..."**. Status: open.
4. **`real gateway saves a design and rehydrates another client's edits` cannot find the design file in the tree**. Status: open.

### 1. `a lost terminal write stays fenced…` waits for a ruler macOS vim never draws

**Problem.** `terminal-input-resume.spec.ts:71` failed in the suite and again
alone against the same profile, at `expect.poll(screen).toMatch(/resume\.txt[^\n]*0,0-1/)`
(line 202): the empty editor's ruler never appeared.

**Context.** The spec starts `vim -u NONE -N -n resume.txt`, or `nvim` with
the same flags when the host has no `vim`. Linux agent hosts have only `nvim`,
whose built-in defaults turn `ruler` on. macOS ships `/usr/bin/vim` (9.1), and
`-u NONE` skips `defaults.vim`, which is where Vim turns `ruler` on.

**Investigation.** On `arktech-mini`,
`vim -u NONE -N -n -es '+redir! >/dev/stdout' '+set ruler?' '+redir END' '+q'`
prints `noruler`. So every Mac with the system vim fails this case; it is not
a flake and not caused by hidden windows. Not changed here: the fix needs a run
on a Linux host with `nvim` as well as on the Mac.

**Decisions.**

- **How should the spec get its ruler?**
  - **Pass `--cmd "set ruler"` to the editor (recommended).**
    - Pros: one argument; both vim and nvim accept `--cmd`; the assertion stays as it is.
    - Cons: needs the case run on both editors.
  - **Wait for something other than the ruler.**
    - Pros: independent of editor settings.
    - Cons: the ruler is what proves startup finished, so a weaker signal can let startup discard the first input, which the comment at line 201 guards against.

### 2. The two late `browser-gateway.spec.ts` cases fail every time on this Mac

**Problem.** `host maintenance rehydrates task completion while Settings is
closed (390px)` (line 2859: `locator.click` on **Open projects and
environments** timed out, the open Settings dialog's section picker receiving
the click) and `persisted diff baselines keep Files, the badge and diff tabs
aligned after background changes and reload` (line 3028: the baseline read was
`undefined`, expected the tip) failed in the suite and again alone, on the
same profile.

**Context.** Both are flake
[0484](../../tests/flaky-tests/previews-annotations-and-gateway/0484-gateway-late-suite-maintenance-and-diff.md),
open, seen on Linux in full isolated runs and passing there when rerun.
The 1280px variant of the maintenance case passed alone on the same profile.

**Investigation.** Not yet known whether this is the profile's accumulated
state after about 100 cases, or macOS. Rerun both alone on a fresh
`dev:test --fixture --no-agent-credentials --no-host-seed --agent-platforms codex`
profile on a Mac. If they pass, add the observation to 0484; if they fail,
read the saved traces for the cause.

**Decisions.**

- **Where should the result go?**
  - **Into 0484 if a fresh profile passes, otherwise a fix here (recommended).**
    - Pros: keeps one record per cause; the flake rule (passes alone) decides.
    - Cons: needs one more Mac run.
  - **Record both as macOS-only failures now.**
    - Pros: no extra run.
    - Cons: may be wrong: the same cases are intermittent on Linux.

### 3. `Global settings opens the Docker tab and reviewed cleanup` sees only "Loading Docker stats..."

**Problem.** `container-rebuild-cycle.spec.ts:85` failed in the suite and alone:
its 5 s wait for "System Resources" or "Docker is not running…" ended with the
tab still showing "Loading Docker stats...".

**Context.** The Mac's Docker served nine other builds at the time, so a
`docker stats` read can take longer than 5 s. The case asserts the loaded or
unavailable state, not how long loading takes.

**Investigation.** Time the Docker tab's stats read on a Mac (the backend's
log for the read, or a repeated `docker stats --no-stream`) while other work
uses Docker, and compare it with the 5 s budget.

**Decisions.**

- **If the read is just slow under load?**
  - **Wait for the loaded or unavailable state with a budget sized from the measurement, and say so beside it (recommended).**
    - Pros: the assertion keeps its meaning; the budget is justified by a measured, heavy read.
    - Cons: a slow host makes the case slower.
  - **Treat it as a product bug and make the tab show resources without waiting for stats.**
    - Pros: a better tab for a user with a busy Docker.
    - Cons: a product change that needs its own design; not justified until the read is measured.

### 4. `real gateway saves a design and rehydrates another client's edits` cannot find the design file in the tree

**Problem.** `design-canvas.spec.ts:16` failed in the suite and alone: the
button for `UPPER.ORKDES` was not found within 15 s (line 248).

**Context.** Flake
[0380](../../tests/flaky-tests/design-canvas-and-artifacts/0380-design-text-fallback-pane-persistence.md)
is open for the same case with a different symptom. The design canvas has its
own isolated runner (`mise run test:agent:design:isolated`).

**Investigation.** Read the saved trace's file tree at the failure; rerun the
case on a fresh profile on a Mac and on Linux. Check whether the file's
upper-case name reaches the tree on macOS's case-insensitive file system.

**Decisions.**

- **Where should the fix go?**
  - **Find the cause from the trace first, then fix the spec or the tree (recommended).**
    - Pros: fixes what is actually wrong.
    - Cons: needs a Mac to reproduce.
  - **Record it as a 0380 recurrence.**
    - Pros: no investigation now.
    - Cons: it failed alone, so it does not meet the flake rule.

## Current state

Runs on `arktech-mini` on 2026-11-13, profile `t2181-mac-hidden` (hidden
Electron), `main` at `17d28238c`; the profile was stopped and reset
afterwards. Of the cases the suite reached (77 of 185 in a first run, cut off
by `test:logged`'s 30-minute limit, then the remaining 18 files: 18 passed, 25
skipped, 1 failed), these five failed. A rerun of the five alone failed all
five again. The browser smoke itself passed (2181's Current state). None of
these specs touches the Electron window; they drive Playwright's Chromium
through the gateway.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) task 4, whose run found these.
- Flakes [0484](../../tests/flaky-tests/previews-annotations-and-gateway/0484-gateway-late-suite-maintenance-and-diff.md) and [0380](../../tests/flaky-tests/design-canvas-and-artifacts/0380-design-text-fallback-pane-persistence.md).

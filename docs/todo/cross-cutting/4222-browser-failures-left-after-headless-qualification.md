# Browser cases still failing on beelink after the headless qualification

## Task analysis

Analysed 2026-11-03 against `main` at `a2827f52f`. Task 3 added 2026-11-04 on the same
base.

### Tasks

1. **Two Multi Review layout assertions in `test:browser`**: they fail every time on beelink with the renderer unchanged. Status: open.
2. **`terminal-input-resume.spec.ts` needs `vim`**: the host has no `vim`, so the first case failed in the isolated suite. Status: done 2026-11-04.
3. **The browser suite loses cases to Docker network churn**: on a busy Linux host an isolated run fails a varying few cases that have nothing wrong with them. Status: open.

### 1. Two Multi Review layout assertions in `test:browser`

**Problem.** Found on 2026-11-03 while qualifying [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) on beelink. Three results fail every time on beelink: `puts a running node's elapsed time and tokens on its own third row` (`e2e/MultiReviewFlow.spec.ts:107`, mobile project, at the check that a detail row's `scrollWidth` exceeds its `clientWidth`) and `package validation and transcript fit a 1408px container` (`e2e/MultiReviewPackageLayout.spec.ts:4`, both projects, `footerBox.y - geometry.log.bottom` is -25 where at least 0 is expected).

**Context.** These are component specs on a mocked fixture. On the 2181 branch, `git diff main...HEAD` is empty for `apps/web`, `e2e/fixture`, `packages/protocol`, `e2e/playwright.config.ts` and both spec files, so that branch cannot have changed what they render.

**Investigation.** The four files the review package classified as undetermined were run alone with `bunx playwright test --config e2e/playwright.config.ts`. With the shell's `NODE_ENV=production` 137 passed, 7 failed and 4 skipped; with it unset 141 passed, 3 failed and 4 skipped. The three left are these. They were not run on `main`. Both measure rendered text and layout, so host font metrics are a hypothesis; no font was changed to test it.

**Decisions.**

- **How should these be resolved?**
  - **Measure with the fixture's font pinned, then fix whichever side is wrong (recommended).**
    - Pros: tells a real layout bug from a host difference; the assertions stay as strict.
    - Cons: needs a change to the fixture or the spec's setup, and a run on a second host to compare.
  - **Loosen the two measurements.**
    - Pros: small.
    - Cons: could hide a real overflow; the 25 px overlap may be one a user would see.

### 2. `terminal-input-resume.spec.ts` needs `vim`

**Problem.** `a lost terminal write stays fenced until the user resumes, and the shell survives` (`e2e/agent-testing/terminal-input-resume.spec.ts:75`) fails at `resume.txt` never being written, because it types `vim -u NONE -N -n resume.txt` into the terminal.

**Context.** `command -v vim vi nvim` on beelink finds only `/usr/bin/nvim`. The other two cases in the file do not use vim and passed.

**Investigation.** One failing run in the isolated suite, on a `--headless` profile. The spec was not run with a `vim` on `PATH`, so the missing binary is the demonstrated gap rather than a run that proves the case passes with it.

**Decisions.**

- **How should the spec handle a host with no `vim`?**
  - **Skip that case with a message when `vim` is not on `PATH` (recommended).**
    - Pros: says what is missing instead of a 5 s poll failure; CI and hosts with vim keep the coverage.
    - Cons: the case silently stops covering this host's runs unless someone reads the skip.
  - **Install `vim` on the host.**
    - Pros: no code, and the case runs.
    - Cons: changes a host to pass a test, and the next host hits it again.
  - **Drive `nvim` when `vim` is absent.**
    - Pros: keeps coverage here.
    - Cons: the flags and redraw behaviour differ, and the spec's comments describe vim's.

### 3. The browser suite loses cases to Docker network churn

**Problem.** Chromium aborts in-flight requests when a host interface changes (flake [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md)), so an isolated browser run beside other Docker work fails cases at random, and only a read of each trace shows why. The run at `b16b51da1` lost `design-canvas.spec.ts:16`, `graph-designer.spec.ts:239` and `graph-run-view.spec.ts:48` this way, as well as `headless-profile.spec.ts`, which [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) has since made immune.

**Context.** The specs mostly import `test` from `@playwright/test` directly, so nothing shared wraps their pages, and a Playwright config cannot add a route. Some specs create extra contexts for a second client. No Chromium switch or feature name for ignoring these changes was found in the binaries. `network-churn-report.ts` now names the affected cases in a run's output.

**Investigation.** Under `docker network create`/`rm` every 0.3 s, `headless-profile.spec.ts` failed 3 of 3 before its modules went through `route.fetch()` and passed 3 of 3 in 8 s after. That is one spec; the rest of the suite was not run this way.

**Decisions.**

- **How should the suite handle this?**
  - **A shared `test` with a `page` fixture that fetches modules outside Chromium (recommended).**
    - Pros: the measured fix; about 0.9 s more per load in the one spec measured; scripts and styles only, so commands and event streams still go through the browser.
    - Cons: touches every spec's import; extra contexts need the same treatment; module loading is no longer exercised through Chromium's stack, so a gateway fault that only affects browsers could be missed unless one spec stays direct.
  - **Leave it, and rely on the report.**
    - Pros: no spec changes; the suite still tests a real browser's whole network path.
    - Cons: a busy host still gets a red run, and reruns are what that costs.
  - **Run the whole stack in a private network namespace.**
    - Pros: no spec changes; flake 2340 measured this working for the component suites.
    - Cons: 2340 says it only suits suites that need nothing beyond loopback, and this one starts a real backend beside Docker; untested here.

## Assumptions and decisions

### Task 2: the fenced-keystroke checks (2026-11-04)

The note below that the state snapshot makes `not.toContain("before-XY")` a real check did not hold on `nvim`. In the isolated run at `b16b51da1`, `poll(screen).toContain("before-X")` failed with the keystroke present: the snapshot's text ended `before-…-- INSERT --…X9`, because the editor drew it as its own cell. Both specs now require `before-` followed later by `X`, and the browser spec's fenced check requires no `Y` after that. The saved buffer, `before-XZ\n`, is still the precise check. The browser case then passed 5 of 5 with `--repeat-each=5 --workers=1` on a `--headless --fixture` profile. The Electron spec's one line has not run, because this host has no Xvfb.

### Task 2: driving `nvim` when `vim` is absent

Chose the `nvim` fallback, with a skip that names what is missing when neither is on `PATH`, instead of the skip this file recommended. The fallback keeps the case running on this host, which is the host where the failure was recorded.

The objection above held, and the spec adapts to it. `nvim` positions each cell, so the checks on typed text read the terminal's state snapshot; that also makes `not.toContain("before-XY")` a real check for either editor. It answers terminal queries as writes, so the spec waits a second before injecting the fault. A mouse report can share a write with the keystroke, so the check for `Z` uses `endsWith`. The saved-file and shell-PID assertions are unchanged.

On a `--fixture` profile the case passed 6 of 6 with `--repeat-each=6 --workers=1` on `nvim`, and once more after formatting. It was not run with `vim`, because this host has none.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found these.
- [2921](2921-component-browser-failures-on-main.md), other `test:browser` failures.

## Assumptions and decisions

### Task 2: Electron editor parity (2026-11-04)

Applied the browser journey’s vim/nvim selection, terminal state snapshot reads,
and terminal-query settling to the Electron counterpart. The saved buffer and
shell identity assertions remain strict. Native Electron evidence still needs a
disposable display; this host has no Xvfb.

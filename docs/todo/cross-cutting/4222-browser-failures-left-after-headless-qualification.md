# Browser cases still failing on beelink after the headless qualification

Found on 2026-11-03 while qualifying
[2181](2181-dev-test-electron-opens-on-the-linux-desktop.md) on beelink.

## Task analysis

Analysed 2026-11-03 against `main` at `a2827f52f`.

### Tasks

1. **Two Multi Review layout assertions in `test:browser`**: they fail every time on beelink with the renderer unchanged. Status: open.
2. **`terminal-input-resume.spec.ts` needs `vim`**: the host has no `vim`, so the first case failed in the isolated suite. Status: done 2026-11-04.

### 1. Two Multi Review layout assertions in `test:browser`

**Problem.** Three results fail every time on beelink: `puts a running node's elapsed time and tokens on its own third row` (`e2e/MultiReviewFlow.spec.ts:107`, mobile project, at the check that a detail row's `scrollWidth` exceeds its `clientWidth`) and `package validation and transcript fit a 1408px container` (`e2e/MultiReviewPackageLayout.spec.ts:4`, both projects, `footerBox.y - geometry.log.bottom` is -25 where at least 0 is expected).

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

## Assumptions and decisions

### Task 2: driving `nvim` when `vim` is absent

Chose the `nvim` fallback, with a skip that names what is missing when neither is on `PATH`, instead of the skip this file recommended. The fallback keeps the case running on this host, which is the host where the failure was recorded.

The objection above held, and the spec adapts to it. `nvim` positions each cell, so the checks on typed text read the terminal's state snapshot; that also makes `not.toContain("before-XY")` a real check for either editor. It answers terminal queries as writes, so the spec waits a second before injecting the fault. A mouse report can share a write with the keystroke, so the check for `Z` uses `endsWith`. The saved-file and shell-PID assertions are unchanged.

On a `--fixture` profile the case passed 6 of 6 with `--repeat-each=6 --workers=1` on `nvim`, and once more after formatting. It was not run with `vim`, because this host has none.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found these.
- [2921](2921-component-browser-failures-on-main.md), other `test:browser` failures.

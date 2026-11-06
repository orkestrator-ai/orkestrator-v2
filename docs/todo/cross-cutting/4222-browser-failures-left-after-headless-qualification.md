# Browser cases still failing on beelink after the headless qualification

## Task analysis

Analysed 2026-11-03 against `main` at `a2827f52f`. Task 3 added 2026-11-04 on the same
base. Acted on 2026-11-05 against `main` at `e1f4c875f`; every line reference below was
re-checked there.

### Tasks

1. **Two Multi Review layout assertions in `test:browser`**: they fail every time on beelink with the renderer unchanged. Status: done 2026-11-05 (the fixture sat on a font-dependent boundary; see Assumptions and decisions).
2. **`terminal-input-resume.spec.ts` needs `vim`**: the host has no `vim`, so the first case failed in the isolated suite. Status: done 2026-11-04.
3. **The browser suite loses cases to Docker network churn**: on a busy Linux host an isolated run fails a varying few cases that have nothing wrong with them. Status: open (implementation done 2026-11-05; the suite-wide run under Docker network churn that would show it fixed has not been done, because that build was not allowed to create Docker networks on beelink; see Outstanding work).

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

**Problem.** `a lost terminal write stays fenced until the user resumes, and the shell survives` (`e2e/agent-testing/terminal-input-resume.spec.ts:79`, at `:75` when recorded) fails at `resume.txt` never being written, because it types `vim -u NONE -N -n resume.txt` into the terminal.

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

### Task 2: Electron editor parity (2026-11-04)

Applied the browser journey’s vim/nvim selection, terminal state snapshot reads,
and terminal-query settling to the Electron counterpart. The saved buffer and
shell identity assertions remain strict. Native Electron evidence still needs a
disposable display; this host has no Xvfb.

### Task 1: the reproduction on the base commit (2026-11-05)

On beelink at `69a3b4ca5`, `bunx playwright test --config e2e/playwright.config.ts
e2e/MultiReviewPackageLayout.spec.ts e2e/MultiReviewFlow.spec.ts:107` reported 3 failed
and 11 passed: the mobile truncation check (`scrollWidth` not above `clientWidth`) and the
1408px footer gap of -25 on both projects, as recorded above.

### Task 1: measuring with fonts pinned, and fixing the fixture (2026-11-05)

Took the recommended option. The host resolves `-apple-system`, Roboto, Arial and similar
to Liberation Sans, and `<code>` to Liberation Mono. With Liberation Sans the fixture's
55-character model name measured 313 px in a 317 px slot, so it fitted without truncating;
with Noto Sans it measured 331 px and truncated. With Liberation Mono the 30-repeat
validation command made the details column 707 px against 667 px available, so the
overview scrolled; with 12 repeats it measured 408 to 495 px across eight font
substitutions. The app truncates and scrolls correctly in both cases: the fixture's inputs
were on a font-dependent boundary, not the assertions.

The fixture's model name is now 89 characters and the command repeats 12 times
(`e2e/fixture/MultiReviewFlowFixture.tsx`). The 1408px case first asserts that the
overview does not scroll, so a future font that breaks the precondition says so instead of
reporting a negative footer gap (`e2e/MultiReviewPackageLayout.spec.ts`). Both spec files
passed with `--workers=2` through `test:logged` (exit 0, 342 s), and the three target
cases passed with `--repeat-each=3`. An eight-worker run lost an unrelated retained-PR case
to flake [0254](../../tests/flaky-tests/coordinator-and-multi-review/0254-multi-review-flow-goto-timeout-under-load.md). No assertion was loosened.

### Task 3: a shared `test` that fetches modules outside Chromium (2026-11-05)

Took the recommended option. `e2e/agent-testing/browser-test.ts` exports a `test` whose
`context` fixture routes loopback GET scripts and stylesheets through `route.fetch()`.
Every browser-suite spec imports it; specs that open another context call
`fetchModulesOutsideChromium` on it. `browser-gateway.spec.ts` and `client-outage.spec.ts`
stay on `@playwright/test`, so the browser's own network path is still exercised, which
was this option's named risk. `headless-profile.spec.ts` uses the shared fixture instead
of its own copy. `browser-test.test.ts` enforces the import, the extra-context routing,
the loopback pattern, the module filter, the cache budget and the header stripping, and
runs the installed route handler against controlled doubles (cache hit, context
isolation, fallback, non-200 refetch and failed-fetch abort).

Routing turns Chromium's HTTP cache off. Without a cache each reload fetched about 1,100
modules through the test process, and `design-canvas.spec.ts:16` failed 3 of 3 at its
check after the last reload where the base specs passed 2 of 2. Each context now keeps its
200 responses in memory up to 256 MiB; with it `design-canvas.spec.ts:16` and
`graph-run-view.spec.ts:48` passed 3 of 3 each (247 s, load average about 50).

### Task 3: kept open rather than closed (2026-11-05)

The change is in, but nothing has shown that it removes this failure across the suite. The
single-spec measurement (flake 2340: 0 of 3 before, 3 of 3 after, under `docker network
create`/`rm` every 0.3 s) is evidence for the mechanism, and the focused runs above show
the fixture breaks no case. The suite was not run under network churn: the build was not
allowed to create Docker networks on beelink, and `ip monitor link address` saw only 2 to
12 events per 10-minute run, so ordinary runs did not exercise it. Closing the task on that
evidence would have recorded a fix that was never observed, so it stays open until the run
in Outstanding work is done.

The review preparation's isolated browser run of this branch (`test:agent:browser:isolated`,
with credentials) reported 47 passed, 4 failed and 98 skipped. None of the four traces holds
`net::ERR_NETWORK_CHANGED` or a failed module request; each loaded its modules (1,083 to 1,899
responses with status 200). Two are in `browser-gateway.spec.ts`, which does not use the
shared fixture: the narrow host picker (flake
[0224](../../tests/flaky-tests/previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md),
open) and the capped file tree (flake
[2930](../../tests/flaky-tests/previews-annotations-and-gateway/2930-capped-file-tree-exceeds-test-budget.md)).
The other two stopped on UI state with the page rendered: `agent-accounts.spec.ts:229`
(390px), where the Settings dialog was still over the drawer toggle, and
`cli-ui.spec.ts:250`, where the project row did not expand after the reachability dialog
was dismissed (flake [0511](../../tests/flaky-tests/web-ui/0511-cli-ui-startup-connection-error.md)
is open for that case). A rerun of those two on a credential-free profile stopped at the
"Claude Code Is Not Logged In" modal in all six results, so it says nothing either way, and
this build was not allowed to read the host's Claude credentials for a rerun that could.

### Task 3: review guard coverage and qualification limits (2026-11-05)

Replaced the extra-context guard's literal `browser.newContext()` counts with a syntax
walk. It checks named contexts independently of the browser receiver's name, requires
an awaited routing call for that context before `newPage`, rejects browser-level
`newPage` shortcuts, and rejects direct Chromium/Firefox/WebKit launches (including
renamed imports and namespace imports). Regression inputs cover these bypasses,
wrong-context routing, late or unawaited routing, and harmless comments and strings.
This is a conservative source guard, not whole-program type or control-flow analysis.
It does not replace the live qualification below. The focused `browser-test.test.ts`
run (`--parallel=2`), `bun check -p e2e/agent-testing/tsconfig.json`,
`mise run format:check` and `mise run lint` passed; lint reported existing warnings
outside the edited files.

The address stage read review package
`review-validation-40976e7e-9e38-4548-b855-3efbf8327fe0` for commit `e1921ed4d`:
its `validation` array is empty, so it supplies no recorded commands or failure
artifacts to repair. Earlier results above remain historical evidence. This stage
preserves the ticket's restrictions on creating Docker networks and accessing host
Claude credentials. It therefore cannot complete either the suite-wide artificial
churn run or the credentialed regression comparison here. Both remain open; a
credential-free repeat would hit the already demonstrated sign-in prerequisite
and would not classify those two failures.

## Outstanding work

- **Task 3: qualify the whole browser suite under network churn.** On a Linux host where
  creating Docker networks is allowed, start an isolated `--headless --fixture` profile,
  run `docker network create`/`rm` of a labelled network with an explicit `--subnet`
  every 0.3 s (as in flake
  [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md)),
  and run `mise run test:agent:browser` against it. Done when no failed case has
  `net::ERR_NETWORK_CHANGED` on a module request in its trace (the run's churn report says
  so). Remove the churn networks afterwards by their label only. If a case still fails that
  way, record which request was aborted: a navigation or event stream is outside what this
  fixture covers.
- **Task 3: rerun `agent-accounts.spec.ts:229` (390px) and `cli-ui.spec.ts:250` with
  credentials.** They failed once in the preparation run above with their modules loaded.
  Run each alone with `--repeat-each=3` on a profile with Claude credentials. If they pass,
  record the recurrence in their flake files; if they fail, run them once with the spec's
  `test` imported from `@playwright/test` to see whether the shared fixture is involved.

## Related

- [2181](2181-dev-test-electron-opens-on-the-linux-desktop.md), whose qualification found these.
- `2921-component-browser-failures-on-main.md` (deleted 2026-11-06), other `test:browser` failures.

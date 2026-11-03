# Default and browser suites fail on `main` (2026-11-02)

## Task analysis

Analysed 2026-11-02 against `main` at `d7cdfaa8b`.

### Tasks

1. **Preview upstream pool idle-expiry case fails deterministically**: `PreviewUpstreamPool > idle connections expire, and one the application closes is never handed out`. Status: done (fixed under [2920](../previews-and-annotations/2920-upstream-pool-idle-test-accept-race.md)).
2. **Log Detail settings case fails in both viewports**: `e2e/GlobalSettings.spec.ts:3` `Log Detail offers only areas controlled by live policy`. Status: done (2026-11-03): the spec was stale; `terminal` is a live-policy area. Fixed under [2921](2921-component-browser-failures-on-main.md) task 1.
3. **Merged project list drag cases fail**: `e2e/MergedProjectList.spec.ts:168` `project/repository project and group drags ignore expanded environment rows`. Status: done (2026-11-03): the previous drag's card took the press during its drop animation (`0412ae2c4`); fixed under [2921](2921-component-browser-failures-on-main.md) task 2.
4. **Four Cursor close-retention cases fail on desktop**: `e2e/CloseRetention.spec.ts:328`, `:422`, `:693`, `:801`. Status: done (2026-11-03, through 2921 task 3).

### 1. Preview upstream pool idle-expiry case fails deterministically

**Problem.** `apps/backend/src/preview-upstream-pool.test.ts:199` expects an idle upstream socket to be destroyed within 100 × 5 ms and it is not. `mise run test` fails in the backend workspace group on every branch based on this `main`.

**Context.** The pool landed in `b64242842` (#1604, 2026-11-02). Found while validating the PR-pane links build (`pr-pane-links-865d2d816886`), which changes only `apps/web`.

**Investigation.** In a detached `origin/main` worktree at `d7cdfaa8b` with its own `bun install --frozen-lockfile`, `bun --cwd=apps/backend test ./src/preview-upstream-pool.test.ts` failed alone twice (6 pass, 1 fail; 654.67 ms and 668.24 ms for the case). It also failed the same way in that branch's aggregate run. Not a flake: it fails alone. The cause was not investigated.

**Decisions.**

**Resolution.** The pool was not at fault. The test ended `accepted.at(-1)`,
which on macOS is usually the earlier, already-closed peer because the client's
`connect` fires before the server's connection callback. Fixed under
[2920](../previews-and-annotations/2920-upstream-pool-idle-test-accept-race.md)
by having the test's `socket()` helper return each client with its own accepted
peer; the poll budget was not widened.

- **Where to start?**
  - **Check the idle timer against the 500 ms poll budget (recommended).** Read the pool's idle expiry and whether it closes the socket or only forgets it.
    - Pros: the assertion names the observable (`client.destroyed`), so the gap is between expiry and socket teardown.
    - Cons: needs the pool's author's intent on whether a forgotten socket should also be destroyed.
  - **Widen the poll budget.**
    - Pros: quick.
    - Cons: loosens a test that fails alone, which the flaky-test rules forbid without a cause.

### 2. Log Detail settings case fails in both viewports

**Problem.** `e2e/GlobalSettings.spec.ts:3` fails in `mise run test:browser` on desktop and mobile.

**Context.** The renderer logger migration (`0ec784293`, #1592) changed the logging settings on 2026-11-02.

**Investigation.** Failed on detached `origin/main` `d7cdfaa8b` with only the failing owners run (evidence `output/agent-testing/pr-pane-review-evidence/baseline-browser.log.gz` in the PR-pane worktree) and in that branch's full browser run. The assertion expects no `Log level for web.*`/`terminal*` combobox (`toHaveCount(0)`) and finds one, so the page now offers a renderer area the spec says live policy does not control.

**Decisions.**

- **Fix the spec or the settings page?**
  - **Compare the spec's expected areas with the live policy the migration now reports (recommended).**
    - Pros: tells whether the page or the expectation is stale.
    - Cons: none beyond the read.
  - **Skip the case until the logger work settles.**
    - Pros: unblocks validation.
    - Cons: hides a real regression; not allowed by the flaky-test rules.

Resolved 2026-11-03 under [2921](2921-component-browser-failures-on-main.md) task 1. The page was right: the combobox found was `Log level for terminal`, and the bare `terminal` area is offered on purpose because its backend sites follow live policy. The spec now expects it and still excludes `web.*` and `terminal.*`. Not a flake: it failed every run.

### 3. Merged project list drag cases fail

**Problem.** Both parameterised cases at `e2e/MergedProjectList.spec.ts:168` fail.

**Context.** Mobile failed in both runs; desktop failed on `main` and passed on the PR-pane branch run.

**Investigation.** Reproduced on detached `origin/main` `d7cdfaa8b` in the owner-only run named in task 2. The project case expects `Collapse folder Work` to carry an attribute value of `"true"` and gets `""`; the repository case expects the same of the `Open team-a/shared/app on …` button. Cause not investigated.

Resolved 2026-11-03 under [2921](2921-component-browser-failures-on-main.md) task 2, which has the cause and the fix. `0412ae2c4` (#1603) gave the merged list a drag card. During its drop animation the card covered the next handle and took the press. The card no longer takes pointer input. Not a flake: on `main` at `7b48c23fb` it failed every run.

**Decisions.**

- **How to triage?**
  - **Run the owner alone with a trace and compare against the last sidebar change on `main` (recommended).**
    - Pros: deterministic on `main`, so a trace shows the failing step.
    - Cons: none.
  - **Treat as a flake.**
    - Pros: none.
    - Cons: it fails on the owner-only run, so it is not one.

### 4. Four Cursor close-retention cases fail on desktop

**Problem.** `closing a Cursor tab keeps the conversation…`, `closing a Cursor tab during a turn…`, `steering a Cursor turn whose steer history is full…` and `a Cursor transcript shed from persistence…` fail. The shed case shows each persisted turn text carrying an appended `<orkestrator-system-instructions>` block, so the fixture's expected texts no longer match.

**Context.** Flake 0963 records two of these as intermittent earlier; these runs fail every time.

**Investigation.** Reproduced on detached `origin/main` `d7cdfaa8b` in the owner-only run named in task 2, with the same assertions as the branch: `:328` and `:801` compare stored conversation texts (received texts are longer), `:422` reads `undefined` where it expects an object, and `:693` never shows `agent-runtime-steer-saturated`. Only the `:801` diff was read in full; whether the other three share the suffix cause is unconfirmed.

**Decisions.**

- **Expectation or behaviour?**
  - **Decide whether the Cursor fixture should see the system-instructions suffix in the stored prompt (recommended).** If the suffix belongs in the provider prompt but not in the user's stored text, the bug is in the renderer/fixture path that persists it.
    - Pros: the diff in the failure already points at the suffix.
    - Cons: needs the owner of the system-instructions feature.
  - **Update the expected texts to include the suffix.**
    - Pros: quick.
    - Cons: would encode instructions text in user-visible transcript expectations, which may be the bug.

**Outcome (2026-11-03).** Done in [2921](2921-component-browser-failures-on-main.md) task 3. The suffix belongs in the provider prompt: the bridge sends it to the SDK and strips it from the user's stored text, and the stored-text paths were not at fault. The fake Cursor engine recorded the framed prompt as the user's text; it now strips the frame and keeps the sent text separately, and one spec assertion checks the frame is still sent. `:693` had a second cause, unrelated to the suffix: the backend's 30 s runtime-health cache. Its deadline now covers that cache. See 2921's Assumptions and decisions.

## Assumptions and decisions

### Task 1: fixed through 2920

Closed by the test-only fix recorded in
[2920](../previews-and-annotations/2920-upstream-pool-idle-test-accept-race.md),
whose investigation found the cause this task left open. The idle timer did
not need to change: expiry already destroys the socket, and the failing step
was the "application closes" half of the case, not idle expiry.

### Task 2: the spec was stale (2026-11-03)

Took the recommended option and compared the spec with what `logDetailAreas()` offers. The settings page matches the live policy, so the spec changed, not the page; [2921](2921-component-browser-failures-on-main.md) task 1 has the options and the checks that the spec still fails when a `web.*` or `terminal.*` control appears. Skipping the case was rejected because the case was correct in intent and only its expectation was stale.

## Related

- Flake [0767](../../tests/flaky-tests/native-agents-and-transcripts/0767-streaming-find-convergence-aggregate-timeout.md), [0153](../../tests/flaky-tests/native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md) and [2391](../../tests/flaky-tests/agent-bridges/2391-acp-busy-fork-intermittent.md): the intermittent failures seen in the same runs.

# Legacy URL tab Back regression: synthetic re-attach lost its environment identity

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc84234aa2d1d0fe064811e0a7975da629520`.
Found while running the complete service preview Electron owner for to-do 0042
task 11; resolved during task 10 review fixes.

### Tasks

1. **Identify the failed Back case**: inspect the stale re-attach and its identity. Status: done.
2. **Fix the case or the product, by what task 1 finds**. Status: done.

### 1. Identify the failed Back case

**Problem.** `a legacy URL tab keeps a link and Back through routine
re-attaches` (`e2e/agent-testing/service-preview-electron.spec.ts:2102`) fails
in every headless run on beelink, and the spec runs serially, so the six cases
after it never run. A complete headless owner run can therefore never pass,
which hides the cases after it, flake 0622's multi-backend case among them.

**Context.** The failing check is `` await expect(address).toHaveValue(`${legacyOrigin}/`) ``
at `:2208`, right after `` staleAttach(`${legacyOrigin}/app/next`, basis, true) ``
issues a Back together with a stale attach: the address stays
`http://localhost:<port>/app/next`. Headless means
`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1` (`--ozone-platform=headless`, the
display variables removed).

**Investigation.** First seen 2026-11-04 (to-do 0042 evidence log: 4 of 4
headless, and 2 of 2 with that day's product change reversed, so that change
did not cause it). On 2026-11-06 it failed 3 of 3 complete-owner runs with the
same message (`Expected: "http://localhost:44475/"`, `Received:
"http://localhost:44475/app/next"`), at `e6c3da899` plus `03cbf0191`, which
does not touch preview navigation. Run without it
(`--grep-invert "keeps a link and Back through routine"`), the other 21 cases
passed twice in a row (42 of 42). It was not run on a display: beelink has no
disposable one, and runs must not use the signed-in desktop. On 2026-11-06 it also
failed 2 of 2 complete-owner runs on macOS 27.2 arm64 with hidden windows (no
shell attached), at `ee2cc8423` with and without to-do 0042's task 10 cases,
at the same check (now `:2335`) with the same message; the other 23 cases
passed with it left out (0042 evidence log, 2026-11-06). So it is not
Linux-only; a run with a shown window is still missing. Not recorded as a
flake, because it has never passed here.

**Decisions.**

- **How to find out?**
  - **Inspect the request and validate the corrected case on macOS hidden windows (recommended).**
    - Pros: establishes the concrete request-identity mismatch and validates it.
    - Cons: does not provide a Linux headless or shown-window qualification.
  - **Read the trace of a headless run only.**
    - Pros: runs here.
    - Cons: cannot say whether a real window behaves differently.

### 2. Fix the case or the product

**Problem.** Until it passes, the cases after it in the owner do not run in a
complete headless run.

**Context.** Depends on task 1. The real renderer already sends the environment identity.

**Investigation.** The test's synthetic `api.attach` omitted `environmentId`,
although the real `BrowserTab` supplies it. `BrowserPreviewManager.attachUrl`
treats a different environment identity (including null) as a new view and
replaces it, deliberately discarding the old history. This was an identity
change, not a bounds-only stale re-attach. Keeping `s().environmentId` in that
request makes the existing Back and link assertions pass without changing the
product or weakening their expectations. The filtered cross-client and Back
owner run `svc0042-review-fixed` passed 2/2 in 29.5 s on macOS hidden windows.

**Decisions.**

- **How to preserve the intended race?**
  - **Keep the renderer's environment identity in the synthetic attach (recommended).**
    - Pros: exercises the intended stale-URL race on the same view and history;
      keeps all original assertions and platform coverage.
    - Cons: the synthetic request must track the renderer's identity contract.
  - **Skip it headless.**
    - Pros: unblocks the owner at once.
    - Cons: loses the check on Linux CI's headless path; repository rules
      prefer fixing to skipping.

## Assumptions and decisions

### Task 1: classify the failure by the request identity

The recorded failure and current request/manager code explain the replaced view.
No checkout, worktree or test against `origin/main` was needed. The historical
headless observations above remain evidence of the old test, not proof of a
headless-only product defect.

### Task 2: preserve the environment on a stale re-attach

Added the same environment identity the renderer sends. Changing the manager
would weaken its intended identity boundary; skipping the case would remove
coverage. All history, navigation trace and address assertions stay in place.

### Index row: kept Finished, with the platform runs explained (2026-11-10 housekeeping)

The folder index said Finished Yes while its rating reason said Linux headless
and shown-window qualification were untested, which read as open work. Both
tasks are done and the cause was platform-independent, so the Finished side is
right. Chosen: keep the file as Finished (it is linked from flakes 0620 and
0622 and from 0042's evidence log, as 7081 and 7470 are kept for theirs) and
say in the row and under Needs verification why no platform run is owed.
Re-opening it for a confirmation run was the alternative; it would add a task
to a finished file, which the to-do rules do not allow.

## Current state

The corrected case passed in the two-case targeted Electron run and in the
complete Electron rerun (`svc0042-review-electron`), where the changed owner
passed 24/24. All five Back rounds traced `/`, and the ordered stale Back/link
checks passed. The full suite remains red in other specs; to-do 0042 records
those failures and their evidence.

## Needs verification

Nothing is owed. Linux headless and shown-window runs were not performed
during this fix, but the cause was in the test's synthetic request (no
`environmentId`), not in a platform path: the same check failed with the same
message on Linux headless (beelink) and on macOS hidden windows, and the
manager's identity rule that replaced the view does not depend on the window
mode. A later complete headless owner run on Linux will exercise the corrected
case as a matter of course; a failure there would be a new to-do.

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) (evidence
  log, 2026-11-04 and 2026-11-06)
- [Flake 0622](../../tests/flaky-tests/previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md)

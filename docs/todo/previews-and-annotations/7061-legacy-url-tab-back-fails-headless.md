# The legacy URL tab Back case fails every headless Electron run

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`. Found while running the
complete service preview Electron owner for to-do 0042 task 11.

### Tasks

1. **Find whether it is headless-only or broken on `main`**: run the case on a
   disposable display, and headless with a trace. Status: open.
2. **Fix the case or the product, by what task 1 finds**. Status: open
   (depends on 1).

### 1. Find whether it is headless-only or broken on `main`

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
disposable one, and runs must not use the signed-in desktop. Not recorded as a
flake, because it has never passed here.

**Decisions.**

- **How to find out?**
  - **One run under Xvfb or on macOS, then a headless run with the trace kept
    (recommended).**
    - Pros: tells a headless-only Chromium difference from a product
      regression in one pass; the trace shows the navigation order.
    - Cons: needs a host with a disposable display.
  - **Read the trace of a headless run only.**
    - Pros: runs here.
    - Cons: cannot say whether a real window behaves differently.

### 2. Fix the case or the product

**Problem.** Until it passes, the cases after it in the owner do not run in a
complete headless run.

**Context.** Depends on task 1.

**Investigation.** None yet.

**Decisions.**

- **If it is headless-only, what then?**
  - **Make the case wait for the state it needs rather than skip it headless
    (recommended).**
    - Pros: keeps the check on every platform.
    - Cons: only possible if the difference is timing, not behaviour.
  - **Skip it headless.**
    - Pros: unblocks the owner at once.
    - Cons: loses the check on Linux CI's headless path; repository rules
      prefer fixing to skipping.

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) (evidence
  log, 2026-11-04 and 2026-11-06)
- [Flake 0622](../../tests/flaky-tests/previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md)

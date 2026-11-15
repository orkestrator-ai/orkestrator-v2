# Signals three flaky tests need before they can stop waiting on the clock

## Task analysis

Analysed 2026-11-15 against `main` at `538479aba`.

### Tasks

1. **Expose when an environment's file list is current**, so `serves the Files panel from the scan the badge already ran` can wait for it (flakes 2404 and 9854). Status: open.
2. **Let a `--wait` client say it is observing**, so the CLI `client-exit` scenario interrupts it only after it holds the submission response (flake 9869). Status: open.
3. **Report the packaged backend's startup progress**, so its boot test can tell a slow start from a stuck one (flake 0080). Status: open.

All three came out of the 2026-11-15 flake sweep (branch
`fix-flaky-tests-57033d2a4f0e-r1`), which replaced most timing-based checks
with explicit signals. These three were left open because the signal a test
would wait on does not exist yet: each needs a small product change first.

### 1. Expose when an environment's file list is current

**Problem.** `apps/backend/tests/commands-integration.test.ts` › `serves the
Files panel from the scan the badge already ran` asserts that the Files panel
reuses the diff badge's scan, that is, that its read runs no `git status` of
its own. Under CPU contention it fails: the panel's read scans again. It is
recorded twice, as flake 2404 (macOS, Linux) and in the remaining part of
9854.

**Context.** `apps/backend/src/core/diff-stats-service.ts` keeps a
`dirtyEpoch` per tracked environment. A scan records the epoch it started
from, and a hint, track or refresh advances it (around line 1301), so a hint
that arrives during a scan makes that scan's file list stale and the next
read scans again. That is correct behaviour. The test's precondition, that
nothing dirtied the entry after the badge's scan, depends on when the file
watcher finishes establishing, which the test cannot see.

**Investigation.** Reproduced on Linux on 2026-11-15 (case 2404, "Reproduction
and cause"): under `scripts/test-under-contention.ts --burners 6`, `-t` on this
test failed 10 of 10. Temporary instrumentation showed a watcher hint with no
paths arriving while the badge's first scan was running (about 2 s before it
settled), moving the epoch from 1 to 2. At the read the watcher was qualified
and nothing was in flight. Freezing the clock at the read did not help, so
the 3 s unwatched cache age (`DIFF_CACHE_MAX_AGE_MS`) is not the cause; case
9854's partial fix records the same negative result. Whether a newly
established watcher should send that hint at all, when the scan it would
invalidate started after watching began, is an open product question.

**Decisions.**

- **What should the test wait for?**
  - **A "current" signal from the service (recommended).** For example the
    `environment-diff-stats-changed` event, or a test-visible method,
    carrying the epoch its file list was scanned at and the entry's current
    `dirtyEpoch`; the test waits until they are equal and no scan is in
    flight, then reads the panel.
    - Pros: deterministic at any host speed; asserts exactly what the test
      means ("the panel reuses a scan that is still current"); the same
      signal can tell the renderer when its badge is up to date.
    - Cons: widens the service's event payload or adds a method; the event
      is part of the renderer contract, so check
      `docs/architecture/version-compatibility.md` before changing it.
  - **Stop the establishing watcher's hint when the scan already covers it.**
    - Pros: removes a redundant rescan in production, not just in the test.
    - Cons: needs proof that the hint can never carry a change the scan
      missed; a wrong call loses a real file change, and the test would
      still race any other late hint (the fixture's own write of
      `tracked.txt`).
  - **Wait for the watcher to be qualified before the badge scan.**
    - Pros: test-only.
    - Cons: qualification is not the last hint, as the instrumented run
      showed (the watcher was qualified at the read), so it narrows the race
      without closing it.

### 2. Let a `--wait` client say it is observing

**Problem.** The CLI scenario `client-exit` (`packages/cli/scenarios/cases.ts`,
around line 493) starts `environment start --wait ready`, sends SIGINT after a
fixed 2.5 s (`signalAfterMs` in `packages/cli/scenarios/harness.ts`), and
expects the interrupted client to print a receipt. On a loaded host the
client has not received the submission response by then, so it exits 130
`observation-interrupted` with no receipt (flake 9869).

**Context.** The client can only print a receipt once the backend has
answered the submission; before that it has nothing to print, and that
behaviour is correct. The scenario is checking that an interruption *during
observation* still yields a receipt, but it guesses when observation begins.
`submitForWait` in `packages/cli/src/client/commands/common.ts` is the point
where the response arrives and observation starts.

**Investigation.** From the code (case 9869, triage 2026-11-15); the scenario
suite was not run. Polling `run get --request-id` from the scenario to wait
for admission would not help: admission can happen before the response
reaches the client.

**Decisions.**

- **How does the scenario learn the client is observing?**
  - **A machine-readable progress line on stderr when observation starts
    (recommended).** For example one JSON line `{"type":"observing",
    "operationId":...}` under `--json`/`--jsonl`, written right after the
    submission response arrives; the harness watches stderr for it and sends
    the signal then.
    - Pros: deterministic; useful to any wrapper that wants to show "waiting
      for ready"; carries no prompt or secret (receipts stay content-free).
    - Cons: a new line in the CLI's output contract, so it needs an entry in
      `docs/architecture/public-cli.md` and must not break existing
      `--jsonl` consumers (stderr, not stdout, keeps stdout's record stream
      unchanged).
  - **An environment-variable hook only the scenario harness sets.**
    - Pros: no public output change.
    - Cons: a test-only code path in the shipped CLI, and the scenario no
      longer exercises the build users run unchanged.
  - **Raise the 2.5 s delay.**
    - Pros: trivial.
    - Cons: still a timed check that a slow enough host loses; it also stops
      testing an early interruption at all.

### 3. Report the packaged backend's startup progress

**Problem.** `packages/cli/tests/cli-packaged-backend.test.ts` boots the
packaged backend and waits for its `orkestrator-backend-ready` JSON line on
stdout (`apps/backend/src/main.ts`, around line 364). Under extreme
contention the line does not arrive in time and the test fails with
`Packaged backend did not become ready:` followed by an empty stderr (flake
0080). Nothing tells the test whether the backend is still starting or stuck.

**Context.** The 2026-11-15 sweep made the test's readiness and exit waits
hang watchdogs (90 s and 60 s, test budget 180 s) on the real readiness line
and exit. The helper keeps only stderr for its error message and throws away
the human-readable startup lines it reads from stdout, so a failure currently
records nothing about how far startup got.

**Investigation.** Case 0080, triage 2026-11-15: on one core with six busy
loops (load around 140), `main`'s file failed 5 of 5 at its 20 s deadline and
the changed file still failed 5 of 5 at 90 s; on a quieter core both passed 3
of 3; alone it passes in 2.3 s. Slow versus stuck is not established.

**Decisions.**

- **How can the test tell slow from stuck?**
  - **Startup phase lines from the backend, and a no-progress watchdog in the
    test (recommended).** The backend writes one JSON line per startup phase
    on stdout, for example `{"type":"orkestrator-backend-startup",
    "phase":"storage-open"}`, before the ready line. The test fails only when
    no new phase arrives for a bound, and its error names the last phase
    reached.
    - Pros: the same pattern as the aggregate runner's per-test dots: a slow
      start keeps going and a stuck one fails, naming where it stopped;
      launchers (desktop, CLI) can show startup progress too.
    - Cons: an additive change to the backend's launch protocol that every
      launcher must ignore safely (they already skip non-ready lines, but
      check `docs/architecture/version-compatibility.md`); the phases must
      carry no paths, tokens or other secrets.
  - **Keep the stdout startup lines and timings in the test's failure
    message only.**
    - Pros: test-only; would show at once where a failing start stopped.
    - Cons: diagnoses the next failure but still decides pass or fail on a
      deadline; do it as a first step if task 3's product change waits.
  - **Raise the watchdog again.**
    - Pros: trivial.
    - Cons: 90 s already failed under the same load, and it cannot separate
      slow from stuck.

## Related

- Flake cases 2404 and 9854 (task 1), 9869 (task 2) and 0080 (task 3) under
  [`docs/tests/flaky-tests/`](../../tests/flaky-tests/0000-index.md); each
  case's 2026-11-15 section has the evidence above.
- [Testing guide, "Controlled time"](../../development/testing-guide.md#controlled-time):
  wait for an explicit signal, not wall time.
- `scripts/test-progress-dots.ts`: the progress-based watchdog task 3's
  recommendation follows.

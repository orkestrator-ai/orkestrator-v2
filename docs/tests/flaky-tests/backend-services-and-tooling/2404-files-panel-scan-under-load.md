# Electron backend command registry > backend-owned diff statistics > serves the Files panel from the scan the badge already ran

- **ID:** 2404
- **Status:** open
- **Test:** `Electron backend command registry > backend-owned diff statistics > serves the Files panel from the scan the badge already ran`
- **File:** `apps/backend/tests/commands-integration.test.ts`

On 2026-11-02, during the shared-logger bridge migration, this failed once in `mise run test:slow, run alongside the Electron suite` after 1228.22 ms, with the host at a load average near 55. Failed under heavy load. The owner then passed alone (0 fail):

```sh
cd apps/backend && bun test ./tests/commands-integration.test.ts --preload ../../tests/setup-node.ts --only-failures
```

That change does not touch this test's code. This records the intermittency; no cause is established.

## Recurrence (2026-11-06, macOS)

During 0048's macOS qualification (branch `macos-recurring-work-a14778996478-r1`,
on `c1724ab74`), the whole owner failed once in a one-worker run, with a
`dev:test` profile and a Docker container running on the same host:

```sh
mise run test:logged -- --name cmd-integration -- \
  bun --cwd=apps/backend test ./tests/commands-integration.test.ts --parallel=1
```

58 tests, 1 fail at 1507 ms: the Git subcommand log was not empty, it held
one `git status --porcelain=v1 -z --untracked-files=all` of the test's
worktree, so the Files panel read ran its own status instead of reusing the
badge's scan. The same command passed on the next run (58 pass, 32.6 s).

Selecting the case alone with `-t "serves the Files panel from the scan the
badge already ran"` fails every time, on the branch and with its backend
changes set aside (that is, on `c1724ab74`'s backend code). So `-t` is not a
valid isolated rerun for this case; rerun the whole owner. This suggests
the case relies on state an earlier case in the file sets up, which is a
lead, not an established cause.

## Recurrence (2026-11-10, macOS)

On branch `container-env-debug-b785ed0a2251-r1` (base `6c3aa9b6d`), during
review fixes to setup-terminal retirement, the case failed twice with the same
symptom: one `git status --porcelain=v1 -z --untracked-files=all` in the Git
subcommand log. First in a 15-file focused run (`--parallel=4`, 271 pass,
1 fail), then with the whole owner run alone:

```sh
mise run test:logged -- --name commands-integration-alone -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./tests/commands-integration.test.ts --only-failures
```

58 tests, 1 fail at 1023 ms. That branch's changes do not touch diff
statistics or Git scans. `-t` alone with `main`'s backend code (`main` was
ahead of the branch base) also failed, as the previous entry predicts. No
`mise run flaky:recurrence` was run for this entry, so it is not yet counted
as a recurrence.

## Reproduction and cause — 2026-11-15 (Linux, base `a8b89f154`)

- **Reproduced:** yes, on Linux, with `-t` alone under CPU contention: `mise run test:logged -- --name f2-ci-cont -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts -t "serves the Files panel from the scan the badge already ran" --rerun-each=10` failed 10 of 10 (the recorded `git status --porcelain=v1 -z --untracked-files=all` in the subcommand log; some reps also hit the file's then 30 s budget). Without contention the same `-t` run passed.
- **Cause (observed with temporary instrumentation, since removed):** a watcher hint with no paths arrives while the badge's first scan is still running (about 2 s before it settles under contention). The hint advances the entry's `dirtyEpoch` from 1 to 2, so the published file list (epoch 1) is already stale, and the Files panel read correctly scans again. At the read the watcher was qualified, nothing was in flight, and the read came 70–500 ms after the announcement, so the 3 s unwatched age bound (`DIFF_CACHE_MAX_AGE_MS`) is not the cause. Freezing the clock at the read did not help, which confirms that.
- **Disposition:** open. The product behaviour looks correct (a hint during a scan invalidates it); the test's precondition, that nothing dirtied the entry after the badge scan, depends on when the watcher establishes. A deterministic test needs a public signal that the entry's file list is current (for example, wait for the hint-driven rescan to settle) and none is exposed today. Whether the establishing watcher should hint at all when the scan started after it began watching is a product question left open.

- **Follow-up (2026-11-15):** the product signal this test needs is to-do [8302](../../../todo/cross-cutting/8302-signals-for-deterministic-flake-fixes.md).

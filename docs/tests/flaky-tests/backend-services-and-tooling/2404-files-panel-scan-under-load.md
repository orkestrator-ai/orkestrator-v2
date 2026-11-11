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

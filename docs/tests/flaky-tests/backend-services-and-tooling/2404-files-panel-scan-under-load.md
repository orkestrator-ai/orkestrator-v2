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

# public_action contract > capabilities reports the package version without launcher metadata

- **ID:** 2405
- **Status:** resolved
- **Test:** `public_action contract > capabilities reports the package version without launcher metadata`
- **File:** `apps/backend/src/core/public-api/public-api-projects.test.ts`

## Real cause

Not a timeout. The test runs a child process and parses its stdout as JSON.
`moveChangeLedgerMigration` (`change-tracking/ledger-schema.ts`) logged
`[storage] ledger.moved rows=0` at info on every fresh database, into that same
stdout, so the parse failed every time. On 2026-11-05 at `41f9eb638` the owner
failed alone in 818.58 ms (24 pass, 1 fail):

```text
SyntaxError: JSON Parse error: Unexpected identifier "storage"
```

```sh
mise run test:logged -- --name pubapi -- bun --cwd=apps/backend test src/core/public-api/public-api-projects.test.ts --parallel=1 --only-failures
```

## Fix

The migration now logs `ledger.moved` only when rows moved
(`only a move that carried rows logs ledger.moved` in
`change-tracking/ledger-file.test.ts`). The same command then exits 0. The test
was not changed.

## Earlier record

The first entry here described this test as hitting the 5 s timeout: on
2026-11-02, during the shared-logger bridge migration, it failed once in
`mise run test:slow, run alongside the Electron suite` after 5012.96 ms, with
the host at a load average near 55, and passed alone. That observation does not
match the deterministic failure above, and `ledger.moved` reached this form on
`main` with `e8959f0fd` (#1810) on 2026-11-05, after it. Nothing shows what
caused that one timeout. A new timeout on this test should open a new case.

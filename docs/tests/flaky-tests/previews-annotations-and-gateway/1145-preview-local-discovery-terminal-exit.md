# Local preview discovery fixture terminal exits before reporting its port

- **ID:** 1145
- **Status:** open
- **Observed:** 2026-10-27, todo 0223 branch validation
- **Test:** `local preview service discovery on this host > two environments, a restart on the reused port, and an auto-incremented port`
- **File:** `apps/backend/src/core/previews/local-discovery.test.ts:531`

Failed twice in the backend workspace aggregate on the 0223 branch (a focused
`bun test --cwd apps/backend src/core tests --parallel=6` run, then the second
`mise run test`; 468.78 ms), each time with `terminal exited 0`: the fixture
shell exited before its first stdout line reported a port. The 0223 change
does not touch preview discovery or this fixture.

The complete unchanged owner passed alone on the branch and on a detached
worktree of its base `863b57821` (19 passed each):

```sh
bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/previews/local-discovery.test.ts
```

Host load during the aggregate is a hypothesis, not an established cause. No
assertion, timeout, skip or implementation changed. Aggregate evidence:
`orkestrator-test-run.38P3gc` under the host temporary directory.


## Storage-maintenance review fixes recurrence (2026-10-27–28)

On `local-env-disk-fccbc2f7869f-r1`, based on `55f7adb3e`,
`mise run test:logged -- --name default-suite -- mise run test` (two backend
workers) failed this same case after 693.88 ms with `terminal exited 0`.
The preceding fixture listener reported `EADDRINUSE` on `127.0.0.1:61856`.

The complete unchanged owner passed alone (19 tests, exit 0, 5.5 s):

```sh
mise run test:logged -- --name preview-discovery-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/previews/local-discovery.test.ts --parallel=1 --only-failures
```

Aggregate evidence is under the host temporary directory in
`orkestrator-test-run.ppPDQr/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
A fixture port-allocation race is a hypothesis; no preview implementation or
fixture changed. The aggregate remains non-green.

The completed aggregate backend group reported 12,711 passed, 25 failed and
123 skipped across 12,859 tests in 779 files (1025.56 s). The complete default
run exited 1 after 1132.9 s; desktop, root and Claude bridge tests added six
failures, all in files outside the storage-maintenance fixes. The new storage
and retention regressions and the focused change-tracking suite passed, as did
formatting, lint and typechecking. The run does not establish that every
aggregate failure is pre-existing. Browser, Electron, Docker and iOS scenario
suites were outside this backend-only follow-up's scope; production-scale
maintenance timing and packaged/cross-platform copy behavior remain unmeasured.

## Investigation — 2026-11-10

Still open; not reproduced. The fixture's `; true` turns any exit of the
server script into `terminal exited 0`, so the recorded symptom only says the
Bun script exited (the 2026-10-28 stderr showed an EADDRINUSE throw).
Its `once("error")` handler retries EADDRINUSE on the next port, so the
throw needs a second error emission or a synchronous throw from `listen`.
Running the script 240 times, four processes at once, against a held
`127.0.0.1` port (host load about 58) never exited early: every run reported
the next port. Next step: on a recurrence, keep the script's stderr
in the failure message.

## Triage note (2026-11-15)

Partly addressed; stays `open`. In `apps/backend/src/core/previews/local-discovery.test.ts` every poll deadline (2 s, 5 s, 10 s) is now a named 30 s `POLL_HANG_WATCHDOG_MS`, the explicit 20 s/30 s test budgets are removed (the 60 s default applies), and the fixture script retries an `EADDRINUSE` on an ephemeral (`port 0`) request instead of throwing (up to 100 attempts). The recorded `terminal exited 0` with an `EADDRINUSE` on 61856 is still unexplained (that path already retried on the next port), so the cause is not established. The owner passed under contention (`b-cont`, see 0340).

## Deterministic failure from the 2026-11-15 rewrite (2026-11-16)

Not a recurrence of the intermittent case; stays `open`. On the to-do 0012
`previews` slice, based on `c1fcc573b`, the owner failed alone, every time:
`a dual-stack wildcard listener resolves the owning worktree over IPv4 and
refuses another` and `two environments, a restart on the reused port, and an
auto-incremented port` with `terminal exited 0`, 17 passed and 2 failed
(19 tests, 3.5 s):

```sh
NODE_ENV=test mise run test:logged -- --name previews-local-discovery -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/previews/local-discovery.test.ts --parallel=1 --only-failures
```

Cause: the triage note's fixture rewrite added the comment "another test's
listener grabs the kernel's pick first" inside the server script, and the
script reaches `/bin/sh -c` inside single quotes, so the apostrophe ended
the quoted argument. Bun reported `Unexpected end of file` at `[eval]:7:38`,
the end of "another test", and the shell's `; true` turned that into exit 0.
The file's text on `c1fcc573b` is the same apart from the slice's import
paths; the base was not run separately. The slice rewords the comment
without an apostrophe and notes the rule beside the script; the same command
then passed (19 tests, 4.8 s). The default suite does not run this owner
(it is in the slow tier), which is why aggregates stayed green. The original
intermittent `terminal exited 0` is still unexplained.

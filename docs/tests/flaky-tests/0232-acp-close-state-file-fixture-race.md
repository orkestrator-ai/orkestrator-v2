# ACP close state-file failure fixture races a writer

- **ID:** 0232
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `POST /session/:id/close > a failed state-file write answers pending and keeps the session registered`
- **File:** `bridges/acp-bridge/src/acp-session-close.test.ts:416`
- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-latest-full-suite -- mise run test`.
- **Worker configuration:** workspace four slots, root one, bridges two (one Bun worker per bridge task), protocol check one. The component browser suite also ran on the host.
- **Failure:** `EEXIST` creating the directory at `state/state.json` immediately after removing the state file; test duration 247.64 ms.
- **Suite counts:** ACP 503 total, 499 passed, three skipped, one failed. Turbo interrupted the still-running Codex bridge task after the ACP failure.
- **Isolated rerun:** `mise run test:logged -- --name merge-acp-close-isolated -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-session-close.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, wrapper duration 5.4 seconds.
- **Evidence:** `bridges.log.gz` in `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uJ6Ien/`.
- **Hypothesis:** an outstanding state write may recreate the file between the fixture's remove and mkdir operations. The observed EEXIST and passing isolated rerun support a timing-sensitive fixture, but do not establish the writer responsible. No production code or test assertion was changed.

## Recurrences on GitHub Actions `main` (2026-10-15)

- **Original command:** `mise run test` in the `Unit and integration tests` job
  of `lint.yml` on `ubuntu-latest` (four vCPUs); bridges group two slots, one
  Bun worker per bridge task.
- **Runs:** 38698449919 (`39fc12b2`) and 38748749506 (`9fb4e6a8`).
- **Failure:** the same `EEXIST` from `fs.mkdir(bridge.stateFile)` at line 416,
  in 231.86 ms and 239.14 ms.
- **Suite counts:** ACP 499 pass, 3 skip, 1 fail of 503 (run 38698449919) and
  503 pass, 3 skip, 1 fail of 507 (run 38748749506).
- **Isolated rerun (macOS arm64):** `mise run test:logged -- --name
  rerun-acp-session-close -- bun --cwd=bridges/acp-bridge test
  src/acp-session-close.test.ts --preload ../../tests/setup-node.ts
  --parallel=1 --only-failures` passed all 16 tests, wrapper duration 5.5 s.
- No test or production code was changed.

## Recurrence on GitHub Actions (2026-10-16)

- **Run:** 38904039434, `Unit and integration tests` job of `lint.yml`
  (`mise run test`, ubuntu-latest).
- **Failure:** `EEXIST: file already exists, mkdir '/tmp/acp-bridge-test-KIqx8y/state/state.json'`
  at `acp-session-close.test.ts:416:14`, 266.53 ms, in the same ACP run as 0249.

## Root cause

The writer is the turn's own completion. The prompt completion handler in
`bridges/acp-bridge/src/acp-http.ts` sets `state.status = "idle"`, bumps the
revision and calls `schedulePersist()`, which writes `state.json` (temporary
file plus `rename`) on a 25 ms debounce (`src/acp-persist-writer.ts`). The
test's `waitForStatus(id, "idle")` can observe idle before that write lands.
When the write's `rename` fell between the fixture's `fs.rm(stateFile)` and
`fs.mkdir(stateFile)`, it recreated the file and the `mkdir` failed with
`EEXIST`. Production behaviour is correct; the fixture removed the file while
a write it had triggered was still pending.

The alone-run did not reproduce it (50 of 50 passed), but a temporary
`Bun.sleep(40)` between the `rm` and the `mkdir` made the unchanged test fail
10 of 10 with the recorded `EEXIST`, confirming the debounced write as the
writer.

## Fix (this branch)

`bridges/acp-bridge/src/acp-session-close.test.ts`: after the session reports
idle, the test waits until `state.json` holds this session at the live
revision from `GET /session/:id/status`. Only the completion write carries
the final revision, and nothing schedules another write once the turn has
settled, so the bridge is quiescent before the fixture swaps the file for a
directory. No production code, assertion, timeout or skip changed.

## Verification

From `bridges/acp-bridge`, on macOS arm64 with other worktrees' suites running
(load average 27-52 on 18 cores):

- `bun test src/acp-session-close.test.ts --preload ../../tests/setup-node.ts -t "failed state-file write" --rerun-each 100`:
  100 pass, 0 fail.
- With the temporary `Bun.sleep(40)` between `rm` and `mkdir`, 20 reruns: 20
  pass after the fix (10 of 10 failed before it; the sleep was removed again).
- `bun run test:bridge` (package suite, `--parallel=1`) three times in a row
  at load averages 52, 48 and 36: each 579 pass, 3 skip, 0 fail across 37
  files (76.6 s, 72.3 s, 67.9 s).
- `bun run typecheck`: exit 0. `bunx oxfmt` and `bunx oxlint` on the file: clean.

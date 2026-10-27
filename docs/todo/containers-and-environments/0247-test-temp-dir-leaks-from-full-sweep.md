# Test temporary-directory leaks found by the full sweep

Checked against `main` at `ce205ad34` plus the 0247 branch at `8268be981`
(2026-10-26) and at `0c77d9b46` and `39980f699` (2026-10-27, the
verification follow-up).

[0023](0023-environment-and-disk-cleanup.md) fixed the test temp-directory
leaks it listed. Its 2026-10-26 sweep then ran the bridge and backend suites
with a private `TMPDIR` and found many more directories left behind, plus one
test that reads the host's real state. This file holds that newly found work;
0023 does not take new items.

The code fixes include the review follow-up below (2026-10-27). The
acceptance verification's own private-directory sweep then left five more
directories (three Claude bridge session fixtures, the live MCP-calls probe
root and one preview scratch); their causes are fixed in the verification
follow-up (2026-10-27). The repeat sweep after it left only the by-design
entries and one ACP bridge root, whose cause (and the same one in the
protocol package) is fixed and rechecked; see
[the 2026-10-27 sweeps](#verification-sweep-and-repeat-sweep-2026-10-27).
Qualification still needs
the original Arch Linux host, where `ork-env-move-*` leaked and macOS never
reproduced it. The repository-wide test result remains non-green; the recorded
baseline failures must not be read as a passing acceptance run.

## Current state

- How the original inventory was taken (omarchy-hp, Arch Linux x86_64): an
  empty `TMPDIR=/tmp/ork0023-sweep/tmp`, then `test:bridge` in each of the
  five bridges, for example
  `mise exec -- bun run --cwd bridges/codex-bridge test:bridge` (all five
  passed), and `mise exec -- bun run --cwd apps/backend test:workspace`
  (11,721 passed, 142 skipped, 2 failed: flake 0785, and the test in Code
  item 3). They were run outside Turbo because `mise run test` ran these
  groups through Turbo's strict environment mode, which did not pass `TMPDIR`
  through.
- What each leak was and how it is removed now (2026-10-26). "Reproduced"
  means that on macOS (arktech-mini, Darwin 27.0, arm64), with an empty
  private `TMPDIR`, the baseline sweep at `ce205ad34` or a direct run of the
  owning file left the directory before the fix, and the same run after it
  left none.

  | Left behind | Cause | Fix | Reproduced |
  | --- | --- | --- | --- |
  | `claude-mcp-sync-*` | `run()` in `session-manager-prompt-mcp-sync.live-probe.ts` removed the root right after `control.close()`; the closing CLI then wrote `home/Library/Caches/claude-cli-nodejs/.../mcp-logs-*` into it. | The probe spawns the CLI through `spawnClaudeCodeProcess` and awaits its exit before the removal. | Yes, 5 before, 0 after. |
  | `ork-runtime-*` | `app-server-runtime-test-harness.ts` removed `CODEX_HOME` in `afterEach` while the runtime's dispatch journal still had a write queued (`orkestrator-bridge/dispatch-journal-*.json`). Seen from the lifecycle and prompt files. | The harness records every runtime it builds and `afterEach` awaits `runtime.stop()` (which drains pending work) before the removal. | Yes, 4 before, 0 after (485 tests). |
  | `orkestrator-state-sync-*`, `ork-terminal-history-*`, `ork-command-registry-data`, `ork-commands-io-history-<pid>` | Closing a terminal disposes its history without awaiting it (`TerminalRuntime.explicitlyCloseSession`), and completion, disposal and pruning write `terminal-history/*/manifest.json` after the command returns. The last two were also fixed paths nothing removed. | New `TerminalHistory.settled()`, awaited after `runtime.shutdown()` by `commands-state-sync.test.ts`, `terminal-history.test.ts`, `commands-io-coverage.test.ts`, `commands-registry-coverage.test.ts` and `environment-move.test.ts`. The two fixed paths are now `mkdtemp` directories removed in `afterAll`. | Yes, all four in the baseline sweep; state-sync also directly (2 before, 0 after). |
  | `ork-env-move-*` | Not established: the file left none on macOS, alone or under host load average 12 to 19, before or after the change. | Defence in depth: the `afterEach` also settles terminal history, and the roots and the template are named through `ownedTempDirPrefix`, so `sweepStaleTempDirs` at the top of the file removes those of dead owners after an hour and legacy names without a PID after a day. | No. |
  | `claude-client-session-restart-*`, `claude-dispatch-journal-*`, `claude-metadata-noop-*` (found by the verification sweep, 2026-10-27) | Each held only `.claude/orkestrator/session-preferences/<id>.json` containing `{}`: the turn-in-flight clear write, which a turn queues without waiting (`writeTurnInFlightMark` in `session-manager-turn-interruption.ts`). The session-manager fixtures restored the suite's Claude home and removed their private one straight after the body, while the harness's `afterEach` settled preference writes only later. | New `releaseTemporaryClaudeHome()` in `session-manager-test-harness.ts` restores the home, awaits `settleSessionPreferenceWritesForTesting()` and the terminal-command writes, then removes the directory. `withTemporaryClaudeHome` and the 21 inline removals in five session-manager test files use it. | Evidence is the verification sweep's leftovers (contents above); 18 direct runs of the owning file at load 84, with the old and with the new harness, left none, so the before/after is not reproduced. The full `test:bridge` with the fix left nothing (1,706 pass). |
| `claude-mcp-calls-*` (found by the verification sweep) | The same as `claude-mcp-sync-*`, in the second probe: `runMcpCallProbe` in `session-manager-prompt-mcp-sync.live-calls.ts` removed its root once the stream ended, while the closing CLI was still writing `Library/Caches/claude-cli-nodejs/.../mcp-logs-*` and its project transcript under it (both in the leftover). | It spawns the CLI through `spawnClaudeCodeProcess` and awaits its exit before the removal, like `run()`. | Not reproduced directly (two direct runs left none before the fix); covered by the sweep after it. |
| `ork-artifact-preview-*` | The backends `apps/backend/tests/standalone.test.ts` starts (the baseline sweep never ran them: its checkout had no `dist/`). Every backend start runs the preview availability probe, whose worker the runner did not track, so a backend stopping mid-probe exited without cancelling it; and a backend whose Tailscale Serve setup failed exited without `backend.shutdown()`. The `transcript-artifacts` tests themselves (323 pass, real Chromium in process mode) left none. | `TranscriptPreviewRunner.close()` cancels the probe's worker and waits for its verified exit; gateway startup in `main.ts` uses `startGatewayServices` to shut the backend down on failure, even if another cleanup rejects; scratch is PID-named and swept at startup (Code item 2). A third cause, found by the verification sweep (one `ork-artifact-preview-<pid>-*` holding a Chromium profile): a worker killed while Playwright was still launching Chromium orphaned the browser in its own process group, outside the kill; the kill verified, and the browser re-created its profile in the removed scratch. `killTree` now also owns any process whose command line names the job's scratch (Chromium's `--user-data-dir`) and needs a second empty scan (Code item 2). | Yes, 5 before, 1 after the `close()` fix, 0 after the `main.ts` fix (two runs). The third cause: 1 of 3 concurrent `standalone.test.ts` runs, and 7 of 72 direct SIGTERMs of a `dist` backend during its probe (5 of 40, 2 of 32), left one; instrumented, every such case was a verified kill with no browser PID known. After the fix 0 of 48. |
  | `mcp-mgmt-*` | A timer-started apply pass (`McpManagementService.tick`) still wrote `data/mcp-management/operations.json` after `dispose()`; seen from `service-apply.test.ts`. | New `McpManagementService.settled()`; the fixture's `cleanup()` is async, awaits it, and every caller awaits `cleanup()`. | Yes, 1 before, 0 after (441 tests, twice). |
  | `ork-clone-capacity-*` | The last clone the test started was still running at teardown and created `.orkestrator-clone-*` in the removed root. | The test waits for that clone to fail before returning. | Yes, before in the baseline sweep; 0 after in three runs. |
  | `media-stream-*` (a `staging/` directory) | `TranscriptMediaStreams` re-creates its staging root at construction without awaiting it; `dispose()` did not wait, so the `mkdir` landed after the test removed the root. | `dispose()` awaits the staging-root work. | Yes, 3 of 3 before, 0 of 3 after. |
  | `ork-backend-activity-event-<uuid>`, `ork-backend-activity-stamp-<uuid>`, `ork-backend-interaction-env` | `index.test.ts` passed these data directories to `OrkestratorBackend` and never removed them. | `mkdtemp` directories removed after `backend.shutdown()`. | Yes, before in the baseline sweep; 0 after. |
  | `outside-profile.bin` | `commands-io-coverage.test.ts` wrote the "outside" file next to a worktree directory that sat directly in the temporary root. | The worktree directory is now inside a test-owned root, so the outside file is too. | Yes, before in the baseline sweep; 0 after. |

- `acp-bridge-test-*` (found by the 2026-10-27 repeat sweep, one, holding
  `entries.jsonl`) and `ork-spool-*` (the same shape in the protocol package,
  found by reading for it): a restart test restored a second
  `ChangeEvidenceSpool` from the directory and never awaited the compaction
  rewrite its constructor queues. Both tests now flush it before teardown
  (4 of 12 and 3 of 12 runs left one before, 0 of 12 after).
- `ork-backend-core-*` (found by the first macOS qualification sweep, one
  `data/design-canvases/index.json`): `backend-core.test.ts` initialised a
  backend it never shut down, and startup work wrote after the directory was
  removed. The test now shuts it down (1 of 3 runs before, 0 of 3 after).
- The macOS baseline sweep also found four Pi bridge prefixes the Arch sweep
  did not list, and a direct run of one owning file a fifth:
  `pi-bridge-http-persist-*` (`http.test.ts`), `pi-cancel-write-delete-*` and
  `pi-cancel-write-fail-*` (`http-cancel-startup.test.ts`, the second from the
  direct run), `pi-bridge-command-changes-*` and
  `pi-bridge-change-evidence-*`. Each was intermittent. Each held a `state.json` (or, for change
  evidence, `change-evidence/entries.jsonl`) written after the test removed
  its state directory: `schedulePersist` writes behind a queue, and a write
  already running keeps the path it read. Fixed here (decision 6): the new
  test-only `settlePersistenceForTests()` in `bridges/pi-bridge/src/persistence.ts`
  is awaited after clearing `PI_BRIDGE_STATE_DIR` and before removing the
  directory, in the eight Pi test files that do both, and the change-evidence
  teardown flushes its spool. Each of the four files then left nothing in three runs.
- `tests/temp-sweep.ts` (`createOwnedTempDir`, `sweepStaleTempDirs`) is the
  fallback for prefixes that cannot be removed at source; `ork-env-move-` and
  `ork-env-move-template-` now opt in.
- `mise run test` now passes `TMPDIR` through Turbo (`globalPassThroughEnv` in
  `turbo.json`, decision 4). Before the change a `test:bridge` process started
  by Turbo had no `TMPDIR` in its environment (read with `ps -E`), so on macOS
  it used `/tmp` instead of the per-user directory; after it, the process had
  the caller's value.

## Outstanding work

### Code

1. ~~Remove the leaks in the table at source (or, where that is impossible,
   opt the prefix into `tests/temp-sweep.ts`).~~ Done 2026-10-26; see the
   table above. Every prefix is removed at source by the test that made it,
   after whatever wrote into it has settled. `ork-env-move-*`, whose writer
   was not found, is additionally covered by `tests/temp-sweep.ts`, and
   `ork-artifact-preview-*` by the production startup sweep. The four
   Claude bridge prefixes and the escaped-Chromium preview case found by the
   verification sweep were fixed at source on 2026-10-27 (rows above).
2. ~~Decide whether the preview supervisor itself leaks its scratch directory
   in production.~~ Done 2026-10-26. It does, but only off the normal path.
   Evidence from `transcript-artifacts/preview-supervisor.ts` and
   `preview-runner.ts`: every job ends in `terminate()`, which removes the
   scratch once `killAndVerify()` proves the process tree gone; an unverified
   exit quarantines the slot and the reaper's `reap()` removes the scratch on
   its first verified pass. The scratch is left when the backend is killed
   during a job, or stops while a slot is still quarantined (`stop()` sets
   `stopping`, which ends the reaper), and nothing ever removed it later.
   [0248](0248-playwright-profile-dir-leaks.md) recorded 146 of them in
   `/tmp` on omarchy-hp, from tests or production. The macOS qualification
   then found a third case on the normal path: the availability probe that
   every backend start runs supervised its worker outside the runner's job
   list, so `close()` neither cancelled nor awaited it, and a backend stopped
   during the probe left the scratch (five standalone backends left five).
   `close()` now cancels the probe's worker and waits for its verified exit
   (unit test in `preview-isolation.test.ts`, failing without the fix), a
   probe that starts after `close()` launches no worker, and a standalone
   backend whose Tailscale Serve setup fails shuts the backend down before
   exiting. For what remains, the directory is
   now named `ork-artifact-preview-<backend pid>-<random>`, and
   `createTranscriptArtifactsRuntime` runs `sweepStalePreviewScratch` at
   startup in process mode, the counterpart of `reapOrphanPreviewContainers`
   for container mode. It removes a directory whose backend has exited once it
   is over an hour old, and an older name without a PID once it is over a day
   old; it never touches a live backend's scratch. Unit-tested in
   `preview-supervisor.test.ts`, which also checks the new name and the
   removal after a verified exit. With all three, `standalone.test.ts` left
   nothing in two runs.
   The verification sweep (2026-10-27) found one more scratch, a Chromium
   profile in it, and a fourth case on the normal path: Playwright launches
   Chromium in its own process group, and until the worker reports the
   browser's PID the supervisor knows only the worker. A worker killed in that
   window (a backend stopped during its probe, or a job cancelled or timed out
   early) orphans the browser outside both the tree and the owned groups, so
   `killTree` reported a verified exit, the scratch was removed, and the
   browser wrote its profile back into it. Reproduced with a `dist` backend
   started and sent SIGTERM during the probe, eight at a time: 7 of 72 left
   the scratch; with temporary logging, each was a verified kill with
   `browserPid: null`. `killTree` now takes the scratch path as an ownership
   marker: a process whose command line contains it (Chromium's
   `--user-data-dir`), with its tree and the groups it leads, is killed and
   verified too, and an empty scan must be confirmed by a second one 100 ms
   later, so a browser between fork and exec is not missed. After the fix, 0
   of 48. Unit test in `preview-process-tree.test.ts` (an escaped, marked
   process tree survives a pass without the marker and is killed with it).
   This is production behaviour too, so it was fixed rather than left to the
   startup sweep.
3. ~~Make `process and platform command behavior > controls bridge
   processes, reads logs and preferences, and reports port health`
   hermetic.~~ Done 2026-10-26. `commands-process-coverage.test.ts` clears
   `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`
   for the file and restores them afterwards, so every path resolves under its
   fake `HOME`. With all four pointed at a directory holding a different
   `opencode/model.json`, the unchanged file failed that test (67 pass,
   1 fail) and the changed file passed 68 of 68.

### Qualification

1. ~~Repeat the sweep after the fixes and record what the private `TMPDIR`
   holds.~~ Done on macOS 2026-10-26, and again on 2026-10-27 after the
   verification follow-up (left only the by-design entries plus one ACP
   bridge root, fixed and rechecked), not on the original Arch host; see
   [Qualification results](#qualification-results-2026-10-26).
2. Repeat the same sweep on omarchy-hp (Arch Linux), where `ork-env-move-*`
   leaked and macOS never reproduced it, and confirm the
   `ork-artifact-preview-*` fixes there (see Needs verification).

## Qualification results (2026-10-26)

The 2026-10-27 runs (verification sweep and the repeat sweep after its
fixes) are in [the section after this table](#verification-sweep-and-repeat-sweep-2026-10-27).

Host: arktech-mini, macOS 27.0 (Darwin 27.0.0) arm64, Bun 1.4.4, not the
original omarchy-hp. Both sweeps ran outside Turbo, each with an empty private
`TMPDIR` inside the per-user temporary directory
(`/var/folders/.../T/ork0247-qual*/tmp`, longer than the default, to cover the
Turbo change below), and after `bunx turbo run build --filter=@orkestrator/backend`
so the standalone tests had a `dist/`. The suites were run as
`test:bridge` in each of the five bridges (for example
`mise exec -- bun run --cwd bridges/acp-bridge test:bridge`), then `mise exec -- bun run --cwd apps/backend test:workspace`. Host
load average was 3 to 37 from other worktrees' suites.

| Run | Revision | Result | Left in the private `TMPDIR` |
| --- | --- | --- | --- |
| Baseline (before any fix) | `ce205ad34`, a second checkout | Bridges all passed. Backend 11,994 passed, 115 skipped, 9 failed: nine of the eleven `standalone.test.ts` tests, for the missing `dist/`. | `claude-mcp-sync-*` 5, `ork-runtime-*` 4, `orkestrator-state-sync-*` 2, `mcp-mgmt-*` 2, `ork-terminal-history-*`, `ork-commands-io-history-<pid>`, `ork-command-registry-data`, `ork-clone-capacity-*`, `media-stream-*`, `ork-backend-activity-event-*`, `ork-backend-activity-stamp-*`, `ork-backend-interaction-env`, `outside-profile.bin`, four `pi-*` prefixes, and the intended `orkestrator-mcp-locks-501`, `jiti`, `node-compile-cache`. No `ork-env-move-*` or `ork-artifact-preview-*`. |
| First qualification | `1a1ef24f9` for the bridges, `5eb3f9037` for the backend | Bridges all passed (acp 695, claude 1,706, codex 2,412, cursor 801, pi 651). Backend 11,992 passed, 115 skipped, 13 failed: Git-heavy five-second deadlines in `environment-move.test.ts`, `worktree-snapshots-git.test.ts` and `commands-environment-fork.test.ts`. | `ork-artifact-preview-<pid>-*` 5 and `ork-backend-core-*` 1 (both then fixed, above), plus the intended `orkestrator-mcp-locks-501`, `jiti`, `node-compile-cache`. |
| Second qualification (backend only; no bridge code changed after the first) | `8268be981` | Backend 12,001 passed, 115 skipped, 5 failed: the registered environment-move submodule deadlines (0248, 0291, 0621) and the tracked-edit case of 0947. | Only `orkestrator-mcp-locks-501` (by design). |

The deadline failures are flakes, not leaks: the registered ones recurred, and
the rest are registered as
[1105](../../tests/flaky-tests/environments-and-containers/1105-environment-fork-source-commit-timeout.md)
and
[1106](../../tests/flaky-tests/environments-and-containers/1106-environment-move-git-fixtures-under-host-load.md).
The unchanged `main` checkout failed the environment-move owner the same way at
the same load.

## Verification sweep and repeat sweep (2026-10-27)

Same host, method and order as above (the five `test:bridge` runs, then the
backend `test:workspace`, outside Turbo, one empty private `TMPDIR` under
`/var/folders/.../T/`, a fresh `dist/`).

| Run | Revision | Result | Left in the private `TMPDIR` |
| --- | --- | --- | --- |
| Acceptance verification sweep (run by the verifier; directory `ork0247-verify.l3eR6W0G`) | `5702c8255` | ACP, Codex, Cursor and Pi passed; Claude 1,705 passed, 6 skipped, 1 failed (a coordinator sandbox test that failed the same way on `origin/main`). Backend exit 1: 12,002 passed, 115 skipped, 17 failed, 14 errors. | `claude-client-session-restart-*`, `claude-dispatch-journal-*`, `claude-metadata-noop-*`, `claude-mcp-calls-*`, `ork-artifact-preview-92054-*` (a dead owner; Chromium profile inside), plus the intended `orkestrator-mcp-locks-501`, `jiti`, `node-compile-cache` and the kept `orkestrator-test-run.*` failure logs. All five causes are fixed at source (leak table, Code item 2). |
| Repeat sweep after those fixes (directory `ork0247-qual3`) | `0c77d9b46` | Bridges all passed (acp 695, claude 1,706, codex 2,412, cursor 801, pi 651). Backend exit 1 in 677 s at load average 67 to 95: 12,006 passed, 115 skipped, 16 failed, 12 errors, all five-second deadlines of Git-heavy fixtures (below). | `acp-bridge-test-*` (one, holding `entries.jsonl`), plus the intended `orkestrator-mcp-locks-501`, `jiti` and `node-compile-cache`. No preview scratch, no Claude bridge fixture, nothing from the backend. |
| ACP bridge and protocol package after the spool fix (`ork0247-qual3b`, `ork0247-qual3c`) | `39980f699` | ACP `test:bridge` 695 passed, 3 skipped; protocol `test:workspace` 1,935 passed, 2 skipped. | Nothing. |

The `acp-bridge-test-*` root came from `change-evidence.test.ts`: the test
restores a second `ChangeEvidenceSpool` from the directory, the constructor
queues a compaction rewrite of `entries.jsonl`, and nothing awaited it before
the harness removed the directory. The protocol package's
`evidence-spool.test.ts` restart test had the same shape (`ork-spool-*`). Both
now flush the restored spool in a `finally`. With temporary copies of the old
test files run twelve times each under a private `TMPDIR`, the old ACP test
left 4 roots and the old protocol test 3; the fixed files left none.

The repeat sweep's backend failures, all at Bun's five-second deadline, with
their tracking: nine `environment-move.test.ts` cases (0248, 0291, 0621,
[0935](../../tests/flaky-tests/environments-and-containers/0935-environment-move-cursor-read-failure-timeout.md),
and [1106](../../tests/flaky-tests/environments-and-containers/1106-environment-move-git-fixtures-under-host-load.md),
which now names the one new case; it passed alone in 2.7 s at load 161);
the three `worktree-snapshots-git.test.ts` watcher cases, their three
between-test errors and a hook timeout
([0947](../../tests/flaky-tests/environments-and-containers/0947-worktree-git-aggregate-timeouts.md),
[0957](../../tests/flaky-tests/environments-and-containers/0957-worktree-index-and-shared-ref-aggregate-timeouts.md);
the untouched owner alone at load 155 still failed the shared-ref case, 3 of
4); `injects workspace artifact git excludes` ([0187](../../tests/flaky-tests/environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md));
`start uses and persists both explicit and configured roots` ([1107](../../tests/flaky-tests/environments-and-containers/1107-worktree-location-aggregate-timeouts.md));
and `startWorktreeWatcher > observes a real file write` ([0091](../../tests/flaky-tests/environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md)).
The remaining between-test errors were Git children of timed-out
environment-move cases running against removed fixtures. None is a leak.

### The verifier's full `mise run test` (2026-10-27)

`verify-0247-full-suite`, 619.0 s, exit 1 (workspace summary
`orkestrator-test-run.IpdbGA` under the host temporary directory). Bridges and
the Codex lockfile group passed. Every failure, with its tracking:

| Failure | Tracking |
| --- | --- |
| `verified copy helper > a missing listing completion times out as extract-failed`, `... a missing root completion ...` (root group) | Deterministic on the base revision too; [1013](../../tests/flaky-tests/aggregate-validation-runs/1013-interactive-command-main-merge-validation.md). |
| `pruneProfiles > the age rule applies only when asked for`, `... unregisters worktrees the profile made in an outside repository` (desktop) | Deterministic on the base revision too (the macOS `keychainWarning`); [1013](../../tests/flaky-tests/aggregate-validation-runs/1013-interactive-command-main-merge-validation.md). The verifier reproduced both on `origin/main`. |
| `move_environment > moves a worktree with nested submodules (copy)` and `(same disk)`, `a failed submodule re-link restores the original checkout`, `restart recovery re-links submodules of an adopted or abandoned copy` | [0621](../../tests/flaky-tests/environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0291](../../tests/flaky-tests/environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md), [0248](../../tests/flaky-tests/environments-and-containers/0248-move-restart-recovery-submodule-timeout.md); the verifier reproduced the deadline family on `origin/main`. |
| `an incomplete copy rollback never asks recovery to adopt its partially removed destination`, `rejected path commit clears the journal and preserves subsequent edits (false)`, `source cleanup failure retains a committed copy for restart retry` | Not named before; now in [1106](../../tests/flaky-tests/environments-and-containers/1106-environment-move-git-fixtures-under-host-load.md), with the verifier's isolated passes on the branch and `origin/main` and a further pass here (12.0 s at load 81). |
| Eight between-test errors | Git children of the timed-out environment-move cases (`fatal: cannot change to .../ork-env-move-*`), as in the earlier runs. |
| `injects workspace artifact git excludes into local worktrees before status reads` | [0187](../../tests/flaky-tests/environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md). |
| `local preview service discovery on this host > two environments, a restart on the reused port, and an auto-incremented port` | [0942](../../tests/flaky-tests/aggregate-validation-runs/0942-service-preview-rollout-0042-validation.md); passed alone on `origin/main` (`verify-main-preview-discovery`). |
| `startWorktreeWatcher > observes a real file write` | [0091](../../tests/flaky-tests/environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md); passed alone on `origin/main` (`verify-main-worktree-watcher`). |

## Review follow-up and acceptance evidence (2026-10-27)

- All three `commands-registry-mcp.test.ts` teardown hooks now await fixture
  cleanup. The `mcp-private-tmp` run passed with **zero `mcp-mgmt-*` roots**
  remaining under a new private `TMPDIR`. An AST contract test in
  `tests/unit/mcp-fixture-cleanup.test.ts` checks MCP fixture callers for
  dropped cleanup promises, including optional calls.
- `startup-services.ts` owns gateway construction, startup, managed-client
  configuration and Serve setup until successful handoff. Any failure attempts
  Serve, managed-client, gateway and backend cleanup independently, awaits each,
  and rethrows the original startup error. Regression tests cover constructor
  and gateway rejection, no Tailscale address, rejected `get_config`, missing
  browser URL, and Serve failure, including rejected cleanup and delayed backend
  shutdown. Successful managed and standalone startup remain covered too.
- The environment-move sweep now explicitly opts both prefixes into legacy
  recovery after **24 hours**; the PID-owned dead-owner limit remains one hour.
  The ownerless age limit deliberately matches preview scratch recovery rather
  than assuming an hour-old ownerless directory is unused. A private-root sweep
  test checks removal of both stale legacy prefixes and retention below a day.
- Deterministic tests cover image inspection completing after runner close
  without launching a worker, empty/repeated settlement, terminal writes queued
  during settlement, and an MCP apply pass queued behind an active pass.
- The review's captured aggregate was **35,493 passed, 6 failed, 204 not run**,
  exit 1. It was not a successful acceptance run. The six names are now
  reconciled with isolated and baseline evidence:

  | Captured failure | Follow-up evidence | Tracking |
  | --- | --- | --- |
  | `verified copy helper > a missing listing completion times out as extract-failed` and `a missing root completion times out as extract-failed` | The unchanged owner fails both assertions alone (10 pass, 2 fail), and identically at the actual diff merge base `ce205ad34b9e157ad22eb866b1d159ba6420c992` (10 pass, 2 fail). Both receive extraction status `2` instead of `0`. | Existing cross-owner case [1013](../../tests/flaky-tests/aggregate-validation-runs/1013-interactive-command-main-merge-validation.md); deterministic baseline failures, not newly classified as flakes. |
  | `pruneProfiles > the age rule applies only when asked for` and `unregisters worktrees the profile made in an outside repository` | The unchanged owner fails both assertions alone (20 pass, 2 fail), and identically on the base revision. Both receive an unexpected macOS `keychainWarning` for the temporary profile outside the default root. | [1013](../../tests/flaky-tests/aggregate-validation-runs/1013-interactive-command-main-merge-validation.md); deterministic baseline failures. |
  | `Electron backend command registry > injects workspace artifact git excludes into local worktrees before status reads` | Complete unchanged owner passes alone, exit 0 (`previously-failing-commands`, 18.5 s). | Recurrence of [0187](../../tests/flaky-tests/environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md), reopened with this evidence. |
  | `move_environment > moves a worktree with nested submodules (copy)` | The prior sweep already records owner and unchanged-main evidence for the deadline family. | [0621](../../tests/flaky-tests/environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), also see [1106](../../tests/flaky-tests/environments-and-containers/1106-environment-move-git-fixtures-under-host-load.md). |

The baseline is the merge base of the review's `9791a425...b74e02ce` diff,
not the newer target tip `9791a425`. Baseline runs use a detached temporary
worktree with this checkout's installed dependency directories linked in;
no package or lockfile is changed. These four assertions reproduce before
0247 and remain outside its temporary-directory cleanup scope. They are
recorded, not fixed, skipped or weakened by this follow-up.

### Follow-up validation result

`mise run test:logged -- --name review-full -- mise run test` finished with
exit **1** in 711.7 s: **35,509 passed, 12 failed, 199 skipped**, plus **four
between-test errors** after environment-move deadlines. Bridges and the Codex
protocol-lockfile group passed. Root/support had 3,531 passed and the two
baseline migration failures. Backend had 12,011 passed, 115 skipped, eight
failed and four errors; desktop had the two baseline Keychain assertions.
No new regression test failed.

The twelve failures are accounted for as follows:

- The same four baseline assertions in the table above ([1013](../../tests/flaky-tests/aggregate-validation-runs/1013-interactive-command-main-merge-validation.md)).
- Both nested-submodule moves ([0621](../../tests/flaky-tests/environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md)),
  failed submodule re-link ([0291](../../tests/flaky-tests/environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md)),
  and restart recovery ([0248](../../tests/flaky-tests/environments-and-containers/0248-move-restart-recovery-submodule-timeout.md)).
  The owner-file rerun remained non-green: 34 passed, four deadline failures,
  four between-test errors, 66.0 s; see [1106](../../tests/flaky-tests/environments-and-containers/1106-environment-move-git-fixtures-under-host-load.md).
- The explicit/configured worktree-root case (hook timeout) and accepted-alias
  retarget case (test timeout). The complete unchanged owner passed in 7.5 s;
  registered as [1107](../../tests/flaky-tests/environments-and-containers/1107-worktree-location-aggregate-timeouts.md).
- Linked-worktree index and shared-ref watcher deadlines ([0957](../../tests/flaky-tests/environments-and-containers/0957-worktree-index-and-shared-ref-aggregate-timeouts.md)).
  The unchanged owner rerun also timed out: one passed, three failed, one
  between-test error, 16.3 s. This run is not reported as passing.

Other validation passed: `mise run check` (format, lint, typecheck; existing
unused-import warnings remain), `mise run build:backend`, the focused startup,
settlement, MCP command and preview-isolation tests, the private-TMPDIR MCP
check, all eleven standalone backend tests, and root sweep/cleanup-contract,
flake-registry and suite-ownership checks. Browser, Electron, real Docker and
iOS scenario suites were outside this cleanup change; no Arch Linux host was
available for the remaining cross-platform qualification.

Failure evidence is retained under the host temporary directory:
`orkestrator-test-run.TZNWYO/summary.json` and its per-group compressed logs,
with enclosing `orkestrator-test-run.DCQCrJ/review-full.log.gz`. The aggregate
is deliberately recorded as non-green despite the targeted fixes passing.

## Constraints and rationale

- The same rules as 0023: remove a directory in the test that made it, after
  whatever holds it open has closed; await the removal so the process cannot
  exit first; `tests/temp-sweep.ts` removes a PID-owned directory only when
  its PID is dead and it is past the age limit. Legacy ownerless names need
  an explicit, longer age limit.
- The `settled()` methods added to production classes (`TerminalHistory`,
  `McpManagementService`) only wait; they change no state, so production
  shutdown order is unchanged.
- Not leaks (do not "fix"): `orkestrator-test-run.*` (failure logs, kept 7
  days by `scripts/test-all.ts`), `orkestrator-test-scheduler-v1-<uid>` and
  `orkestrator-test-timings.*` (scheduler state), `orkestrator-mcp-locks-<uid>`
  (the per-user lock directory of `mcp-management/source-store.ts`, by
  design), and other tools' own caches and scratch (`jiti`,
  `node-compile-cache`, `playwright-transform-cache-<uid>`,
  `org.chromium.Chromium.*`, `claude-<uid>`).
- `policy-cli-*` is left only when the live OpenCode research test times out;
  it belongs to flake
  [0785](../../tests/flaky-tests/coordinator-and-multi-review/0785-opencode-research-server-registration-timeout.md).

## Open questions

None.

## Consolidated review fixes (2026-10-27)

- Preserve the command column from `ps` verbatim after its fixed numeric and
  status columns. Ownership matching also recognizes how BSD `ps` renders tabs
  (`\011`) and how procps renders them (`?`), while retaining literal
  backslashes. Real detached-process regressions cover consecutive spaces and
  tabs; a fixed-output test checks raw whitespace and backslash preservation.
- Refuse new MCP tick passes after disposal, including callers waiting for a
  previous pass. The regression arms settlement before queuing another tick,
  disposes the service, and verifies that cleanup cannot be followed by a
  directory-recreating pass.
- Bound terminal-history settlement in environment-move and command-I/O
  teardown to two seconds and remove fixture roots in `finally`. A stalled or
  rejected writer still fails the hook after cleanup. Tests cover successful,
  rejected and stalled settlement, plus a real history collector appending
  after shutdown before its final quiescing flush.
- Start the production artifact runtime factory in fresh child processes with
  a private TMPDIR containing aged scratch for a dead owner and a live child.
  Assert removal and its logged count in process isolation, retention in
  container/disabled isolation, and retention of the live owner's scratch.
- Exercise failed and timed-out `ps` calls and require unverified cleanup.
  A real Playwright Chromium profile containing consecutive spaces verifies
  marker ownership and exit of the browser and its observed helpers.
- Use a shared XDG fixture helper and assert all four overrides are absent
  during command tests and restored afterwards. Its tests cover both defined
  and absent originals, including overrides changed during a test.

Validation on macOS: the targeted regression suite and its final command-parser,
startup and real-Chromium subsets passed. The five command/preview owner files
(`commands-io-coverage`, `commands-process-coverage`, `preview-supervisor`,
`preview-isolation`, `runtime`) passed together in 22.3 s; the existing real
Docker case was skipped because its worker image is unavailable. `mise run
check` passed (format, lint and all workspace, test and script typechecks).

The broader six-file run including `environment-move.test.ts` remained
non-green (131 passed, one skipped, 28 failed, 23 between-test errors; 386.2 s).
The failures were in environment-move, beginning at the five-second test
budget, followed by hook timeouts, removed-path and SQLite errors as unfinished
operations outlived their tests. Its complete owner rerun also failed (13 passed,
25 failed, 23 between-test errors; 289.8 s, `orkestrator-test-run.VXqm94`). This
is not an idle-host pass or a new flake classification. Evidence:
`orkestrator-test-run.CUD1YR/review-fix-integration.log.gz` under the host
temporary directory. The deterministic stalled-settlement cleanup regression
passes without changing the move test budgets or assertions.

The required `mise run test` also remains non-green: root/support finished
with 3,530 passed and three failures. The firewall entrypoint deadline passed
in the complete unchanged owner (21.6 s), recorded in existing case
[0983](../../tests/flaky-tests/environments-and-containers/0983-firewall-root-entrypoint-shell-timeout.md).
Both unchanged migration-copy failures reproduced alone (10 passed, two failed;
3.3 s, `orkestrator-test-run.abZ2L8`). The bridge group failed five unchanged
Claude coordinator/runtime-idle cases. Workspace completed web (9,937 passed),
protocol (1,935 passed), web-public (41 passed), toolchain (90 passed, one failed)
and desktop (1,369 passed, two failed). Toolchain's empty version-probe output
passed in the complete unchanged owner (2.5 s), recorded in existing case
[0290](../../tests/flaky-tests/backend-services-and-tooling/0290-toolchain-version-probe-empty-output.md).
Desktop's two failures were the existing `pruneProfiles` keychain-warning
expectations. Backend remained incomplete, with environment/Git and other
fixture deadlines; there is no complete backend total.

The logged wrapper stopped the required repository run at its 1,800-second
absolute deadline (exit 1, `timeoutReason: absolute`). The workspace group had
waited 1,162.4 s for four host worker slots before starting. This is explicitly
non-green and incomplete, not acceptance proof. Outer compressed evidence:
`orkestrator-test-run.OHbyVm/review-fix-suite.log.gz`; bounded inner group logs:
`orkestrator-test-run.S3DyLI`, both under the host temporary directory.

The final late-append history regression passed (0.6 s), followed by the backend
source/test typecheck (1.7 s). The implementation is committed as `82009c8c1`.
Linux/Windows execution and a green, complete repository run remain unverified;
full browser/Electron/Docker/iOS scenario suites were outside these cleanup
changes. The real Chromium cleanup regression ran successfully on macOS.

## Acceptance-verification flake registration (2026-10-27)

The acceptance verification of `90c9e205a` (compared with `origin/main` at
`863b57821`) found two failures with no owner-level flake entry. Both are now
registered; no assertion, timeout or skip was changed.

| Test | Verification result (as reported) | Owner reruns here, `90c9e205a`, load 173 to 228 | Record |
| --- | --- | --- | --- |
| `streamed media in Chromium > (unnamed)` (the `beforeAll` Chromium launch), `media-stream.browser.test.ts` | Timed out at 5,004 ms in `mise run test`; owner passed alone on the branch and `origin/main`. Earlier aggregates 0694, 0801 and 0825 saw the same hook but no owner case existed. | Complete owner passed 3 of 3 (1.5 s, 2.7 s, 1.6 s). | New [1108](../../tests/flaky-tests/design-canvas-and-artifacts/1108-media-stream-chromium-launch-hook-deadline.md); 0825 points to it. |
| `move admission waits for already admitted mutations to settle`, `environment-move.test.ts` | Failed in the direct backend sweep (11,995 passed, 115 skipped, 40 failed) and in the detached `origin/main` owner run. | Alone: failed once at 5,024.49 ms (load 173), then passed 3 of 3 at the default budget and 5 of 5 with `--timeout 60000`. | Added to [1106](../../tests/flaky-tests/environments-and-containers/1106-environment-move-git-fixtures-under-host-load.md), the environment-move deadline family, and named in its index row. |

The verification also reported the SSH askpass broker assertion failing only
under the sweep's deliberately long private `TMPDIR`. It reproduced on
`origin/main` with the same path and passed on both with the host `TMPDIR`,
because the broker falls back to `/tmp` once its Unix socket path is over the
OS limit. This is a property of the long sweep path, not a leak or a flake. A
private-`TMPDIR` sweep should use a short path (for example
`/tmp/ork0247/tmp`) so socket-creating tests keep their normal path. Not
reproduced here: `apps/desktop/tests/ssh/askpass.test.ts` passed 8 of 8 under
a 119-character private `TMPDIR`, so the threshold case is recorded as the
verification reported it.

## Needs verification

- The repeat sweep on omarchy-hp (Qualification item 2). On macOS
  `ork-env-move-*` was never left, so its Linux writer is unproven. Expected:
  gone, or, if its writer is something other than terminal history, removed
  by the next run of the file once its owner has exited and it is over an hour
  old; legacy names without an owner are eligible after a day. Whether the Linux
  `ork-artifact-preview-*` leftovers had the same cause as the macOS ones
  (the untracked probe) is also unproven there.
- The escaped-browser ownership marker on Linux: `ps -A -ww -o ...,command=`
  is also valid for procps, and Chromium carries `--user-data-dir` there
  too, but the reproduction and the unit test ran only on macOS.
- Linux and Windows execution of the new process-marker regressions remains
  unqualified on this macOS host. The real-Chromium test is collected by the
  existing transcript-artifacts area suite and follows its Chromium availability
  prerequisite. Windows execution is not established by the Unix `ps`
  implementation.

## Assumptions and decisions

Decisions 1 to 8 were made on 2026-10-26 while working through the file;
9 and 10 on 2026-10-27, for the leaks the verification sweep found; 11 on
2026-10-27, for the acceptance verification's unregistered flakes.

1. **Fix at source, or opt into `tests/temp-sweep.ts`.** Options: (a) find
   each writer and settle it before the removal; (b) rename every prefix to
   `<prefix><pid>-<random>` and let a later run sweep it. Chose (a) for every
   prefix whose writer was reproduced, and (a) plus (b) for `ork-env-move-*`,
   whose writer was not. Pros: nothing is left even by a run that is never
   followed by another, and each fix names the late writer. Cons: (a) needed
   small waiting hooks (`settled()`) in production classes; the fallback for
   `ork-env-move-*` only removes leftovers an hour later, at the next run of
   that file.
2. **How a test waits for late writes.** Options: (a) a fixed delay before
   removal; (b) an awaitable "settled" hook on the owner (`TerminalHistory`,
   `McpManagementService`, `TranscriptMediaStreams.dispose()`, Pi
   persistence, the codex runtime's `stop()`); (c) remove the directory again
   later. Chose (b). Pros: deterministic, no slower than the work itself, and
   the hooks loop until no new work was queued. Cons: three small waiting
   methods in production modules that only tests call
   (`TerminalHistory.settled()`, `McpManagementService.settled()`,
   `settlePersistenceForTests()`); the codex harness uses the existing
   `stop()`, and `TranscriptMediaStreams.dispose()` now waits for its own
   construction work, which production shutdown also benefits from.
3. **Preview scratch in production (Code item 2).** Options: (a) leave it,
   as the normal path removes it; (b) keep reaping after `stop()`; (c) name
   the scratch for the backend PID and remove dead backends' scratch at
   startup. Chose (c). Pros: covers a killed backend, which (b) cannot;
   mirrors the container mode's startup reaping; a live backend's scratch is
   never touched. Cons: a scratch left by a backend in another PID namespace
   that looks dead waits for the hour limit; legacy names are removed by age
   alone (a day, while a job is bounded to minutes).
4. **Open question: should `mise run test` pass `TMPDIR` through Turbo?**
   Options: (a) no, keep running the workspace and bridge groups with `/tmp`;
   (b) `TMPDIR` in those two tasks' `passThroughEnv`; (c) `TMPDIR` in
   `globalPassThroughEnv`. Chose (c). Pros: one aggregate run with a private
   `TMPDIR` can be swept; the workspace and bridge groups now use the same
   temporary directory as the root group and the caller (on macOS the
   per-user one rather than shared `/tmp`); passthrough values are not hashed, and build and dev tasks honour
   it too. Cons: on macOS those suites now run with a longer temporary path
   (Unix socket paths are limited to 104 bytes), which both qualification
   runs covered with an even longer one, with no failure attributable to the
   path (the acceptance verification later saw the SSH askpass broker fall
   back to `/tmp` under its own, longer private path; it reproduced on
   `origin/main` and passed with the host `TMPDIR`, see
   [flake registration](#acceptance-verification-flake-registration-2026-10-27));
   adding the key changes `turbo.json`, so
   every cached Turbo task re-runs once. `tests/unit/monorepo-scripts.test.ts`
   guards the setting.
5. **XDG variables in `commands-process-coverage.test.ts`.** Options: (a)
   point them at directories under the fake `HOME`; (b) clear them. Chose
   (b). Pros: the code's own fallback (`$HOME/.local/state` and so on) is what
   the test writes into, so the test exercises the default path; nothing else
   to create. Cons: the `XDG_STATE_HOME` branch of
   `get_opencode_model_preferences` stays covered only by other tests.
6. **The four Pi bridge prefixes found by the macOS sweep.** Options: fix them
   here, or record them in a new todo file. Chose to fix them here, as 0023
   did for the one leak its own sweep found. Pros: this file's qualification
   item is that the sweep leaves only intended entries, which needs them
   fixed; the cause was the same kind as the listed ones. Cons: this file now
   covers more than its original table.
7. **The preview probe on shutdown.** Options: (a) leave the probe's worker
   to the startup sweep; (b) track it and have `close()` cancel and await it
   like a job's worker. Chose (b), plus the sweep for a backend that is
   killed. Pros: the normal stop path leaves nothing; `close()` was already
   bounded (10 s), so shutdown cannot hang on it. Cons: a stop during a probe
   waits for the worker's kill-and-verify. The same reasoning made the
   Tailscale Serve failure paths in `main.ts` call `backend.shutdown()`.
8. **Where the qualification ran.** The repeat sweep ran on macOS, the only
   host available, not on omarchy-hp. It is recorded as macOS, and the Linux
   repeat stays open (Qualification item 2).
9. **The browser that escapes the preview kill.** Options: (a) leave it to
   the startup sweep; (b) remove the scratch again some time after the kill;
   (c) stop Playwright from giving Chromium its own process group; (d) treat
   a process whose command line names the job's scratch as owned, and confirm
   an empty scan. Chose (d). Pros: the scratch path is unique per job and is
   on Chromium's command line, so ownership is exact and needs no change to
   how Playwright launches; it also frees the capacity the escaped browser
   was using, which (a) and (b) do not; the kill stays verified rather than
   timed. Cons: process-mode kills list full command lines (`ps -ww`, about
   250 KB on this busy host, within the existing 8 MB buffer) and take one
   extra 100 ms scan; (c) is not offered: Playwright 1.64.0's process
   launcher sets `detached: process.platform !== "win32"` unconditionally, so
   it would need a patch to Playwright.
10. **Settling Claude-home writes in the bridge fixtures.** Options: (a) a
    settle call in each test; (b) one harness helper that restores the
    suite's home, settles, then removes, used by every fixture; (c) make
    `updateSessionPreferences` resolve its path when the write runs. Chose
    (b). Pros: one place for the ordering, the 21 inline removals cannot
    drift; no production change. Cons: a new fixture that removes a home
    without the helper can leak again; (c) was not taken because a write
    queued for one home must not land in another (the reason the path is
    resolved at queue time).
11. **Where the two unregistered flakes go.** Options: (a) a new case for
    each; (b) a new case for the media-stream hook, which no group owned,
    and add move admission to 1106, the environment-move deadline family;
    (c) fix their budgets here. Chose (b): 1108 and an extended 1106. Pros:
    follows the registry rule that a recurrence updates its case; the
    media-stream case closes the "no owner case" gap 0694, 0801 and 0825
    each noted; nothing in the tests is loosened. Cons: 1106 grows to
    eighteen names; (c) was not taken because neither test's code is in
    this ticket's scope and a longer budget would hide the host-load signal
    the records track.

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (the first leak list and the sweep that found these).
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md).
- [Disk usage](../../development/disk-usage.md).
- [0248-playwright-profile-dir-leaks.md](0248-playwright-profile-dir-leaks.md)
  (leftover Playwright profiles, including those inside `ork-artifact-preview-*`).

## Replaces

Nothing; new work found on 2026-10-26.

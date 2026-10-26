# Test temporary-directory leaks found by the full sweep

Checked against `main` at `ce205ad34` plus the 0247 branch at `8268be981`
(2026-10-26).

[0023](0023-environment-and-disk-cleanup.md) fixed the test temp-directory
leaks it listed. Its 2026-10-26 sweep then ran the bridge and backend suites
with a private `TMPDIR` and found many more directories left behind, plus one
test that reads the host's real state. This file holds that newly found work;
0023 does not take new items.

All code items are done (2026-10-26) and a repeat sweep on macOS left only
intended entries. What remains is a repeat on the original Arch Linux host,
where `ork-env-move-*` leaked and macOS never reproduced it.

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
  | `ork-env-move-*` | Not established: the file left none on macOS, alone or under host load average 12 to 19, before or after the change. | Defence in depth: the `afterEach` also settles terminal history, and the roots and the template are named through `ownedTempDirPrefix`, so `sweepStaleTempDirs` at the top of the file removes those of dead owners after an hour. | No. |
  | `ork-artifact-preview-*` | The backends `apps/backend/tests/standalone.test.ts` starts (the baseline sweep never ran them: its checkout had no `dist/`). Every backend start runs the preview availability probe, whose worker the runner did not track, so a backend stopping mid-probe exited without cancelling it; and a backend whose Tailscale Serve setup failed exited without `backend.shutdown()`. The `transcript-artifacts` tests themselves (323 pass, real Chromium in process mode) left none. | `TranscriptPreviewRunner.close()` cancels the probe's worker and waits for its verified exit; the Serve-failure paths in `main.ts` shut the backend down before rethrowing; scratch is PID-named and swept at startup (Code item 2). | Yes, 5 before, 1 after the `close()` fix, 0 after the `main.ts` fix (two runs). |
  | `mcp-mgmt-*` | A timer-started apply pass (`McpManagementService.tick`) still wrote `data/mcp-management/operations.json` after `dispose()`; seen from `service-apply.test.ts`. | New `McpManagementService.settled()`; the fixture's `cleanup()` is async, awaits it, and every caller awaits `cleanup()`. | Yes, 1 before, 0 after (441 tests, twice). |
  | `ork-clone-capacity-*` | The last clone the test started was still running at teardown and created `.orkestrator-clone-*` in the removed root. | The test waits for that clone to fail before returning. | Yes, before in the baseline sweep; 0 after in three runs. |
  | `media-stream-*` (a `staging/` directory) | `TranscriptMediaStreams` re-creates its staging root at construction without awaiting it; `dispose()` did not wait, so the `mkdir` landed after the test removed the root. | `dispose()` awaits the staging-root work. | Yes, 3 of 3 before, 0 of 3 after. |
  | `ork-backend-activity-event-<uuid>`, `ork-backend-activity-stamp-<uuid>`, `ork-backend-interaction-env` | `index.test.ts` passed these data directories to `OrkestratorBackend` and never removed them. | `mkdtemp` directories removed after `backend.shutdown()`. | Yes, before in the baseline sweep; 0 after. |
  | `outside-profile.bin` | `commands-io-coverage.test.ts` wrote the "outside" file next to a worktree directory that sat directly in the temporary root. | The worktree directory is now inside a test-owned root, so the outside file is too. | Yes, before in the baseline sweep; 0 after. |

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
   `ork-artifact-preview-*` by the production startup sweep.
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
   holds.~~ Done on macOS 2026-10-26, not on the original Arch host; see
   [Qualification results](#qualification-results-2026-10-26).
2. Repeat the same sweep on omarchy-hp (Arch Linux), where `ork-env-move-*`
   leaked and macOS never reproduced it, and confirm the
   `ork-artifact-preview-*` fixes there (see Needs verification).

## Qualification results (2026-10-26)

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

## Constraints and rationale

- The same rules as 0023: remove a directory in the test that made it, after
  whatever holds it open has closed; await the removal so the process cannot
  exit first; `tests/temp-sweep.ts` removes a directory only when its PID is
  dead and it is past the age limit.
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

## Needs verification

- The repeat sweep on omarchy-hp (Qualification item 2). On macOS
  `ork-env-move-*` was never left, so its Linux writer is unproven. Expected:
  gone, or, if its writer is something other than terminal history, removed
  by the next run of the file once its owner has exited. Whether the Linux
  `ork-artifact-preview-*` leftovers had the same cause as the macOS ones
  (the untracked probe) is also unproven there.
- `sweepStalePreviewScratch` on a real backend start with leftovers present
  (only unit-tested here; the backend was not run against a real data
  directory).

## Assumptions and decisions

Decisions made on 2026-10-26 while working through the file.

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
   path; adding the key changes `turbo.json`, so
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

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (the first leak list and the sweep that found these).
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md).
- [Disk usage](../../development/disk-usage.md).
- [0248-playwright-profile-dir-leaks.md](0248-playwright-profile-dir-leaks.md)
  (leftover Playwright profiles, including those inside `ork-artifact-preview-*`).

## Replaces

Nothing; new work found on 2026-10-26.

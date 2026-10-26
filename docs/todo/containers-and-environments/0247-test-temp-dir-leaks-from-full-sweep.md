# Test temporary-directory leaks found by the full sweep

Checked against `main` at `93018933` plus the 0023 branch (2026-10-26).

[0023](0023-environment-and-disk-cleanup.md) fixed the test temp-directory
leaks it listed. Its 2026-10-26 sweep then ran the bridge and backend suites
with a private `TMPDIR` and found many more directories left behind, plus one
test that reads the host's real state. This file holds that newly found work;
0023 does not take new items.

## Current state

- How the inventory below was taken (omarchy-hp, Arch Linux x86_64): an empty
  `TMPDIR=/tmp/ork0023-sweep/tmp`, then `test:bridge` in each of the five
  bridges, for example `mise exec -- bun run --cwd bridges/codex-bridge test:bridge`
  (all five passed),
  and `mise exec -- bun run --cwd apps/backend test:workspace` (11,721 passed,
  142 skipped, 2 failed: flake 0785, and the test in Code item 3). They were
  run outside Turbo because `mise run test` runs these groups through Turbo's
  strict environment mode, which does not pass `TMPDIR` through, so an
  aggregate run cannot be swept this way.
- `tests/temp-sweep.ts` (`createOwnedTempDir`, `sweepStaleTempDirs`) is the
  existing fallback for prefixes that cannot be removed at source.
- 0023 believed `ork-runtime-` and `orkestrator-state-sync-` were removed on
  the normal path. This sweep left four and three of them, in runs where
  their owning files passed.

## Outstanding work

### Code

1. Remove these at source (or, where that is impossible, opt the prefix into
   `tests/temp-sweep.ts`). Counts are from one sweep; "owner" is where the
   prefix is created.

   | Left behind | Count | Owner |
   | --- | --- | --- |
   | `claude-mcp-sync-*` | 5 | `bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.live-probe.ts`, via `session-manager-prompt-mcp-sync.live.test.ts` |
   | `ork-runtime-*` | 4 | `bridges/codex-bridge/src/app-server-runtime-test-harness.ts` (created during the bridge phase; `backend-runtime.test.ts` and `runtime-prepare.test.ts` use the same prefix) |
   | `orkestrator-state-sync-*` | 3 | `apps/backend/src/core/commands-state-sync.test.ts` |
   | `ork-env-move-*` | 3 | `apps/backend/src/core/environment-move.test.ts` |
   | `ork-artifact-preview-*` | 5 | the scratch directory of `transcript-artifacts/preview-supervisor.ts`, reached from the preview tests; holds `.cache` and `.config` |
   | `mcp-mgmt-*` | 2 | `apps/backend/src/core/mcp-management/test-support.ts` |
   | `ork-terminal-history-*` | 1 | `apps/backend/src/core/terminal-history.test.ts` |
   | `ork-clone-capacity-*` | 1 | `apps/backend/src/core/commands-registry-project-copy.test.ts` |
   | `media-stream-*` | 1 | `apps/backend/src/core/transcript-artifacts/media-stream.test.ts` (left a `staging/` directory) |
   | `ork-backend-activity-event-<uuid>`, `ork-backend-activity-stamp-<uuid>`, `ork-backend-interaction-env` | 1 each | `apps/backend/src/core/index.test.ts` |
   | `ork-commands-io-history-<pid>`, `outside-profile.bin` | 1 each | `apps/backend/tests/commands-io-coverage.test.ts` |
   | `ork-command-registry-data` | 1 | `apps/backend/tests/commands-registry-coverage.test.ts` |

2. Decide whether the preview supervisor itself leaks its scratch directory in
   production, or only the tests skip stopping it (see Needs verification).
3. Make `process and platform command behavior > controls bridge processes,
   reads logs and preferences, and reports port health`
   (`apps/backend/tests/commands-process-coverage.test.ts`) hermetic. It sets
   a fake `HOME`, but `commands-containers.ts` prefers `XDG_STATE_HOME`, so
   with the host's `XDG_STATE_HOME` set it reads the real
   `~/.local/state/opencode/model.json` and fails on its recent models. It
   passes under `mise run test` only because Turbo drops the variable; with
   `env -u XDG_STATE_HOME` the file passed 67 of 67. The test should set or
   clear the XDG variables it depends on.

### Qualification

1. Repeat the sweep above after the fixes and record that the private
   `TMPDIR` holds only intended entries.

## Constraints and rationale

- The same rules as 0023: remove a directory in the test that made it, after
  whatever holds it open has closed; await the removal so the process cannot
  exit first; `tests/temp-sweep.ts` removes a directory only when its PID is
  dead and it is past the age limit.
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

- Should `mise run test` pass `TMPDIR` through Turbo (`globalPassThroughEnv`)
  so a single aggregate run can be swept? It would also make the suite honour
  an operator's chosen temporary directory.

## Needs verification

- Whether `preview-supervisor.ts` removes its `ork-artifact-preview-*` scratch
  directory when a preview stops, or whether the five left here come only from
  tests that never stop it.

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md)
  (the first leak list and the sweep that found these).
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md).
- [Disk usage](../../development/disk-usage.md).
- [0248-playwright-profile-dir-leaks.md](0248-playwright-profile-dir-leaks.md)
  (leftover Playwright profiles, including those inside `ork-artifact-preview-*`).

## Replaces

Nothing; new work found on 2026-10-26.

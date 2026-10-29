# Backend module state (todo 0133) branch validation

- **ID:** 1195
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0133-backend-module-state-3cc0d753a9d5` at `cc2cab60b`
  plus the `host-suspend-detector.test.ts` fix below, based on `863b5782`.
  The branch changes backend state ownership (`apps/backend/src/core`, its
  tests), one `.oxlintrc.json` allowlist entry and docs. `bridges/`,
  `apps/desktop`, `docker/` and `tests/unit` are unchanged.
- **Command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=5400000 mise run test:logged
  -- --name full-suite-2 -- mise run test` (inner logs
  `orkestrator-test-run.26el7t` below the host temporary directory), exit 1,
  2,807 s. A first run without the override was killed by the wrapper's
  30-minute deadline after the workspace group queued 1,329 s for worker
  slots (`orkestrator-test-run.09PFGB`), so it has no workspace result.
- **Host:** shared macOS host, Apple Silicon, load average 127–225 during the
  run and the reruns below (many other sessions' suites in parallel).

## Results

Codex protocol lockfile passed. Bridges: codex, cursor, acp and pi bridges
passed; claude-bridge 1,703 passed, 3 failed. Root/support: 3,525 passed, 3
failed. Workspace: web (9,941), web-public, CLI, protocol and toolchain
passed; desktop 1,369 passed, 2 failed; backend 12,003 passed, 120 skipped,
52 failed.

## Failures and what they are

Owner reruns used `mise run test:logged -- --name <label> -- bun test --cwd
<package> --parallel=1 --only-failures <files>` on the branch; "long" adds
`--timeout 60000`. "Base" is the same command on a detached checkout of
`863b5782` in this worktree.

| Owning file | Aggregate failures | Owner alone on the branch | Base | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/src/core/host-suspend-detector.test.ts` | `the process-wide registry carries both production signal sources` | Real regression: the poll source now registers per `BackendRuntime`. Test rewritten to build a runtime and check registration and removal; 8 pass | n/a | Not a flake |
| `apps/backend/src/core/environment-move.test.ts` | 26 cases, five-second deadlines | 26 fail at the default deadline; all 38 pass long (396 s) | Same deadlines on `origin/main` | [1101](1101-codex-typed-prompts-0211-validation.md) and the environment cases it links |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | `real Git through the shared owner` | Staging in a linked worktree and shared-ref baseline fail even long (15 s) | Same cases fail on `origin/main` | [1101](1101-codex-typed-prompts-0211-validation.md), [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md) |
| `apps/backend/tests/worktree-watcher.test.ts` | `observes a real file write` | Fails alone and long | Fails on `origin/main` | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases (relay directory mode 0755, not 0700; an earlier relay not removed) | Fail alone, deterministic | Same four fail | Recorded here; host-dependent, not a flake |
| `apps/backend/tests/docker-image.test.ts` | Two `pinned image identity` cases | Fail alone, deterministic | Same two fail | Recorded here; host-dependent, not a flake |
| `commands-environment-worktree-location`, `commands-integration` (2), `commands-registry-environments` (2) | Five-second deadlines on real Git | Pass long | — | [1101](1101-codex-typed-prompts-0211-validation.md), 0187 |
| `diff-stats-tracking` (6), `change-tracking/acceptance-sharing`, `preview-local-discovery`, `public-api-project-init-cascade`, `storage-writer-guards`, `commands-environment-fork` | Deadlines under load | Pass alone | — | Recorded here |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | Not rerun (macOS Keychain warning) | Known | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed` | 10 pass, 2 fail, deterministic | Same two fail on `863b5782` | [1013](1013-interactive-command-main-merge-validation.md), [1101](1101-codex-typed-prompts-0211-validation.md) |
| `tests/unit/test-all.test.ts` | `honours a per-group deadline…` (first run: `runs every non-iOS group…`) | 58 pass | — | [0160](../backend-services-and-tooling/0160-runtime-env-wiring-and-test-all-aggregate-timeouts.md) |
| `tests/unit/electron-spec-process-ownership.test.ts`, `tests/unit/pi-bridge-vendor.test.ts` | First run only | Pass alone | — | Pi: [0178](../agent-bridges/0178-pi-vendor-runtime-aggregate-timeout.md), [0514](../agent-bridges/0514-pi-bridge-vendor-timeout-under-load.md) |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | Three `unavailable-hook-*` cases at 17 s | 9 pass | — | Recorded here |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | First run: `an explicit refresh cannot replace the baseline for an already armed delay` | 29 pass, 1 fail (`two pre-plugin answers stay stale…`) | — | [0800](../agent-bridges/0800-codex-command-catalogue-armed-delay-race.md) (resolved; recurrence), [0791](../agent-bridges/0791-codex-command-catalogue-stale-race.md) (open) |

## Conclusion

One failure was a real regression of this branch (the diagnostics registry
test) and is fixed. None of the other owning files is changed by the branch
beyond comments. They are five-second deadlines on real Git and bridge
fixtures under extreme host load (they pass alone or with a longer timeout),
or deterministic host-dependent failures that reproduce identically on the
base commit. No assertion, deadline, skip or implementation was loosened.

## Review-fix validation, 2026-10-27

The review fixes are in `8ac5898c6`. Validation uses the default worker
configuration unless the command below specifies otherwise. The full run was
`mise run test:logged -- --name repository-tests -- mise run test`; its inner
logs are in `orkestrator-test-run.kwGUWf` under the host temporary directory.
The workspace reservation was four workers, the root suite one worker and the
bridge reservation two workers. The host load average during the run was
51/85/105 (one/five/fifteen minutes).

The full run exited 1 after 870.2 seconds (867.5 seconds inside the aggregate
runner). Backend: 12,025 passed, 120 skipped, 46 failed and 32 between-test
errors. Desktop: 1,369 passed, 16 skipped, two failed. Root/support: 3,526
passed, two failed. Claude bridge: 1,705 passed, one failed; the other four
bridges passed. Web, web-public, CLI, protocol, toolchain and the Codex
protocol-lockfile group passed. All failures were in the unchanged owners
listed earlier in this case: environment moves, command integration,
environment/worktree creation, diff statistics, Git snapshots/watchers,
pinned Docker image identity, staged input relay, profile cleanup, migration
copy and coordinator sandbox qualification. The affected lifecycle, grant,
diagnostic and production-construction tests had no failures. The final
artifact directory contains `summary.json` and bounded compressed group logs.

The following checks passed:

- `mise run test:logged -- --name static-checks -- mise run check`: format,
  lint and all workspace typechecks (existing unused-import warnings remain).
- `lifecycle-regressions`: 25 tests in `docker-cleanup-grants.test.ts`,
  `tmux-runtime.test.ts`, `host-suspend-detector.test.ts`,
  `backend-runtime-wiring.test.ts` and `tests/container-oom-events.test.ts`.
  Command: `bun test --cwd apps/backend --preload ../../tests/setup-node.ts
  <the five explicit ./src/core or ./tests paths> --parallel=2 --only-failures`,
  through `test:logged`; 2.2 seconds. This covers late reconciliation, direct
  admission after shutdown, scheduled/in-flight/initial pane captures, both
  runtime shutdown orders, production constructor wiring, grant capacity and
  expiry, and OOM follower ownership and stop/start idempotence.
- `tmux-and-cleanup-owners`: the complete existing `tests/tmux-poll.test.ts`,
  `tests/tmux-poll-signal.test.ts`, `tests/tmux-interactive.test.ts`,
  `tests/tmux-commands-interactive.test.ts`, `src/core/backend-runtime.test.ts`
  and `src/core/commands-environment-cleanup.test.ts`; same backend command
  shape with `--parallel=2`, 12.7 seconds.
- A workspace-specific image built with `mise run docker:build:dev --profile
  backend-state-review`. The real `tests/claude-state-signal-docker.test.ts`
  passed with `ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE=orkestrator-v2:dev-b4cba3e0bc3c`,
  backend node preload and `--parallel=1`, through `test:logged`; 3.7 seconds.
  The test removes its exact owned container and temporary state.
- Five real Electron scenarios passed with `bunx playwright test --config
  e2e/agent-testing/playwright.electron.config.ts
  e2e/agent-testing/electron-main.spec.ts --grep 'shares one backend|backend exit wiring'`,
  through `test:logged`; 80.1 seconds. Each scenario owns and cleans its
  temporary profiles and processes; no persistent launcher was started.

The root suite repeated the two migration-copy failures above: 3,526 passed,
two failed in 226.3 seconds. The complete owner rerun, `bun test
./tests/unit/migrate-copy.test.ts --parallel=1 --only-failures` through
`test:logged`, also failed identically (10 passed, two failed, 1.9 seconds;
`orkestrator-test-run.6NIR8F`). Extraction status is `2` instead of `0` for
both missing-completion cases. The complete profile-cleanup owner rerun,
`bun test --cwd apps/desktop ./scripts/dev/profile-cleanup.test.ts
--parallel=1 --only-failures` through `test:logged`, repeated both macOS
Keychain-warning mismatches (20 passed, two failed, 0.8 seconds;
`orkestrator-test-run.RwXTny`). These are deterministic failures already
recorded above and in case 1100, not newly classified flakes.

The bridge group repeated `Claude coordinator sandbox qualification >
default-sandbox-writes` at 17,013.59 ms. The complete unchanged owner rerun,
`bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts
./src/conformance-coordinator-sandbox-live.test.ts --parallel=1 --only-failures`
through `test:logged`, also failed that case at 17,013.30 ms (eight passed,
one failed, 98.9 seconds; `orkestrator-test-run.2q7OY8`). The offline fixture
aborts the pinned CLI at its own deadline. This run does not establish a
parallel-only flake.

The unchanged environment-move owner also remained non-green alone:
`bun test --cwd apps/backend --preload ../../tests/setup-node.ts
./src/core/environment-move.test.ts --parallel=1 --only-failures` through
`test:logged` returned 18 passed, 20 failed and 18 between-test errors in
267.8 seconds (`orkestrator-test-run.3ss5D3`). Tests and hooks exceeded their
five-second deadlines; ensuing continuations encountered removed fixture
directories. This repeats the deadline failure family above, without
establishing that the current recurrence passes alone.

## Open verification carried over from retired todo 0133

Todo 0133's removal did not complete these checks. Both remain open here:

- [ ] Obtain a green `mise run test` on a quiet host. The recorded aggregate
  runs above did not pass; focused reruns do not establish a green full suite.
- [ ] Run a production-configured backend with a throwaway profile and data
  directory, following the isolation rules in `AGENTS.md`. Confirm through
  the construction options introduced by 0133 that a claude-tmux tab exports
  the active account's `CLAUDE_CONFIG_DIR`, Claude state polls arm the doorbell
  in a container, the usage view shows OOM counts, and coordinator Claude and
  Codex logins refresh through the keeper. Record the profile, command and
  observed results here before marking this check complete. The focused
  Docker signal and constructor-wiring tests above do not complete this live
  backend check.

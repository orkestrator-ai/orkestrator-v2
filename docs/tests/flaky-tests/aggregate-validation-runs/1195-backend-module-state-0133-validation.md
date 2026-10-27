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

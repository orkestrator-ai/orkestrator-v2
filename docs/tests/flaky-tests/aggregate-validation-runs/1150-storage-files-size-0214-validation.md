# Storage files over the size limit (todo 0214) branch validation

- **ID:** 1150
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0214-storage-files-over-size-limit-e4d9bb3f3d4f` at
  `555cf0282`, based on `main` `863b5782`. The branch moves storage code
  between `apps/backend/src/core/storage*.ts` files and classes; it does not
  touch containers, Docker, the desktop dev scripts or the migration helper.
- **Command:** `mise run test` (logs `orkestrator-test-run.GiIUgj` below the
  host temporary directory), exit 1 after 812.0 s. Bridges and the Codex
  protocol lockfile passed. Backend 12,043 passed, 120 skipped, 9 failed;
  desktop two failed; web 9,941 passed; root/support 3,526 passed, two failed.
- **Host:** shared macOS host (node mbp3), load average about 12–17 after the
  run, other sessions' suites in parallel.

## Failures and what they are

Owners were rerun alone with
`mise run test:logged -- --name o214-<label> -- bash -c "cd <package> && bun test ./<file> --parallel=1"`
on the branch. Owners that also failed alone were rerun the same way on a
detached worktree of the base `863b5782` (`/private/tmp/o214-base-863b578`,
own `bun install --frozen-lockfile`, removed afterwards).

| Owning file | Aggregate failures | Owner alone on the branch | Base `863b5782` alone | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/tests/container-replacement.test.ts` | `copy plan > only the daemon's answer that a path is missing counts as nothing to copy` (5002.36 ms) and `restart reconciliation > a kill at any phase before the commit write leaves the original authoritative` (5001.48 ms): five-second deadlines | 29 passed, 0 failed, 23.5 s | not needed | Restart reconciliation: [0244](../environments-and-containers/0244-container-replacement-reconciliation-timeout.md) (recurrence). The copy-plan case has no case of its own; recorded here. |
| `apps/backend/tests/container-storage.test.ts` | `storage helper > reports unknown content and foreign markers without touching data` (5001.41 ms) | 9 passed, 0 failed, 3.8 s | not needed | [0672](../environments-and-containers/0672-container-storage-marker-aggregate-timeout.md) (recurrence) |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases (`a mount node cannot read is copied owner-only…`, `a mount node can read is left alone…`, `a revoked provider's emptied mount relays nothing…`, `links are never followed…`): assertion failures, for example a relay directory that should be gone still exists | 5 passed, 4 failed, deterministic | 5 passed, 4 failed (same four) | Not a flake: fails alone on the base. Last changed by #1307 (todo 0109). |
| `apps/backend/tests/docker-image.test.ts` | `pinned image identity > a restricted runtime on a gateway image joins its egress gateway with no capability` (the gateway create lacks `--add-host host.docker.internal:host-gateway`) and `… a rootless daemon names the host address the reachability check chose` | 19 passed, 2 failed, deterministic | 19 passed, 2 failed (same two) | Not a flake: fails alone on the base. Last changed by #1307 (todo 0109). |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases with an unexpected `keychainWarning` | 20 passed, 2 failed | 20 passed, 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) (macOS only) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed`: extraction status 2, not 0 | 10 passed, 2 failed | 10 passed, 2 failed | [1013](1013-interactive-command-main-merge-validation.md), [1101](1101-codex-typed-prompts-0211-validation.md) |

## Conclusion

No failing file is owned or reached by the 0214 change. The two container
deadline failures are aggregate-only (their owners pass alone). The
staged-input-relay and docker-image failures are deterministic on this macOS
host and identical on the base, so they belong to their owners (both last
changed by #1307), not to this branch; they are not flakes and get no case
of their own here. Profile-cleanup and migrate-copy repeat their known
deterministic failures. No assertion, deadline, skip or implementation was
changed.

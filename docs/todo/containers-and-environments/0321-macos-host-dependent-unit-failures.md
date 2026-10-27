# Relay, Docker reachability and profile-cleanup tests fail on macOS hosts

Found on 2026-10-27 while validating branch
`search-projects-environments-d964ef18680e-r1` (⌘K search across machines,
PR #1327). That branch does not touch any of the files below. The failures
are unrelated to the search change. The aggregate run is recorded in flake case
[1126](../../tests/flaky-tests/aggregate-validation-runs/1126-cross-machine-search-validation-workspace-failures.md).
This todo is a sibling of
[0320](0320-migrate-copy-test-macos-bsdtar.md) (the same pattern for the
migration helper).

## Current state

Each owner below fails with identical assertions on the branch and on a
detached `origin/main` worktree (`863b57821`), run alone with
`bun test --preload ../../tests/setup-node.ts <file>` on a macOS arm64 host
(Darwin 27).

1. `apps/backend/tests/staged-input-relay.test.ts`: 5 pass, 4 fail.
   - `a mount node cannot read is copied owner-only …`: the relay directory
     mode is `0755` where the test expects `0700`.
   - `a mount node can read is left alone, and an earlier relay is removed`:
     the old relay directory survives.
   - `a revoked provider's emptied mount relays nothing at the next boot`:
     the relay keeps stale entries.
   - `links are never followed, and an over-bound mount is not relayed`:
     the over-bound mount is relayed.
   - Cause: the test runs `relay_staged_inputs` from
     `docker/network-policy-entrypoint.sh` under the host shell, and that
     function uses GNU-only userland: `rm -rf --one-file-system`,
     `find ! -readable`, `du -s -B1 --apparent-size` and
     `install -d -o -g -m`. On macOS these fail or behave differently, so the
     function errors out (the script then prints "Staged inputs were not
     relayed"). Production is not affected, because the entrypoint only runs
     inside the Linux image.
2. `apps/backend/tests/docker-image.test.ts`: 19 pass, 2 fail.
   - `pinned image identity > a restricted runtime on a gateway image joins
     its egress gateway with no capability` lacks
     `--add-host host.docker.internal:host-gateway`.
   - `… a rootless daemon names the host address the reachability check
     chose` lacks `--add-host host.docker.internal:10.0.2.2`.
   - Cause: the host-reachability check in
     `apps/backend/src/core/container-host-reachability.ts` runs only when
     `process.platform === "linux"`. The tests build a Linux daemon
     fixture but leave the reachability service on the real host platform,
     so on macOS the alias is never chosen.
3. `apps/desktop/scripts/dev/profile-cleanup.test.ts`: 20 pass, 2 fail.
   - `pruneProfiles > the age rule applies only when asked for` and
     `… unregisters worktrees the profile made in an outside repository`
     return an extra `keychainWarning`.
   - Cause: `removeProfileKeychainItem` defaults to `process.platform`. On
     darwin it checks the profile root against the real default development
     root and warns about profiles in the test's temporary roots. On Linux it
     returns early, which is what the expectations assume. Merge validation
     [1013](../../tests/flaky-tests/aggregate-validation-runs/1013-interactive-command-main-merge-validation.md)
     saw the same failure.

## Items

1. Make the relay test host-independent. Either run it only where GNU
   coreutils/findutils are present (skip with a clear message otherwise), or
   put `g`-prefixed GNU tools first on `PATH`. Do not weaken the assertions.
2. Pass `platform: "linux"` (or the fixture's daemon platform) to the
   reachability service in the two `docker-image.test.ts` cases, or gate
   those cases on Linux.
3. Inject `platform` (or the Keychain owner roots) into `pruneProfiles` from
   the two profile-cleanup tests, so they do not depend on the host OS.
4. Confirm that the backend and desktop workspace owners pass on a macOS
   host afterwards.

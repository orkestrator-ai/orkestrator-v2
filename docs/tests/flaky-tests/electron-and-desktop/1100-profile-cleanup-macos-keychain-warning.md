# Profile cleanup tests expect no Keychain warning on macOS

- **ID:** 1100
- **Status:** open
- **Date observed:** 2026-10-26
- **Tests:** `pruneProfiles > the age rule applies only when asked for` and
  `pruneProfiles > unregisters worktrees the profile made in an outside repository`
- **File:** `apps/desktop/scripts/dev/profile-cleanup.test.ts`

## Symptom

Both tests fail on every macOS run, alone or in the aggregate: each removed
outcome carries an extra `keychainWarning` ("Kept the login Keychain item for
"Orkestrator AI — DEV [idle]": the profile is outside the default development
root, whose profile of the same id owns it."), which the tests' `toEqual` does
not expect. The other 20 tests in the file pass.

This is not a flake. It is deterministic and platform-dependent, and is
registered here so a macOS `mise run test` failure in this file is recognised.

## Cause

`removeProfileKeychainItem` (`profile-cleanup.ts`, added with todo 0023 in
#1299) returns that warning on `darwin` whenever the profile lives outside the
platform's default development root. The tests use a temporary root and do
not pass `platform` or `keychainRoots` to `pruneProfiles`, so on macOS the
guard fires; on Linux it returns early with no warning. The sibling Keychain
tests pass because they set `platform: "darwin"` and `keychainRoots: roots`
explicitly.

## Evidence

- 2026-10-26, todo 0211 branch (`fdcb5345d`, which does not touch
  `apps/desktop`): the complete owner alone,
  `mise run test:logged -- --name 0211-profile-cleanup-owner -- bun test --cwd apps/desktop ./scripts/dev/profile-cleanup.test.ts --parallel=1`,
  20 passed and 2 failed, the same two. The same two failed in that branch's
  `mise run test` aggregate.
- The same complete owner failed the same way in a detached `origin/main`
  (`ce205ad34`) worktree, and earlier during the interactive command main
  merge ([1013](../aggregate-validation-runs/1013-interactive-command-main-merge-validation.md)).

## Fix (not done here)

The owner of todo 0023 should pass `platform` (or `keychainRoots: roots`) in
these two tests, or match the outcome with `toMatchObject`. Not changed from
the 0211 branch, which does not own this code.

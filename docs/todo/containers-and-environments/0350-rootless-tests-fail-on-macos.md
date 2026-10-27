# Rootless-runtime unit tests fail on macOS hosts

Found on 2026-10-27 while validating
[0202](../cross-cutting/0202-webkit-title-tooltip-outside-tap.md) on a macOS
host, against `main` at `863b5782`. The tests came in with
[0109](0109-rootless-linux-runtime-gaps.md) (`1aabf049e`).

## Current state

Six cases in two backend files fail every time on macOS, both in
`mise run test` and with their owning file run alone. They fail the same
way in a clean `origin/main` worktree, so they are not flakes, and they do
not depend on the change being validated. CI runs on Linux and passes them.

- `apps/backend/tests/staged-input-relay.test.ts`: four cases fail
  (`a mount node cannot read is copied owner-only…`,
  `a mount node can read is left alone…`,
  `a revoked provider's emptied mount relays nothing…`,
  `links are never followed…`). The test runs the root entrypoint's
  `relay_staged_inputs` shell function on the host with the host's tools.
  On macOS the relay directory ends up `0755` instead of `0700`, an earlier
  relay is not removed, and an emptied mount still relays its files. These
  results suggest GNU-only behaviour (coreutils or `find` flags) that BSD
  tools do not share. Not diagnosed further.
- `apps/backend/tests/docker-image.test.ts`, `pinned image identity`: two
  cases fail (`a restricted runtime on a gateway image joins its egress
  gateway with no capability`, `a rootless daemon names the host address
  the reachability check chose`). They expect an `--add-host
  host.docker.internal:…` argument, but `ContainerHostReachability` skips
  its check unless `process.platform === "linux"`
  (`container-host-reachability.ts`), so on macOS the argument is never
  added.

## Outstanding work

### Code

1. Make the two docker-image cases independent of the host platform:
   inject `platform: "linux"` (the reachability service already accepts a
   `platform` dependency) or gate the cases on Linux.
2. Find which command in `relay_staged_inputs` behaves differently on
   macOS. Then either run the test only where the container's tools exist
   (Linux, or inside the image), or make the test supply GNU tools.
   Do not change the entrypoint for macOS: it only runs in Linux
   containers.

### Qualification

- `mise run test` on a macOS host reaches neither file's failures, and the
  Linux CI run still passes them.

## Constraints and rationale

- The entrypoint runs only inside the Linux container image, so the fix
  belongs in the tests, not in the script.

## Assumptions and decisions

- **Filed rather than fixed in 0202 (2026-10-27).** 0202 changed only the
  web shell's tooltip. Gating or rewriting container tests is out of its
  scope and needs someone who knows 0109's intent.

## Open questions

- Which relay commands differ on BSD tools?

## Needs verification

- None yet.

## Related

- [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md):
  added these tests.
- [Aggregate validation case 1155](../../tests/flaky-tests/aggregate-validation-runs/1155-webkit-title-tooltip-0202-validation.md):
  the run that found this.

## Replaces

Nothing; this was newly found.

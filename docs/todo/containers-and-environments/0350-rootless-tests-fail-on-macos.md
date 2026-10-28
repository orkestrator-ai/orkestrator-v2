# Rootless-runtime unit tests fail on macOS hosts

Found on 2026-10-27 while validating
[0202](../cross-cutting/0202-webkit-title-tooltip-outside-tap.md) on a macOS
host, against `main` at `863b5782`. The tests came in with
[0109](0109-rootless-linux-runtime-gaps.md) (`1aabf049e`).

**Finished 2026-10-28.** Every item is done. The file is kept until the
branch merges, for its decisions, and then deleted.

## Current state

When filed, six cases in two backend files failed every time on macOS, both
in `mise run test` and with their owning file run alone. They failed the same
way on a clean `origin/main`, so they were not flakes. CI runs on Linux and
passed them.

- `apps/backend/tests/staged-input-relay.test.ts`: four `staged input relay`
  cases. The test runs the root entrypoint's `relay_staged_inputs` shell
  function on the host, with the host's tools.
- `apps/backend/tests/docker-image.test.ts`, `pinned image identity`: two
  cases (`a restricted runtime on a gateway image joins its egress gateway
  with no capability` and `a rootless daemon names the host address the
  reachability check chose`). Both expect an `--add-host
  host.docker.internal:…` argument.

What fixes them now:

- **Docker-image cases.** `beb1ec4c8` (#1365) sets `process.platform` to
  `linux` for both cases and restores it afterwards. The `--add-host`
  decision is `shouldAddDockerHostGatewayAlias(process.platform, …)` in
  `apps/backend/src/core/commands-containers.ts`. The original note blamed
  `ContainerHostReachability`, but that is not the cause: the rootless case
  already stubs that service, and the service's own `platform` dependency is
  never consulted on this path.
- **Relay cases.** `beb1ec4c8` also runs the relay with `gnuToolPath`
  (Homebrew's GNU tools ahead of `PATH`) and replaces the `-g <name>` passed
  to `install` with the host user's numeric group. This branch adds a skip:
  the `staged input relay` block now runs only when `rm` and `du` on
  `gnuToolPath` are GNU coreutils (`missingGnuTools("rm", "du")` in
  `tests/unit/gnu-shell-tools.ts`). Otherwise the block is skipped, and each
  title gives the reason and the Homebrew install command. The macOS
  prerequisites in `docs/development/testing-guide.md` list the new tools.

### Which relay commands differ on BSD tools

Each command in `relay_staged_inputs` was checked on this host
(Darwin 27, arm64) with only `/usr/bin:/bin:/usr/sbin:/sbin` on `PATH`:

| Command | BSD result | Effect on the test |
| --- | --- | --- |
| `rm -rf --one-file-system -- dir` | `illegal option -- -`, exit 64 | An earlier relay is never removed. The stale tree then survives, `install -d` is skipped, and an emptied mount keeps its old files. |
| `du -s -B1 --apparent-size dir` | `unrecognized option`, exit 64 | `bytes` is empty and counts as 0, so the byte bound is silently off. |
| `install -d -o user -g group -m 0700` | Works, given a group that exists | Before `beb1ec4c8` the test passed the user name as the group. macOS users' primary group is `staff`, so `install` failed, `mkdir -p` created the relay with the default `0755`, and that is the mode the first case saw. |
| `find -P dir` | Works | None. The `find ! -readable` probe is stubbed in the test. |
| `tar … --no-same-owner --no-same-permissions` (bsdtar) | Works: `0700` directories, `0600` files under `umask 077` | None. |

With BSD tools on `PATH`, the same four cases fail again (5 pass, 4 fail),
and stderr shows the `rm` and `du` usage errors. GNU coreutils alone is
enough: GNU findutils and GNU tar are not needed.

## Outstanding work

None.

### Done

1. **Docker-image cases do not depend on the host platform.** Fixed in
   `beb1ec4c8`. No further change; see the decision below.
2. **Relay cases run only where the container's tools exist.** The
   differing commands are found (table above). The test supplies GNU tools
   when Homebrew's are installed, and otherwise skips the relay block with a
   clear reason. The entrypoint is unchanged.

### Qualification (done)

- macOS, this host (Homebrew GNU tools installed): both owners pass alone,
  30 pass and 0 fail. With `gnuToolPath` temporarily pointed at BSD tools
  only, the relay file reports 5 pass, 4 skip and 0 fail.
- Linux, in a throwaway `oven/bun:1.4.4` container (Debian, aarch64,
  `rm`/`du` GNU coreutils 9.7, `jq` 1.7 added) built from a copy of this
  branch: both owners pass, 30 pass and 0 fail. The four relay cases ran,
  and none was skipped.
- Linux CI on `main`: the `Unit and integration tests` job of run
  `40616793104` (`beb1ec4c8`) passed. On run `40617349997` (`1d1f0a87`, this
  branch's base) the only failure is in `verified copy helper` (0320's
  area), and none in these two owners.
- `mise run test` on this host (2026-10-28): all four default-tier groups
  passed (root and agent-support, bridges, codex protocol lockfile, and the
  workspace group that runs both owners), in 564 s.

## Constraints and rationale

- The entrypoint runs only inside the Linux container image, so the fix
  belongs in the tests, not in the script.

## Assumptions and decisions

- **Filed rather than fixed in 0202 (2026-10-27).** 0202 changed only the
  web shell's tooltip. Gating or rewriting container tests is out of its
  scope and needs someone who knows 0109's intent.
- **Docker-image cases: keep `beb1ec4c8`'s `process.platform` override
  (2026-10-28).** Options:
  1. Keep the scoped override, restored in `finally`.
  2. Add a host-platform field to the lifecycle context and pass it to
     `shouldAddDockerHostGatewayAlias`.
  3. Gate both cases on Linux.

  Chose 1. The override already fixes the cases on macOS and passes on
  Linux. Option 2 would add a production seam only for tests, at a call
  that is already unit-tested as a pure function. Option 3 would stop the
  cases from running on every macOS run. Pros: no production change, and the
  cases still run everywhere. Cons: the override is process-wide while each
  case runs. That is safe because Bun runs the cases in one file one after
  another, and `--parallel` isolates files, but a future concurrent case in
  this file would see `linux`.
- **The todo's suggested reachability `platform` injection does not apply
  (2026-10-28).** The reachability service is stubbed in the rootless case.
  The `--add-host` decision reads `process.platform` directly in
  `commands-containers.ts`. Injecting the service's `platform` would have
  changed nothing.
- **Relay cases: supply GNU tools when present, skip otherwise
  (2026-10-28).** Options:
  1. Supply GNU tools only (`beb1ec4c8`), which fails on a Mac without
     Homebrew's coreutils.
  2. Add a skip guard to option 1.
  3. Gate the block on `process.platform === "linux"`.
  4. Run the relay in the image.

  Chose 2. It runs the cases wherever the image's tools exist, including
  macOS with Homebrew (which the testing guide already requires), and a
  host without them gets a named skip, not four red cases. Option 3 would
  drop coverage on macOS hosts that can run the cases. Option 4 needs Docker
  and a built image in the default suite. Pros: assertions unchanged, and
  the cases skip only with a stated reason. Cons: a Mac without Homebrew
  coreutils does not exercise the relay locally. CI on Linux still does.
- **Check `rm` and `du`, not all GNU tools (2026-10-28).** The probe table
  shows that only those two differ in a way the test sees, so the guard
  checks exactly what the function needs. A broader guard would skip on
  hosts that pass. `missingGnuTools` gained `rm` and `du` signatures
  ("GNU coreutils") next to `date` and `tar`.
- **0321 overlap left to its owner (2026-10-28).** Items 1 and 2 of
  [0321](0321-macos-host-dependent-unit-failures.md) are the same two owners.
  A sibling branch is working on 0321, so this branch does not edit that
  file. Its owner can mark those items done once this branch merges.

## Open questions

- None. (Answered: which relay commands differ on BSD tools. See the table
  above.)

## Needs verification

- None. The Linux run used a local container, not GitHub CI. A PR's CI run
  repeats the same check automatically.

## Related

- [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md):
  added these tests.
- [0321-macos-host-dependent-unit-failures.md](0321-macos-host-dependent-unit-failures.md):
  overlaps items 1–2.
- [0320-migrate-copy-test-macos-bsdtar.md](0320-migrate-copy-test-macos-bsdtar.md):
  the same pattern for the migration helper. It shares `gnu-shell-tools.ts`.
- [Aggregate validation case 1155](../../tests/flaky-tests/aggregate-validation-runs/1155-webkit-title-tooltip-0202-validation.md):
  the run that found this.

## Replaces

Nothing; this was newly found.

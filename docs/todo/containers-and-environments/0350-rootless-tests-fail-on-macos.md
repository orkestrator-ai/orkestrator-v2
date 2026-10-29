# Rootless-runtime unit tests fail on macOS hosts

Found on 2026-10-27 while validating
[0202](../cross-cutting/0202-webkit-title-tooltip-outside-tap.md) on a macOS
host, against `main` at `863b5782`. The tests came in with
[0109](0109-rootless-linux-runtime-gaps.md) (`1aabf049e`).

**Finished 2026-10-28.** Every item is done. The branch that finished it
merged as `92ed6b099` (#1374), so the file can now be deleted.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

Every item is done and merged. The decisions are recorded under
"Assumptions and decisions" and are not repeated here.

### Tasks

1. **Docker-image cases do not depend on the host platform**: the two `--add-host` cases in `docker-image.test.ts`. Status: done.
2. **Relay cases run only where the container's tools exist**: the four `staged input relay` cases. Status: done.
3. **Qualification on macOS and Linux**: both owners pass on both platforms. Status: done.

### 1. Docker-image cases do not depend on the host platform

**Problem.** Two `pinned image identity` cases expected an `--add-host host.docker.internal:…` argument that macOS never produces.

**Context.** The decision is `shouldAddDockerHostGatewayAlias(process.platform, topology.kind)` at `apps/backend/src/core/commands-containers.ts:276`.

**Investigation.** Both cases set `process.platform` to `linux` and restore it in `finally` (`apps/backend/tests/docker-image.test.ts:709` and `:800`, `:847` and `:876`), from `beb1ec4c8` (#1365).

**Decisions.** None; done. See "Assumptions and decisions".

### 2. Relay cases run only where the container's tools exist

**Problem.** BSD `rm` and `du` reject the GNU flags `relay_staged_inputs` uses, so the four relay cases failed on macOS.

**Context.** The table under "Current state" lists each command's BSD behaviour.

**Investigation.** The merged shape (`92ed6b099`) differs from the guard this file first described. `apps/backend/tests/staged-input-relay.test.ts:33-61` probes `rm --one-file-system` and `du -s -B1 --apparent-size` on `gnuToolPath` directly. The GNU lane skips only on macOS outside CI (`:176-182`); on Linux and CI a missing flag fails "the required GNU flags are available" (`:186`). macOS also runs a BSD lane with only system tools, through shell adapters that map the flags to BSD `rm -x` and `du -A` (`BSD_RELAY_ADAPTERS`, `:64-80`). `docs/development/testing-guide.md:204-211` describes this. `missingGnuTools` still has `rm` and `du` signatures (`tests/unit/gnu-shell-tools.ts:31-32`), but the relay test no longer calls it.

**Decisions.** None; done. See "Assumptions and decisions".

### 3. Qualification on macOS and Linux

**Problem.** The fix had to be shown on both platforms.

**Context.** The runs are listed under "Outstanding work".

**Investigation.** On Linux (omarchy-hp, 2026-10-28, `main` at `79f3bc97`), the two owners pass: 33 pass, 0 fail. The macOS figures below were recorded before the BSD lane was added, so the macOS skip count no longer applies; they were not re-run on macOS for this analysis.

**Decisions.** None; done.

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
  to `install` with the host user's numeric group. `92ed6b099` (#1374) then
  probes the two GNU flags the relay needs (`rm --one-file-system`,
  `du -s -B1 --apparent-size`) instead of calling
  `missingGnuTools("rm", "du")`, as this file first said. Where the flags are
  missing, the GNU lane is skipped with the reason and the Homebrew install
  command, but only on macOS outside CI; on Linux and CI it fails. On macOS a
  second lane runs every relay case with system tools only, through adapters
  that map the flags to BSD `rm -x` and `du -A`. The macOS prerequisites in
  `docs/development/testing-guide.md` list the new tools and the BSD lane.

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
   when Homebrew's are installed, skips the GNU lane on macOS with a clear
   reason otherwise, and runs a BSD lane with adapters on macOS. The
   entrypoint is unchanged.

### Qualification (done)

- macOS, this host (Homebrew GNU tools installed): both owners pass alone,
  30 pass and 0 fail. With `gnuToolPath` temporarily pointed at BSD tools
  only, the relay file reports 5 pass, 4 skip and 0 fail. (Recorded before
  the BSD lane was added in review; with it, the BSD-only case runs the relay
  cases instead of skipping them.)
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
- Linux, omarchy-hp, `main` at `79f3bc97` (2026-10-28): both owners pass
  alone, 33 pass and 0 fail.

## Constraints and rationale

- The entrypoint runs only inside the Linux container image, so the fix
  belongs in the tests, not in the script.

## Open questions

- None. (Answered: which relay commands differ on BSD tools. See the table
  above.)

## Needs verification

- None. The Linux run used a local container, not GitHub CI. A PR's CI run
  repeats the same check automatically.

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

## Related

- [0109-rootless-linux-runtime-gaps.md](0109-rootless-linux-runtime-gaps.md):
  added these tests.
- 0321 (macOS host-dependent unit failures) overlapped items 1–2. It was
  closed on `main` in `8edf2329c` (#1370); its resolution is in
  [aggregate case 1126](../../tests/flaky-tests/aggregate-validation-runs/1126-cross-machine-search-validation-workspace-failures.md).
- [0320-migrate-copy-test-macos-bsdtar.md](0320-migrate-copy-test-macos-bsdtar.md):
  the same pattern for the migration helper. It shares `gnu-shell-tools.ts`.
- [Aggregate validation case 1155](../../tests/flaky-tests/aggregate-validation-runs/1155-webkit-title-tooltip-0202-validation.md):
  the run that found this.

## Replaces

Nothing; this was newly found.

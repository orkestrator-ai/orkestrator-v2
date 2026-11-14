# Release chain: live evidence and what the pin does not cover

Carried from security report batch S5, part `0140` tasks 2 and 4 (finding L6). The code for both is built; what is here could not be proved without a release, or was outside what those tasks decided.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`; re-checked 2026-11-05 against `main` at `69a3b4ca5`, when tasks 3 and 4 were done, and 2026-11-14 against `main` at `dc90609bf`, when task 2's Linux run passed.

### Tasks

2. **Prove a published release installs from its lockfile**: a real update on a standalone Linux host (a disposable systemd container, as in 0033 (retired)). Status: done (2026-11-14): a standalone service installed with 2.38.0-beta updated itself to 2.38.1-beta, and both release directories hold the published lockfile with every package at its locked version; `sharp` loads from each. The macOS half, which needs a spare Mac account, is in the manual-test checklist (7568: 5022 task 2).
3. **Pin the Bun that `install.sh` downloads**: it still fetches Bun's own installer with `curl | bash`. Status: done (2026-11-05): the script downloads Bun's release archive and checks it against stated SHA-256s.
4. **Lock the first run through `bunx`**: `bunx` resolves transitive dependencies afresh before the service install takes over. Status: done (2026-11-05) for releases that publish `resources/release-runtime/`; the current pin, 2.36.1, predates it and still runs through `bun x` until the pin moves (proving that on the live site is 5022 task 1 in the manual-test checklist, 7568).

### 2. Prove a published release installs from its lockfile

**Problem.** The updater path has only run against a loopback registry and a packed tarball. A release cannot show it until one carries `resources/release-runtime/`.

**Context.** `installRelease` (`packages/protocol/src/node/standalone-service.ts`) fetches the package with scripts off, then runs `bun install --frozen-lockfile` on the manifest and lockfile the package publishes. The code doing the install belongs to the release already on the host, so the first update that takes this path is the second release after this work: a host must already run a release with the new `installRelease`, and the target must carry the lockfile.

**Investigation.** Done on Linux x64 against Bun 1.4.4:
- `packages/protocol/src/node/standalone-service-install.test.ts`: real installs from a loopback registry. The lockfile's version wins over a newer one, and a mismatched manifest, a wrong hash and a missing lockfile are all refused with no release left behind.
- `installRelease` on the packed `orkestrator` tarball, with other packages proxied from npm: installed in about 4 s, and `bin/orkestrator.js --version` reported the version.
- `bun install --frozen-lockfile --os … --cpu …` accepted the lockfile for linux x64, linux arm64, darwin arm64 and darwin x64, and chose each platform's `@img/sharp-*` and Agent SDK packages. Only linux x64 ran the result.

Re-checked 2026-11-05: `installRelease` is now `packages/protocol/src/node/standalone-service.ts:352`; the rest holds. Task 4 gives the first run the same install, so the run in 0033 (retired) can watch both: the first run from `install.sh` and the update after it.

**Outcome (2026-11-14).** The recommended option was taken. `scripts/qualify-standalone-service.ts`'s update phase now inspects both release directories (`scripts/qualify-locked-release.ts`): the root's `package.json` and `bun.lock` must be byte-for-byte the ones the package publishes in `resources/release-runtime/`, every installed package must have the version the lockfile names, and no package the lockfile does not list may be installed. `sharp` must load from the release's package root and encode a PNG. The report also lists the locked entries a fresh resolution of the same manifest would move today, which shows the lockfile, not the registry, chose them. Tests: `tests/unit/qualify-locked-release.test.ts` (a frozen install passes; a newer version, an unlisted package, a missing or different lockfile, a generated manifest and a missing runtime each fail) and two new cases in `tests/unit/qualify-standalone-service.test.ts`.

Run on beelink (Linux x64, Debian 13 container with systemd as PID 1, user `qual` with linger on, disposable rootless Docker daemon `q5022`), 2026-11-14 02:13 to 02:18 UTC:

```bash
mise run build:cli
mise run docker:disposable -- start --name q5022
eval "$(mise run docker:disposable -- env --name q5022)"
bun scripts/qualify-host-upgrades-container.ts --name q5022 --phases service --report output/qualification-5022/report.json
mise run docker:disposable -- stop --name q5022
```

Exit 0; all 24 checks passed (22 in the service part, 2 in the container script). The ones for this task:

| Check | Observed |
| --- | --- |
| `service install` of 2.38.0-beta from npm (Bun 1.4.4) | starts and serves; `releases/2.38.0-beta` was installed by 2.38.0-beta's own `installRelease` |
| 2.38.0-beta installed from its published lockfile | `bun.lock` and `package.json` equal the published ones; lockfile SHA-256 `c2ba90dd3048…3f9d`; 145 entries: 112 installed, each at its locked version, 30 for another os/cpu/libc, 3 optional and not installed (`@emnapi/runtime`, `@img/sharp-wasm32`, `tslib`); none mismatched, none extraneous |
| `apply --when-idle --wait` to 2.38.1-beta | exits 0; job `succeeded`; `current` 2.38.1-beta, `previous` 2.38.0-beta |
| 2.38.1-beta installed from its published lockfile (by the 2.38.0-beta backend's updater) | the same as above: published files byte-for-byte, the same lockfile hash (the two releases publish identical lockfiles), 112 at their locked versions, none mismatched or extraneous |
| `sharp` from each release | sharp 0.35.5, libvips 8.18.7, a PNG encoded and read back |
| Fresh resolution of the same manifest that day | 7 entries would move: `@anthropic-ai/sdk` 1.6.0 → 1.8.0, `@babel/runtime` 7.29.13 → 7.29.14, `@hono/node-server` 2.1.6 → 2.1.8, `encodeurl` 2.0.1 → 2.0.3, `express-rate-limit` 8.7.3 → 8.7.4, `hono` 4.13.17 → 4.13.18, `jose` 6.2.16 → 6.2.17; each release has the locked (older) version installed |

The cancel, rollback and engines checks passed as on 2026-11-13 (see [host-updates.md](../../architecture/host-updates.md#qualification)). Nothing failed, so nothing needed a fix. The container, its image and the daemon were removed; the run left only `output/qualification-5022/` (git-ignored) in the worktree.

**Decisions.**

- **How to qualify it?**
  - **Add it to the standalone service run of 0033 (retired; now `scripts/qualify-host-upgrades-container.ts`, see [host-updates.md](../../architecture/host-updates.md#qualification)): update between two real releases on Linux (here) and macOS (7568: 5022 task 2), and check the release's `bun.lock` matches and `sharp` loads (recommended).**
    - Pros: one run covers rollback and the lockfile together; it runs on real hosts.
    - Cons: needs two releases that carry the change.
  - **Rely on `mise run smoke:cli`, which installs the lockfile before each publish.**
    - Pros: no extra run.
    - Cons: runs only on the publishing machine and skips the updater.

### 3. Pin the Bun that `install.sh` downloads

**Problem.** When Bun is missing, the script runs `curl -fsSL https://bun.com/install | bash`, so the Bun a new host gets is whatever that script picks.

**Context.** The report named this as context for task 2, with no decision. Everything later runs under that Bun, including the update path above. `mise.toml` pins the Bun the project builds with, and `packages/cli/package.json` asks for `>=1.4.4`.

**Investigation.** `apps/web-public/public/install.sh` still had the line on 2026-11-05. Bun's installer (`https://bun.com/install`, read, not run) takes a tag such as `bun-v1.4.4` as `$1`, but then still downloads the archive with no hash check. The repository already keeps Bun 1.4.4's version and four archive SHA-256s in `scripts/download-bun.sh`, enforced by `tests/unit/version-drift.test.ts`, which removes most of the second option's cost. Bun's `SHASUMS256.txt` for v1.4.4 matched those four, and supplied the hashes for the `-baseline` (no AVX2) and `-musl` (Alpine) archives that Bun's installer picks on such hosts.

**Outcome.** The second option was taken (see Assumptions and decisions). `install.sh` now chooses the archive the way Bun's installer does (Rosetta 2, AVX2, Alpine), downloads it from the `bun-v<PINNED_BUN>` GitHub release, refuses it unless its SHA-256 is the one stated in the script, checks the binary reports `PINNED_BUN`, and only then moves it into `${BUN_INSTALL:-~/.bun}/bin` with a `bunx` link. Code: `install_bun`, `bun_target` and `bun_sha256` in `apps/web-public/public/install.sh`. Tests: `tests/unit/install-script.test.ts` (each target, a wrong hash, a wrong version, a failed download, the `shasum` fallback) and `tests/unit/version-drift.test.ts` (`PINNED_BUN` equals the `mise.toml` pin; the four shared hashes equal `scripts/download-bun.sh`'s).

**Decisions.**

- **How far to pin it?**
  - **Pass a stated version to Bun's installer, stamped with the release pin (recommended).**
    - Pros: one line; a reader can see the version; a new Bun release does not reach new hosts by itself.
    - Cons: still trusts the installer script from bun.com; the stated version needs moving; the argument form needs checking.
  - **Download Bun's release archive and check it against stated hashes.**
    - Pros: nothing from outside runs unverified.
    - Cons: a hash per platform in a shell script, and a platform table to keep right.
  - **Leave it.**
    - Pros: no change.
    - Cons: the unverified download stays on the path of a new host.

### 4. Lock the first run through `bunx`

**Problem.** `bunx orkestrator@<pin>` fixes the package but not what the package depends on, so a new host's first run still resolves transitive dependencies afresh. A bad publish of a transitive dependency reaches that first run even though the service it installs is locked.

**Context.** The pin (task 2 of the report) and the lockfile (task 4) were each decided for their own path. `service install` hands over to `installRelease`, which is locked, but the process doing that was started by `bunx`.

**Investigation.** On 2026-11-05 `apps/web-public/public/install.sh` still launched through `bunx` or `bun x`. `service install` (`packages/cli/src/client/commands/service.ts`) records only `process.execPath` and installs its own release into the data directory, so a first run from a temporary directory leaves nothing behind that the service needs.

**Outcome.** The recommended option was taken. After it has a Bun, `install.sh` fetches `orkestrator@<spec>` with `--ignore-scripts` into a fresh directory with its own cache, copies the package's `resources/release-runtime/{package.json,bun.lock}` into a second directory, runs `bun install --frozen-lockfile --production --linker=hoisted --ignore-scripts` there with its own cache, moves the package in, and replaces its own process with `bun <release>/node_modules/orkestrator/bin/orkestrator.js "$@"`. A helper removes the directory once that process exits. A runtime without `bun.lock` is refused; a package with no runtime (any release before 2026-11-04, including the current pin) runs through `bun x` as before, recorded in the register in `docs/architecture/version-compatibility.md`. Tests: `tests/unit/install-script-locked-run.test.ts` runs the real script with real `bun install`s against a loopback registry: the locked version wins over a newer one, no lifecycle script runs, arguments and the exit status pass through, SIGTERM to the script's process reaches the CLI, the temporary directory is removed, and an out-of-step or missing lockfile is refused with nothing run.

**Decisions.**

- **How to close it?**
  - **Have `install.sh` do what `installRelease` does: fetch with scripts off, run the frozen install in a temporary directory, then run the package from there (recommended).**
    - Pros: the first run uses the versions the release published; no new trust in Bun's cache.
    - Cons: more shell, a slower first start, and a directory to place and clean up.
  - **Accept it, and rely on the locked service after the first run.**
    - Pros: no change.
    - Cons: the first run is the process that writes the service unit and holds the user's terminal.

## Current state

- `install.sh` pins the release (task 2 of the report), the Bun it downloads (task 3) and, for releases that publish one, the dependency lockfile of its first run (task 4). Users who saved an older copy of the script keep running it unchanged: it still runs `bunx orkestrator@<its pin>`, and a host it set up updates through `installRelease` like any other.
- Task 2 is done on Linux (2026-11-14): a standalone update between two published releases installs from the release's lockfile. Task 1 (the live-site proof after a deploy and a Stable release) and the macOS half of task 2 are in the manual-test checklist (7568).

## Constraints and rationale

A committed lockfile is regenerated by hand, so it holds its versions until someone changes them, and it is resolved separately from the root `bun.lock`: at the time of writing, 15 of its 145 entries are newer than the root's. `mise run smoke:cli` installs and runs exactly this lockfile before each publish, which is what makes those versions tested.

Releases older than the lockfile still install with a plain `bun install`. The path is in the register in `docs/architecture/version-compatibility.md`.

## Assumptions and decisions

### Task 2: run only the container's service phase

- **Chosen:** `--phases service` of `qualify-host-upgrades-container.ts`, which runs the whole of `qualify-standalone-service.ts` (cancel, update, rollback, engines), not the linger and host-tasks phases.
- **Why:** the lockfile is installed and checked in the update phase; linger and the image and `gh` tasks do not touch `installRelease` and passed on 2026-11-13. Skipping host-tasks also avoids pulling the 7 GB release image.
- **Cons:** this run does not re-prove linger or the host tasks on today's `main`.

### Task 2: what counts as "installed from the lockfile"

- **Chosen:** byte-for-byte equality of the release root's `package.json` and `bun.lock` with the package's `resources/release-runtime/` copies, every installed package at its locked version, and no installed package the lockfile does not list. Lockfile entries limited to another platform, and optional ones with no platform limit, may be absent.
- **Why:** this is exactly what `installRelease`'s frozen install leaves, and a fresh resolution leaves a generated manifest and no lockfile. The fresh-resolution comparison in the report shows the check is not passing by coincidence: seven versions would have differed.
- **Cons:** it reads the result rather than watching the `bun install` command line; an install that matched the lockfile by another route would also pass.

### Task 3: verify Bun's archive against stated hashes, not pass a version to Bun's installer

- **Chosen:** download Bun's release archive and check it against SHA-256s stated in the script (the second option), instead of the recommended `bash -s bun-v<version>` to Bun's installer.
- **Why:** the ticket asks for a pinned Bun that is verified. Passing a version still runs bun.com's script unverified and downloads the archive with no hash check. The cost the file gave against the second option, a hash per platform, was mostly paid already: `scripts/download-bun.sh` keeps four of them and the drift test enforces them, so the new test checks the script's copies against those.
- **Pros:** nothing from outside runs before it is checked; a new Bun release does not reach new hosts on its own; one Bun pin across `mise.toml`, the desktop app and the site.
- **Cons:** nine hashes in a shell script; the five for `-baseline` and `-musl` hosts are checked only for their form, so a Bun bump has to copy them from `SHASUMS256.txt` (`docs/development/upgrade-agents.md` says so); the target choice copies Bun's installer and can drift from it.

### Task 3: where `PINNED_BUN` comes from

- **Chosen:** the `mise.toml` pin, enforced by `tests/unit/version-drift.test.ts`, and moved by the Bun bump procedure, not stamped by `release:pin-installer`.
- **Why:** Bun is a repository pin that already moves in its own change with a drift test; stamping it at release time would add a second place it can come from.
- **Cons:** a Bun bump reaches the site when it merges, ahead of the next pinned release; the release still runs because `packages/cli` asks for `bun >=1.4.4`.

### Task 3: the shell profile

- **Chosen:** leave the user's shell profile alone and print the directory to add to `PATH`. Bun's installer edited `.bashrc`, `.zshrc` or fish's configuration.
- **Why:** the script should not rewrite dotfiles; the CLI and the service it installs find Bun by its absolute path, and the script puts that directory first on the CLI's `PATH`.
- **Cons:** after a first install, `bun` and `bunx` are not on the user's `PATH` until they add it.

### Task 4: where the locked release lives, and how it is cleaned up

- **Chosen:** a fresh `mktemp -d` directory under `TMPDIR`, the CLI started with `exec` so it keeps the script's process, signals and terminal, and a small background helper that removes the directory once that process has exited.
- **Why:** `exec` keeps the behaviour the script had with `bunx` (Ctrl-C, SIGTERM to the process, the exit status). Running the CLI as a child to clean up afterwards would need signal forwarding, and a background child of a non-interactive bash ignores SIGINT. `bunx` also leaves its install under `TMPDIR`.
- **Cons:** every run downloads the package and its dependencies twice (the discarded fetch, then the frozen install), as `installRelease` does; a host killed with SIGKILL leaves the directory to the system's temporary-file cleanup.

### Task 4: releases without a lockfile

- **Chosen:** run them through `bun x`, as the script always did, after the fetch shows no `resources/release-runtime/`.
- **Why:** keeps those releases running exactly as before (the ticket requires older installs to keep working) and matches `installRelease`, which installs them afresh. The current pin, 2.36.1, is one of them, so the locked first run starts when the pin moves (5022 task 1, now in 7568).
- **Cons:** until then the fetch is extra work on every first run.

### Task 4: what `ORKESTRATOR_INSTALL_VERSION` may hold

- **Chosen:** an npm tag or a version (letters, digits, `.`, `_`, `+`, `-`, starting with a letter or digit), refused otherwise.
- **Why:** it is written into a JSON manifest; the README documents only tags and versions.
- **Cons:** a range such as `^2.36`, which `bunx` accepted, is now refused.

## Related

- 0033 (retired 2026-11-13): its qualification record is [host-updates.md, Qualification](../../architecture/host-updates.md#qualification)
- [5021](5021-publish-npm-from-ci-with-provenance.md)
- [Releasing the desktop app](../../development/releasing.md)
- [Host updates](../../architecture/host-updates.md)
- Security report, §5 Low severity (`git show 413bd6219:docs/reports/2-26-10-27-security.md`) (L6)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 1, the live-site proof after the deploy and next Stable release, and the macOS half of task 2) moved there on 2026-11-10.

# Release chain: live evidence and what the pin does not cover

Carried from security report batch S5, part `0140` tasks 2 and 4 (finding L6). The code for both is built; what is here could not be proved without a release, or was outside what those tasks decided.

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **Prove the pinned installer on the live site**: the site serves a pin and the pin moves after a Stable release. Status: open.
2. **Prove a published release installs from its lockfile**: a real update on a standalone host, on Linux and macOS. Status: open.
3. **Pin the Bun that `install.sh` downloads**: it still fetches Bun's own installer with `curl | bash`. Status: open.
4. **Lock the first run through `bunx`**: `bunx` resolves transitive dependencies afresh before the service install takes over. Status: open.

### 1. Prove the pinned installer on the live site

**Problem.** Nothing has shown that the site deploys the pin, so a user could still be served the old unpinned script after this work merges.

**Context.** `apps/web-public/public/install.sh` states `PINNED_RELEASE`, and `mise run release:pin-installer` moves it after a Stable release (`docs/development/releasing.md`, step 5). `docs/architecture/version-compatibility.md` says the hosted client follows `main`. The repository has a `vercel.json` and no deploy workflow, so the deploy itself is outside what a change here can observe.

**Investigation.** Running the script from the worktree with a temporary `HOME` and Bun cache printed `orkestrator 2.36.1`, the pinned version, from the real registry. Nothing was deployed.

**Decisions.**

- **How to check it?**
  - **After this merges, and again after the next Stable release, run the check in the release steps and one real install in a disposable VM (recommended).**
    - Pros: covers the deploy and the pin moving; the same command the docs give.
    - Cons: waits for the next Stable release.
  - **Fetch the script and compare it with `main` in CI.**
    - Pros: catches a stale deploy on every run.
    - Cons: a scheduled check against production for a file that changes a few times a month; fails between a merge and the deploy.

### 2. Prove a published release installs from its lockfile

**Problem.** The updater path has only run against a loopback registry and a packed tarball. A release cannot show it until one carries `resources/release-runtime/`.

**Context.** `installRelease` (`packages/protocol/src/node/standalone-service.ts`) fetches the package with scripts off, then runs `bun install --frozen-lockfile` on the manifest and lockfile the package publishes. The code doing the install belongs to the release already on the host, so the first update that takes this path is the second release after this work: a host must already run a release with the new `installRelease`, and the target must carry the lockfile.

**Investigation.** Done on Linux x64 against Bun 1.4.4:
- `packages/protocol/src/node/standalone-service-install.test.ts`: real installs from a loopback registry. The lockfile's version wins over a newer one, and a mismatched manifest, a wrong hash and a missing lockfile are all refused with no release left behind.
- `installRelease` on the packed `orkestrator` tarball, with other packages proxied from npm: installed in about 4 s, and `bin/orkestrator.js --version` reported the version.
- `bun install --frozen-lockfile --os … --cpu …` accepted the lockfile for linux x64, linux arm64, darwin arm64 and darwin x64, and chose each platform's `@img/sharp-*` and Agent SDK packages. Only linux x64 ran the result.

**Decisions.**

- **How to qualify it?**
  - **Add it to the standalone service run in [0033](0033-remote-host-upgrades.md): update between two real releases on Linux and macOS, and check the release's `bun.lock` matches and `sharp` loads (recommended).**
    - Pros: one run covers rollback and the lockfile together; it runs on real hosts.
    - Cons: needs two releases that carry the change.
  - **Rely on `mise run smoke:cli`, which installs the lockfile before each publish.**
    - Pros: no extra run.
    - Cons: runs only on the publishing machine and skips the updater.

### 3. Pin the Bun that `install.sh` downloads

**Problem.** When Bun is missing, the script runs `curl -fsSL https://bun.com/install | bash`, so the Bun a new host gets is whatever that script picks.

**Context.** The report named this as context for task 2, with no decision. Everything later runs under that Bun, including the update path above. `mise.toml` pins the Bun the project builds with, and `packages/cli/package.json` asks for `>=1.4.4`.

**Investigation.** `apps/web-public/public/install.sh` still has the line. Its behaviour with an argument was not run here.

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

**Investigation.** `apps/web-public/public/install.sh` launches through `bunx` or `bun x`. Neither takes a lockfile from the package. No fix was tried.

**Decisions.**

- **How to close it?**
  - **Have `install.sh` do what `installRelease` does: fetch with scripts off, run the frozen install in a temporary directory, then run the package from there (recommended).**
    - Pros: the first run uses the versions the release published; no new trust in Bun's cache.
    - Cons: more shell, a slower first start, and a directory to place and clean up.
  - **Accept it, and rely on the locked service after the first run.**
    - Pros: no change.
    - Cons: the first run is the process that writes the service unit and holds the user's terminal.

## Constraints and rationale

A committed lockfile is regenerated by hand, so it holds its versions until someone changes them, and it is resolved separately from the root `bun.lock`: at the time of writing, 15 of its 145 entries are newer than the root's. `mise run smoke:cli` installs and runs exactly this lockfile before each publish, which is what makes those versions tested.

Releases older than the lockfile still install with a plain `bun install`. The path is in the register in `docs/architecture/version-compatibility.md`.

## Related

- [0033](0033-remote-host-upgrades.md)
- [5021](5021-publish-npm-from-ci-with-provenance.md)
- [Releasing the desktop app](../../development/releasing.md)
- [Host updates](../../architecture/host-updates.md)
- [Security report, §5 Low severity](../../reports/2-26-10-27-security.md#5-low-severity) (L6)

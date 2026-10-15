# Releasing the desktop app

Orkestrator ships on three channels: **stable** (`vX.Y.Z`), **beta**
(`vX.Y.Z-beta.N`) and **unstable** (`vX.Y.Z-unstable.<yyyymmdd>.<run>.g<sha>`).
Stable and beta are built on maintainer machines: the macOS build on a Mac and
the Linux build on a Linux (Arch/Omarchy) machine. Unstable is built nightly
from `main` by CI (`.github/workflows/release-unstable.yml`). Every release
uploads to one GitHub release on `orkestrator-ai/orkestrator-v2`, which serves
the website download links and the in-app updater. The channel model, feeds
and requirements manifest are described in
[release-channels-and-updates.md](../architecture/release-channels-and-updates.md).

## Cutting a stable or beta release

1. Bump the version in every manifest listed in `AGENTS.md` (`2.21.0`, or
   `2.21.0-beta.1` for a beta), regenerate the lockfiles, and merge the change
   through a pull request. A version on no channel (`-rc.1`, `-alpha.1`, build
   metadata) is refused by every release command.
2. On `main`, tag the merge commit `v<version>` (it must equal `package.json`'s
   version) and push the tag: `git tag v2.21.0 && git push origin v2.21.0`.
   The tag also publishes the container image with that channel's tags.
3. **On the Mac** (Apple Silicon), at the tagged commit:

   ```bash
   mise run release:desktop
   ```

4. **On the Linux machine**, at the same tagged commit:

   ```bash
   mise run release:desktop
   ```

5. Publish the npm package on the channel's dist-tag (`latest`, `beta`):

   ```bash
   mise run publish:cli
   ```

6. From either build machine, still at the tagged commit, once all of that
   has finished:

   ```bash
   mise run release:publish
   ```

Each `release:desktop` run refuses to continue unless the working tree is clean
and `HEAD` is the pushed `v<version>` tag. It installs dependencies, builds,
generates the release requirements manifest (`build/release-requirements.json`,
also embedded in the app), and uploads everything to a **draft** release, so
nothing is visible until `release:publish`. Publication refuses unless:

- macOS and Linux artifacts and their updater feeds are present (Linux uses
  `latest-linux.yml` for x64 or `latest-linux-arm64.yml` for arm64);
- the uploaded macOS feeds carry the Darwin 22 floor (macOS builds replace every
  generated macOS feed in the draft with it);
- the uploaded `release-requirements.json` is byte-identical to the one this
  tagged checkout generates (and, once signing keys are embedded, carries a
  valid `release-requirements.json.sig`);
- `orkestrator@<version>` is on npm, so the channel index never points a
  headless backend at a version it cannot install.

It then publishes stable releases as **latest** and beta and unstable ones as
prereleases (never latest), and rebuilds the channel index (`channels.json` on
the `update-channels` release) with `scripts/release-channel-index.ts`. Clients
from before channels follow `/releases/latest` and so only ever see stable.
`mise run release:channels` rebuilds the index on its own; it is derived from
the published releases, so running it again is always safe.

## Headless backends

A headless backend updates itself only when it runs supervised:
`orkestrator serve --supervised`, or the unit `orkestrator service install`
writes. The supervisor installs `orkestrator@<version>` from npm into
`<data-dir>/runtime/versions/`, checks the package carries the approved
requirements manifest, and cuts over with a health check and rollback. A plain
`orkestrator serve` reports that it has no installer and is updated by hand
(`bunx orkestrator@<dist-tag> serve`). See
[release-channels-and-updates.md](../architecture/release-channels-and-updates.md#headless-supervisor).

## Unstable builds

`release-unstable.yml` runs nightly at 03:17 UTC and on `workflow_dispatch`.
It skips a `main` commit that already has an unstable release unless
dispatched with **force**. For a new build it:

1. computes the version (`scripts/release-channel.ts unstable-version`): the
   next patch after `main`'s stable version, or `main`'s own core when `main`
   is a prerelease, plus the date, the run number and the short commit;
2. writes it into every manifest, regenerates the lockfiles, commits that on
   top of `main` **without** touching `main`, pushes only the tag, and opens
   the draft release every build job uploads to;
3. builds macOS arm64 (signed and notarized from secrets) and Linux x64 and
   arm64 with `release:desktop` (only the macOS build uploads the
   requirements manifest), and calls `publish-container.yml` for the version
   and `sha-` image tags only;
4. publishes npm on the `unstable` dist-tag, runs `release:publish`, moves the
   GHCR `unstable` tag once the release is public, and prunes all but the
   newest ten unstable releases;
5. deletes the draft and tag again if any step before publication failed.

## One-time setup

1. Create the channel index release. It must stay a prerelease so it can never
   become `/releases/latest`:

   ```bash
   gh release create update-channels --repo orkestrator-ai/orkestrator-v2 --prerelease \
     --title "Update channels" --notes "Channel index for in-app updates. Do not delete."
   ```

2. Add these repository secrets (Settings › Secrets and variables › Actions):

   | Secret | Value |
   | --- | --- |
   | `MAC_CERTIFICATE_P12_BASE64` | Base64 of the Developer ID Application certificate exported as `.p12` |
   | `MAC_CERTIFICATE_PASSWORD` | That export's password |
   | `APPLE_API_KEY_P8` | Contents of the App Store Connect API key (`AuthKey_XXXX.p8`) used for notarization |
   | `APPLE_API_KEY_ID` | The key's id |
   | `APPLE_API_ISSUER` | The issuer id |
   | `NPM_TOKEN` | A granular npm token that can publish `orkestrator` |
   | `ORKESTRATOR_RELEASE_SIGNING_KEY` | The **active** manifest signing key (see [Manifest signing keys](#manifest-signing-keys)). Required: every release must be signed |

3. If a tag ruleset protects `v*`, let GitHub Actions create and delete
   `v*-unstable.*` tags.
4. Enable the **Release unstable** workflow (scheduled workflows in a fork or a
   repository without recent activity start disabled).

### Manifest signing keys

Releases sign `release-requirements.json` with Ed25519. It pins every provider
binary an update installs, so the signature is what stops someone with write
access to GitHub releases from swapping them. Two keys exist:

- the **active** key signs every release. It is the
  `ORKESTRATOR_RELEASE_SIGNING_KEY` Actions secret, and a maintainer keeps a
  copy in the team password manager for local stable and beta releases;
- the **standby** key signs nothing. It is kept offline only (the password
  manager, plus an encrypted backup), never in CI.

Signing is on: both keys were generated on 2026-10-16, and their public keys
are listed in `packages/protocol/src/release-signing-keys.ts`, active first.
Before the first release that contains them, the active key must be the
`ORKESTRATOR_RELEASE_SIGNING_KEY` secret.

How the keys were made, and how to make replacements:

1. Generate the keys on a maintainer machine. Each command writes an owner-only
   PEM (it refuses to overwrite one) and prints the public key:

   ```bash
   bun scripts/release-requirements.ts keygen --out ~/orkestrator-release-active.pem
   bun scripts/release-requirements.ts keygen --out ~/orkestrator-release-standby.pem
   ```

2. Store the active PEM as the `ORKESTRATOR_RELEASE_SIGNING_KEY` secret and in
   the password manager; store the standby PEM in the password manager and the
   offline backup. Then delete both files.
3. List both printed public keys, active first, in
   `packages/protocol/src/release-signing-keys.ts`, and merge that change.

From the first release that embeds the keys, every later release must be signed:
installs reject a manifest without a valid signature from a listed key.
The macOS `release:desktop` build, which uploads the shared manifest and its
signature, refuses to start publishing without `ORKESTRATOR_RELEASE_SIGNING_KEY`
and checks that the key is one the build lists before it packages anything.
Linux builds never need the private key.

Rotating, or replacing a leaked or lost active key:

1. Make the standby key the active one: set it as the secret and give the
   maintainers its PEM.
2. Generate a new standby with `keygen`, and replace the old active public key
   in `release-signing-keys.ts` with the new standby's.
3. Release. Installs that only know the old pair accept that release, because
   the standby key signed it, and learn the new pair from it.

If the active key **leaked**, do this before anything else: until installs
take the release that drops it, whoever holds it can sign manifests they
accept. If **both** keys are lost, installs can no longer verify any update
and must be updated by hand, which is why the standby lives offline.

To rehearse a build without uploading or needing the tag, run
`mise run release:desktop -- --no-publish`. Artifacts land in `release/`.
The local signed `package:release` task also sets `--publish never`, including
when a GitHub token is available.

## Machine prerequisites

| Machine | Needs |
| --- | --- |
| Mac | Apple Silicon; a Developer ID Application certificate in the login keychain; notarization credentials in the environment (`APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`, `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE`); `ORKESTRATOR_RELEASE_SIGNING_KEY` (the active signing key). |
| Linux | `mise`, `git`, and `bsdtar` (`sudo pacman -S libarchive`). |
| Both | `gh auth login` (or `GH_TOKEN`) with write access to the repository; `curl` (the npm check). |
| Whoever runs `publish:cli` | An npm login (or `NPM_CONFIG_TOKEN`) that can publish `orkestrator`. |

macOS auto-update only works for builds signed with a Developer ID, which is why
the base config's ad-hoc signing (`mise run package:mac`) is local-only.

## Artifacts

| Platform | Download | Updater feed | Self-updates |
| --- | --- | --- | --- |
| macOS arm64 | `orkestrator-v2-mac-arm64.dmg` (and a `.zip` the updater uses) | `latest-mac.yml` | Yes |
| Linux x64 | `orkestrator-v2-linux-x86_64.AppImage` | `latest-linux.yml` | Yes |
| Linux arm64 | `orkestrator-v2-linux-arm64.AppImage` | `latest-linux-arm64.yml` | Yes |
| Arch / Omarchy | `orkestrator-v2-linux-x64.pacman` | | No: reinstall to update |

Filenames carry no version so the website can link a stable URL, for example
`https://github.com/orkestrator-ai/orkestrator-v2/releases/latest/download/orkestrator-v2-mac-arm64.dmg`.
electron-builder names the x64 AppImage `x86_64` and the pacman package `x64`.
On arm64 it names the AppImage `arm64` and the pacman package `aarch64`.
The Linux release config provides pacman's maintainer and project homepage
metadata without changing the local packaging configuration.

## How the in-app updater decides to run

The backend owns the update workflow (`apps/backend/src/core/updates/`): it
reads the channel index, verifies the target's requirements manifest, shows
what the update needs, and runs the job. Electron main installs on its behalf
(`apps/desktop/electron/update-host.ts`): it pins electron-updater to the one
release the backend resolved, downloads and verifies it, and restarts into it.
See [release-channels-and-updates.md](../architecture/release-channels-and-updates.md).

The desktop app can install updates only when all of these hold
(`autoUpdateUnavailableReason` in `apps/desktop/electron/auto-update.ts`): the
app is packaged, the runtime flavor is `production`, `app-update.yml` exists in
the app's resources, and (on Linux) the app runs as an AppImage.
`app-update.yml` is only embedded by the release configs, so local `package:*`
installs never update themselves. Set `ORKESTRATOR_DISABLE_AUTO_UPDATE=1` to
turn checks and installs off.

The backend checks 30 seconds after launch and every 6 hours. When a newer
release is on the installation's channel (Settings › Updates), a toast and a
title-bar **Update** button open the update dialog, which lists what the
release needs. Nothing is downloaded before the user approves: **Update and
restart** fetches the pinned provider binaries and the app, verifies them, and
restarts; **Download now, restart later** stops at **Restart now** / **Install
when I quit**. **Orkestrator AI → Check for Updates…** runs a check and opens
the dialog.

## Minimum macOS version

Electron 44 dropped macOS 12 (Monterey), so the app requires macOS 13
(Ventura) or later. `build.mac.minimumSystemVersion` (`13.0`) writes
`LSMinimumSystemVersion` into the app's `Info.plist`, so macOS refuses to open
it on Monterey with its standard "can't use this version" message instead of
the app crashing at launch. Raise it when an Electron upgrade raises the floor.

electron-builder 26 does not copy this floor into `latest-mac.yml`.
`scripts/mac-update-feed.ts` adds `minimumSystemVersion: '22.0.0'` (the Darwin
kernel version for macOS 13) to all generated macOS channel feeds after the
draft build. `release:desktop` uploads these replacements, and `release:publish`
validates the actual uploaded feeds before publication, refusing an ungated
draft left by an old or interrupted build. Existing Electron 42 clients on
Darwin 21 therefore skip the update and keep their working app; Darwin 22 may
accept it. Update both the plist floor and feed floor when support changes.

## Linux and Omarchy

- The AppImage is built with electron-builder's static AppImage runtime
  (`toolsets.appimage` in `package.json`, currently a beta toolset), so it does
  not need `libfuse2`, which a stock Arch install lacks.
- Electron 38+ runs natively on Wayland (Hyprland) by default.
- Building on the Omarchy machine also proves the build there; launch the
  AppImage and the installed pacman package before publishing.
- Docker must be installed on the host: Orkestrator uses it for container
  environments.
- Without a Secret Service keyring (gnome-keyring or KWallet), Electron's
  `safeStorage` falls back to `basic_text`; the connection manager already
  handles that case.

## Not yet covered

- macOS Intel (x64): both Mac builds would write `latest-mac.yml` and overwrite
  each other. Add it by building both architectures in one run.
- Linux arm64 packaging has been validated with a no-publish build producing
  both targets; launching those packages and applying a real update remain
  unverified. Windows releases are not yet covered.
- A real update has not been exercised end to end. Before announcing, ship a
  release, install it from the download, ship the next version, and confirm the
  prompt and restart on both platforms. Prereleases do not count for clients
  older than the channel-aware updater: they follow stable only.
- The unstable workflow has not run yet: the CI macOS signing and notarization
  path, the Linux arm64 `fpm` setup and the tag push from Actions are
  unqualified until its first green run.
- Updates themselves (consent, desktop install and rollback, the headless
  supervisor, remote updates) are tested only with fakes. The real-run
  checklist is
  [release-channels-qualification.md](../todo/release-channels-qualification.md).
